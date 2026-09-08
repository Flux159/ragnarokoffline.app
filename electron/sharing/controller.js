'use strict';
const { spawn } = require('node:child_process');
const https = require('node:https');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const dns = require('node:dns').promises;
const { FriendGateway } = require('./gateway');
const { configuration } = require('./cloudflare');
const { ensureHelper } = require('./helper');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
// New temporary hostnames can be announced before DNS is published. macOS's
// getaddrinfo and home-router caches can retain that initial NXDOMAIN for
// minutes. Resolve Cloudflare's temporary names through its public DNS; named
// domains keep the configured resolver. Preserve hostname/SNI and normal
// certificate verification (never connect with an unverified IP URL).
function publicLookup(hostname, options, callback, resolver) {
  if (!resolver) {
    // A resolver created during Electron startup can keep returning a
    // negative result after a fresh channel sees the published name.
    resolver = new dns.Resolver({ timeout: 2000, tries: 1 });
    if (/^[a-z0-9-]+\.trycloudflare\.com$/.test(hostname)) resolver.setServers(['1.1.1.1', '1.0.0.1']);
  }
  Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]).then(results => {
    const addresses = results.flatMap((result, index) => result.status === 'fulfilled'
      ? result.value.map(address => ({ address, family: index === 0 ? 4 : 6 })) : [])
      .filter(entry => !options.family || options.family === entry.family);
    if (!addresses.length) return callback(Error('The public hostname is not in DNS yet'));
    if (options.all) callback(null, addresses); else callback(null, addresses[0].address, addresses[0].family);
  }, callback);
}
function publicHealth(origin) {
  return new Promise((resolve, reject) => {
    const request = https.get(origin + '/_friend/health', { timeout: 8000, agent: false, lookup: publicLookup }, response => {
      let body = '', size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > 4096) request.destroy(); else body += chunk; });
      response.on('end', () => {
        try { if (response.statusCode !== 200) throw Error(); resolve(JSON.parse(body)); } catch { reject(Error('Public link returned HTTP ' + response.statusCode)); }
      }); response.on('error', reject);
    }); request.on('timeout', () => request.destroy()); request.on('error', reject);
  });
}
function publicSocket(origin, cookie) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    const request = https.request(origin + '/ws/127.0.0.1:6900', { timeout: 10000, agent: false, lookup: publicLookup,
      headers: { origin, cookie, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': key, 'sec-websocket-version': '13' } });
    const failure = () => reject(Error('The public page connected, but game connections did not. Check Cloudflare’s WebSocket setting and try again.'));
    request.on('upgrade', (response, socket) => { socket.destroy(); response.headers['sec-websocket-accept'] === accept ? resolve() : failure(); });
    request.on('response', response => { response.destroy(); failure(); });
    request.on('error', failure); request.on('timeout', () => request.destroy()); request.end();
  });
}
function quickHostname(child) {
  return new Promise((resolve, reject) => {
    let output = '', settled = false;
    const finish = (error, origin) => {
      if (settled) return; settled = true; clearTimeout(timer);
      child.removeListener('error', failed); child.removeListener('exit', failed); child.removeListener('close', failed);
      child.stderr.removeListener('data', read); child.stderr.resume();
      error ? reject(error) : resolve(origin);
    };
    const failed = () => finish(Error('Cloudflare could not create a temporary link. Try sharing again.'));
    const read = bytes => {
      output = (output + bytes.toString()).slice(-65536);
      const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match) finish(null, match[0]);
    };
    const timer = setTimeout(failed, 60000);
    child.once('error', failed); child.once('exit', failed); child.once('close', failed); child.stderr.on('data', read);
  });
}
class SharingController {
  constructor({ directory, register, guard, onChange = () => {}, lifetime = () => 8 * 60 * 60 * 1000, invite = () => null, onInvite = () => {}, log = () => {} }, { helper = ensureHelper, launch = spawn, health = publicHealth, websocket = publicSocket, Gateway = FriendGateway } = {}) {
    Object.assign(this, { directory, register, guard, onChange, lifetime, invite, onInvite, log, helper, launch, health, websocket, Gateway }); this.state = 'stopped'; this.generation = 0;
  }
  status() { return { state: this.state, message: this.message || '', hostname: this.hostname || '', expires: this.gateway?.expires || null, connectedFriends: this.gateway ? [...this.gateway.sessions.values()].filter(entry => entry.sockets.size > 0).length : 0 }; }
  update(state, message = '') { this.state = state; this.message = message; this.onChange(this.status()); }
  async start(saved) {
    if (this.state !== 'stopped' && this.state !== 'failed') throw Error('Sharing is already starting or running.');
    const generation = ++this.generation;
    this.hostname = saved?.hostname || ''; this.update('preparing', 'Checking your server and preparing Cloudflare…');
    try {
      await this.guard();
      if (generation !== this.generation) return;
      const executable = await this.helper(path.join(this.directory, 'helpers'), message => {
        this.log(`helper: ${message}`);
        if (generation === this.generation) this.update('preparing', message);
      });
      if (generation !== this.generation) return;
      // Bind the protected gateway before requesting any public hostname.
      // Until Cloudflare assigns it, every Host is rejected by this sentinel.
      let origin = saved ? 'https://' + saved.hostname : 'https://pending.invalid';
      // Read at each start, so changing it in Settings applies to the next
      // invitation without restarting the app.
      const gateway = new this.Gateway({ origin, register: this.register, lifetime: this.lifetime(), invite: this.invite() });
      // Record whatever it ended up using: a reused token, or a fresh one when
      // nothing was stored or the stored value was unusable.
      this.onInvite(gateway.invite);
      this.gateway = gateway;
      const port = await gateway.start();
      if (generation !== this.generation) { await gateway.stop(); return; }
      const { config, credentials } = saved ? configuration(saved, port) : { config: '{}' };
      // This file contains routing only. Tunnel secrets are supplied via the
      // child's private environment and are never written to logs or argv.
      const configPath = path.join(this.directory, 'tunnel.json');
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 }); fs.writeFileSync(configPath, config, { mode: 0o600 });
      const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
        TUNNEL_CRED_CONTENTS: credentials };
      for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
      const args = saved ? ['tunnel', '--config', configPath, '--no-autoupdate', '--loglevel', 'error', 'run', saved.tunnelId]
        : ['tunnel', '--config', configPath, '--no-autoupdate', '--url', 'http://127.0.0.1:' + port, '--metrics', '127.0.0.1:0'];
      this.child = this.launch(executable, args, { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      const child = this.child;
      // Keep cloudflared's own diagnostics. A named tunnel discarded them
      // entirely before, so "Cloudflare stopped" was all anyone ever saw.
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', chunk => {
        for (const line of String(chunk).split('\n')) {
          const text = line.trim();
          if (text) this.log(`cloudflared: ${text}`);
        }
      });
      child.once('error', () => this.fail(generation, 'Cloudflare could not start. Try sharing again.'));
      child.once('exit', () => { if (this.child === child) this.fail(generation, 'Cloudflare stopped. Start sharing again to reconnect.'); });
      this.update('connecting', 'Waiting for the public game link…');
      if (!saved) {
        origin = await quickHostname(child);
        if (generation !== this.generation) return;
        this.hostname = new URL(origin).host;
        gateway.origin = origin; gateway.host = this.hostname;
      }
      const deadline = Date.now() + 120000;
      let readiness = 'The public hostname has not answered yet';
      for (;;) {
        if (generation !== this.generation) return;
        try { const health = await this.health(origin); if (health.service === 'ragnarok-friends' && health.challenge === this.gateway.challenge) break; }
        catch (error) { readiness = error.message; }
        if (Date.now() >= deadline) throw Error('The public link did not reach this server. ' + readiness + '. Try sharing again; if using your own domain, check its Cloudflare DNS.');
        await pause(1000);
      }
      if (generation !== this.generation) return;
      const probe = this.gateway.probeSession();
      try { await this.websocket(origin, probe.cookie); } finally { probe.close(); }
      if (generation !== this.generation) return;
      this.update('sharing', 'Sharing is on. Send an invitation link to your friends.');
      let misses = 0;
      this.monitor = setInterval(async () => {
        if (this.checking || generation !== this.generation) return;
        if (this.gateway?.expires <= Date.now()) { await this.stop(); this.update('stopped', 'The invitation expired. Start sharing again to invite friends.'); return; }
        this.checking = true;
        try {
          const health = await this.health(origin);
          if (health.challenge !== this.gateway?.challenge || health.service !== 'ragnarok-friends') throw Error();
          misses = 0; if (generation === this.generation) this.update('sharing', 'Sharing is on.');
        } catch { if (++misses >= 2 && generation === this.generation) this.update('reconnecting', 'The internet link is reconnecting. Friends may need to log in again.'); }
        finally { this.checking = false; }
      }, 15000); this.monitor.unref();
    } catch (error) { if (generation !== this.generation) return; await this.stop(); this.update('failed', error.message); throw error; }
  }
  async fail(generation, message) { if (generation !== this.generation) return; await this.stop(); this.update('failed', message); }
  invitation() {
    if (this.state !== 'sharing' || !this.gateway || this.gateway.expires <= Date.now()) throw Error('Start sharing before copying a current invitation.');
    return this.gateway.link();
  }
  replaceInvitation() {
    if (!this.gateway || !['sharing', 'reconnecting'].includes(this.state)) throw Error('Start sharing first.');
    this.gateway.revoke();
    this.onInvite(this.gateway.invite);
    return this.gateway.link();
  }
  async stop() {
    if (this.stopping) return this.stopping;
    this.stopping = this.stopOwned();
    try { await this.stopping; } finally { this.stopping = null; }
  }
  async stopOwned() {
    ++this.generation; clearInterval(this.monitor); this.monitor = null;
    this.update('stopping', 'Stopping sharing…');
    const gateway = this.gateway; this.gateway = null;
    if (gateway) await gateway.stop();
    const child = this.child; this.child = null;
    if (child && child.exitCode === null && child.signalCode === null) await new Promise(resolve => {
      const finish = () => { clearTimeout(timer); child.removeListener('exit', finish); child.removeListener('close', finish); resolve(); };
      const timer = setTimeout(() => { child.kill('SIGKILL'); finish(); }, 5000);
      child.once('exit', finish); child.once('close', finish); child.kill();
    });
    this.update('stopped', 'Sharing is off. Your local game can keep running.');
  }
}
module.exports = { SharingController, publicHealth, publicSocket, publicLookup };
