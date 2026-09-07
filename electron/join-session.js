'use strict';
const { parseJoinAddress, gameUrl } = require('./join-address');

// Invite handoff lasts only for this app session. Persist the normalized host
// origin, not a bearer token; after exchange the host's secure cookie is what
// survives an ordinary app restart. Never expose this object through IPC.
class JoinSession {
  constructor() { this.pending = new Map(); this.redactions = new Set(); }
  remember(value) {
    const { origin, invite } = parseJoinAddress(value);
    if (invite) {
      this.pending.set(origin, invite);
      this.redactions.add(invite);
      const params = new URLSearchParams(invite.slice(1));
      for (const token of params.values()) if (token) this.redactions.add(token);
    }
    return origin;
  }
  url(value) {
    const { origin } = parseJoinAddress(value);
    return gameUrl(origin, this.pending.get(origin) || '');
  }
  retarget(from, to) {
    if (from === to) return;
    if (this.pending.has(from)) {
      this.pending.set(to, this.pending.get(from));
      this.pending.delete(from);
    }
  }
  exchanged(value) {
    let url;
    try { url = new URL(value); } catch { return; }
    if (!url.hash) this.pending.delete(url.origin);
  }
  redact(value) {
    let safe = String(value || '');
    for (const token of [...this.redactions].sort((a, b) => b.length - a.length))
      safe = safe.split(token).join('[redacted invite]');
    // URL-bearing diagnostics can arrive before a token has been parsed.
    return safe.replace(/(https?:\/\/[^\s#]+)#[^\s]*/gi, '$1#[redacted]');
  }
}
module.exports = { JoinSession };
