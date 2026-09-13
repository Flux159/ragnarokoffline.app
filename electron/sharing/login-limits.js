'use strict';
const crypto = require('node:crypto');
// The shipped client sends CA_LOGIN (55 bytes), optional EXE_HASHCHECK and
// CONNECT_INFO_CHANGED. No passwords are logged or indexed.
// Parse the RO byte stream, independently of WS/TCP fragmentation or batching.
class LoginPackets {
  constructor(allow) { this.allow = allow; this.pending = Buffer.alloc(0); }
  consume(bytes) {
    this.pending = Buffer.concat([this.pending, bytes]);
    while (this.pending.length >= 2) {
      const id = this.pending.readUInt16LE();
      const size = { 0x64: 55, 0x204: 18, 0x200: 26 }[id];
      if (!size) throw Error('Unsupported login packet');
      if (this.pending.length < size) return;
      if (id === 0x64) {
        const name = this.pending.subarray(6, 30).toString('latin1').split('\0')[0].trimEnd().toLowerCase();
        if (!/^[\x20-\x7e]{1,23}$/.test(name) || !this.allow(name)) throw Error('Login attempt limit');
      }
      this.pending = Buffer.from(this.pending.subarray(size));
    }
  }
}
class LoginLimits {
  constructor(now = Date.now) { this.now = now; this.accounts = new Map(); }
  allow(entry, name) {
    const since = this.now() - 60000;
    for (const [key, times] of this.accounts) {
      const current = times.filter(time => time > since);
      if (current.length) this.accounts.set(key, current); else this.accounts.delete(key);
    }
    entry.logins = (entry.logins || []).filter(time => time > since);
    const key = crypto.createHash('sha256').update(name).digest('hex');
    const attempts = this.accounts.get(key) || [];
    if (entry.logins.length >= 5 || attempts.length >= 5 || (!this.accounts.has(key) && this.accounts.size >= 256)) return false;
    const now = this.now(); entry.logins.push(now); attempts.push(now); this.accounts.set(key, attempts);
    return true;
  }
}
module.exports = { LoginPackets, LoginLimits };
