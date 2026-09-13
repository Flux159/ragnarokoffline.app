'use strict';

const GAME_PATH = '/api.html?app=ONLINE';
const INVALID = 'Enter an HTTP or HTTPS host link, or a LAN address. Usernames and passwords are not allowed in the address.';

// A browser URL has normal 80/443 semantics. Only legacy bare LAN addresses
// acquire :3338. Keep the invite out of the origin used for probes, saved host
// preferences, window titles and diagnostics.
function parseJoinAddress(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 4096 || /[\u0000-\u0020\u007f\\]/.test(raw)) throw Error(INVALID);
  const explicit = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  if (!explicit && /^[a-z][a-z0-9+.-]*:/i.test(raw)
      && !/^[^:/?#]+:\d+(?:[/?#]|$)/.test(raw)) throw Error(INVALID);
  let url;
  try { url = new URL(explicit ? raw : 'http://' + raw); } catch { throw Error(INVALID); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw Error(INVALID);
  if (!explicit) {
    // WHATWG URL canonicalizes :80 to an empty port, so check the original
    // authority to distinguish an explicit default port from an absent port.
    const authority = raw.split(/[/?#]/, 1)[0];
    if (!/:(\d+)$/.test(authority)) url.port = '3338';
  }
  return { origin: url.origin, invite: url.hash };
}

function gameUrl(address, invite = '') {
  const parsed = parseJoinAddress(address);
  return parsed.origin + GAME_PATH + (invite || parsed.invite);
}

module.exports = { parseJoinAddress, gameUrl, GAME_PATH };
