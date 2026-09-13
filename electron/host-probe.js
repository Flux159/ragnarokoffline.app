'use strict';
const http = require('node:http');
const https = require('node:https');
const { parseJoinAddress } = require('./join-address');

function failure(origin, reason) {
  const error = new Error(`Could not connect to ${origin}: ${reason}`);
  error.reason = reason;
  return error;
}
function networkReason(error) {
  switch (error.code) {
    case 'ECONNREFUSED': return 'nothing is listening there. Ask the host to start sharing and check the link.';
    case 'ENOTFOUND': case 'EAI_AGAIN': return 'the host name could not be found. Check the address.';
    case 'EHOSTUNREACH': case 'ENETUNREACH': return 'the host cannot be reached from this network.';
    case 'ECONNRESET': return 'the connection closed before the host answered.';
    case 'CERT_HAS_EXPIRED': case 'CERT_NOT_YET_VALID': case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN': case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY': case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return 'the HTTPS certificate could not be verified. The host must fix its certificate; the app will not bypass verification.';
    default: return 'the connection failed. Check the link and that the host is online.';
  }
}

// Reachability only, not permission to publish a host. An invite-required
// response is a reachable host: the game window completes that authentication.
// One deadline covers DNS, TLS and bounded redirects. Never send fragments,
// cookies or authorization headers, and never downgrade an HTTPS request.
function probeHost(address, { timeoutMs = 8000 } = {}) {
  const { origin } = parseJoinAddress(address);
  return new Promise((resolve, reject) => {
    let request, settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (request) request.destroy();
      error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(() => finish(failure(origin, 'the host did not answer in time. Check the link and try again.')), timeoutMs);
    function get(url, redirects) {
      const transport = url.protocol === 'https:' ? https : http;
      const current = transport.get(url, { maxHeaderSize: 16 * 1024, agent: false, rejectUnauthorized: true }, response => {
        const status = response.statusCode;
        response.destroy();
        if ([301, 302, 303, 307, 308].includes(status)) {
          if (redirects >= 3) return finish(failure(origin, 'the host redirected too many times.'));
          let next;
          try {
            const location = response.headers.location;
            if (!location || location.length > 4096) throw Error();
            next = new URL(location, url);
            if (!['http:', 'https:'].includes(next.protocol) || next.username || next.password
                || (url.protocol === 'https:' && next.protocol !== 'https:')) throw Error();
            // Cross-origin redirects can inherit an invite fragment when the
            // browser later follows them. Keep this game's entry on its host.
            if (next.hostname !== url.hostname || (next.origin !== url.origin
                && !(url.protocol === 'http:' && next.protocol === 'https:'))) throw Error();
            next.hash = '';
          } catch { return finish(failure(origin, 'the host returned an unsafe or invalid redirect. Use its final HTTPS host link.')); }
          return get(next, redirects + 1);
        }
        if ((status >= 200 && status < 300) || status === 401 || status === 403)
          return finish(null, { origin: url.origin, status, authenticationRequired: status === 401 || status === 403 });
        finish(failure(origin, `the host answered with HTTP ${status}. Ask the host to check its server.`));
      });
      request = current;
      current.on('error', error => {
        if (request === current) finish(failure(origin, networkReason(error)));
      });
    }
    get(new URL(origin + '/'), 0);
  });
}

module.exports = { probeHost };
