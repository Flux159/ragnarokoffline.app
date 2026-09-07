'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
class SharingSecrets {
  constructor(directory, safeStorage) { this.directory = directory; this.safeStorage = safeStorage; this.file = path.join(directory, 'cloudflare.enc'); }
  available() {
    return this.safeStorage.isEncryptionAvailable() && this.safeStorage.getSelectedStorageBackend?.() !== 'basic_text';
  }
  requireStorage() { if (!this.available()) throw Error('Enable your operating system’s secure password storage before connecting Cloudflare.'); }
  save(value) {
    this.requireStorage(); fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const bytes = this.safeStorage.encryptString(JSON.stringify(value));
    const temporary = this.file + '.' + crypto.randomBytes(6).toString('hex') + '.new'; fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' });
    try { fs.renameSync(temporary, this.file); } finally { fs.rmSync(temporary, { force: true }); }
  }
  load() {
    if (!fs.existsSync(this.file)) return null;
    this.requireStorage();
    try { return JSON.parse(this.safeStorage.decryptString(fs.readFileSync(this.file))); }
    catch { throw Error('The saved Cloudflare credential could not be unlocked. Restore access to your operating system’s password store.'); }
  }
  forget() { fs.rmSync(this.file, { force: true }); }
}
module.exports = { SharingSecrets };
