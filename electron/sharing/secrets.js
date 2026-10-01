'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
class SharingSecrets {
  constructor(directory, safeStorage) { this.directory = directory; this.safeStorage = safeStorage; this.file = path.join(directory, 'cloudflare.enc');
    this.inviteFile = path.join(directory, 'invite.enc'); this.signInFile = path.join(directory, 'sign-in.enc'); }
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
  // The invitation token, kept apart from the Cloudflare credential so that
  // forgetting the domain does not silently rotate everyone's link, and
  // rotating the link does not disturb the tunnel.
  loadInvite() {
    if (!fs.existsSync(this.inviteFile)) return null;
    this.requireStorage();
    try { return String(JSON.parse(this.safeStorage.decryptString(fs.readFileSync(this.inviteFile))).invite || '') || null; }
    catch { return null; }
  }
  saveInvite(invite) {
    this.requireStorage(); fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const bytes = this.safeStorage.encryptString(JSON.stringify({ invite }));
    const temporary = this.inviteFile + '.' + crypto.randomBytes(6).toString('hex') + '.new';
    fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' });
    try { fs.renameSync(temporary, this.inviteFile); } finally { fs.rmSync(temporary, { force: true }); }
  }
  forgetInvite() { fs.rmSync(this.inviteFile, { force: true }); }
  // Google/Apple sign-in client credentials (oidc.js): the Google client
  // secret and the Apple .p8 key are secrets, so the whole set is kept like
  // the Cloudflare credential -- encrypted by the operating system's password
  // store, in the sharing directory, never in state/assets and never sent to
  // a player's browser. { google: {clientId, clientSecret}, apple: {...} }.
  loadSignIn() {
    if (!fs.existsSync(this.signInFile)) return {};
    this.requireStorage();
    try { return JSON.parse(this.safeStorage.decryptString(fs.readFileSync(this.signInFile))) || {}; }
    catch { throw Error('The saved sign-in credentials could not be unlocked. Restore access to your operating system’s password store.'); }
  }
  saveSignIn(value) {
    this.requireStorage(); fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (!Object.keys(value).length) return fs.rmSync(this.signInFile, { force: true });
    const bytes = this.safeStorage.encryptString(JSON.stringify(value));
    const temporary = this.signInFile + '.' + crypto.randomBytes(6).toString('hex') + '.new';
    fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' });
    try { fs.renameSync(temporary, this.signInFile); } finally { fs.rmSync(temporary, { force: true }); }
  }
}
module.exports = { SharingSecrets };
