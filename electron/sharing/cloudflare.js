'use strict';
const https = require('node:https');
const crypto = require('node:crypto');
function hostname(value) {
  const name = String(value || '').trim().toLowerCase();
  if (name.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(name)) throw Error('Enter a hostname on your Cloudflare domain, such as play.example.com.');
  return name;
}
function api(token, method, endpoint, input) {
  return new Promise((resolve, reject) => {
    const body = input === undefined ? null : JSON.stringify(input);
    const request = https.request('https://api.cloudflare.com/client/v4' + endpoint, { method, timeout: 20000,
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', ...(body ? { 'content-length': Buffer.byteLength(body) } : {}) } }, response => {
      let text = '', bytes = 0;
      response.on('data', chunk => { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) request.destroy(); else text += chunk; });
      response.on('error', () => reject(Error('Cloudflare disconnected. Try again.')));
      response.on('end', () => {
        let result; try { result = JSON.parse(text); } catch { return reject(Error('Cloudflare returned an invalid response.')); }
        if (response.statusCode >= 400 || !result.success) return reject(Error(response.statusCode === 401 || response.statusCode === 403
          ? 'Cloudflare rejected the API token. Check its selected account and Zone Read, DNS Edit and Cloudflare Tunnel Edit permissions.'
          : 'Cloudflare could not complete setup. Check your token permissions and hostname, then try again.'));
        resolve(result.result);
      });
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => reject(Error('Could not reach Cloudflare. Check your internet connection.')));
    request.end(body);
  });
}
async function provision({ apiToken, publicHostname }, { call = api } = {}) {
  const name = hostname(publicHostname);
  if (typeof apiToken !== 'string' || !/^[A-Za-z0-9_-]{20,512}$/.test(apiToken)) throw Error('Enter a scoped Cloudflare API token. A tunnel run token is a different credential.');
  let zone;
  for (let part = name; part.includes('.'); part = part.slice(part.indexOf('.') + 1)) {
    const zones = await call(apiToken, 'GET', '/zones?name=' + encodeURIComponent(part) + '&status=active');
    zone = zones.find(item => item.name === part);
    if (zone) break;
  }
  if (!zone || !/^[a-f0-9]{32}$/.test(zone.id) || !/^[a-f0-9]{32}$/.test(zone.account?.id || '')) throw Error('This token cannot see an active Cloudflare zone for that hostname. Include Zone Read for the domain.');
  const records = await call(apiToken, 'GET', `/zones/${zone.id}/dns_records?name=${encodeURIComponent(name)}`);
  if (records.length) throw Error('That hostname already has a DNS record. Choose an unused hostname; setup will not replace an existing site.');
  const secret = crypto.randomBytes(32).toString('base64');
  const tunnel = await call(apiToken, 'POST', `/accounts/${zone.account.id}/cfd_tunnel`, {
    name: 'Ragnarok Offline ' + crypto.randomBytes(6).toString('hex'), tunnel_secret: secret, config_src: 'local',
  });
  if (!/^[a-f0-9-]{36}$/.test(tunnel.id || '')) throw Error('Cloudflare returned an invalid tunnel identity.');
  try {
    const record = await call(apiToken, 'POST', `/zones/${zone.id}/dns_records`, { type: 'CNAME', name, content: tunnel.id + '.cfargotunnel.com', proxied: true, ttl: 1 });
    return { hostname: name, tunnelId: tunnel.id, accountId: zone.account.id, zoneId: zone.id, dnsRecordId: record.id, secret };
  } catch (error) {
    try { await call(apiToken, 'DELETE', `/accounts/${zone.account.id}/cfd_tunnel/${tunnel.id}`); }
    catch { throw Error('DNS setup failed and the new tunnel could not be removed. Remove the unused Ragnarok Offline tunnel in Cloudflare before retrying.'); }
    throw error;
  }
}
// All routes are local configuration; a dashboard-managed tunnel cannot
// redirect this connector to an unprotected service on the computer.
function configuration(saved, port = 3339) {
  const name = hostname(saved.hostname);
  if (!/^[a-f0-9-]{36}$/.test(saved.tunnelId || '') || !/^[a-f0-9]{32}$/.test(saved.accountId || '') || !/^[A-Za-z0-9+/]{43}=$/.test(saved.secret || '')) throw Error('Saved Cloudflare setup is invalid.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid sharing port');
  return { config: JSON.stringify({ tunnel: saved.tunnelId, ingress: [{ hostname: name, service: 'http://127.0.0.1:' + port }, { service: 'http_status:404' }] }),
    credentials: JSON.stringify({ AccountTag: saved.accountId, TunnelSecret: saved.secret, TunnelID: saved.tunnelId }) };
}
module.exports = { api, provision, configuration, hostname };
