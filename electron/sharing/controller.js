'use strict';
const { spawn } = require('node:child_process');
const https = require('node:https');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { FriendGateway } = require('./gateway');
const { configuration } = require('./cloudflare');
const { ensureHelper } = require('./helper');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function publicHealth(origin) {
  return new Promise((resolve, reject) => {
    const request = https.get(origin + '/_friend/health', { timeout: 8000, agent: false }, response => {
      let body = '', size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > 4096) request.destroy(); else body += chunk; });
      response.on('end', () => {
        try { if (response.statusCode !== 200) throw Error(); resolve(JSON.parse(body)); } catch { reject(Error('Public link is not ready')); }
      }); response.on('error', reject);
    }); request.on('timeout', () => request.destroy()); request.on('error', reject);
  });
}
function publicSocket(origin, cookie) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    const request = https.request(origin + '/ws/127.0.0.1:6900', { timeout: 10000, agent: false,
      headers: { origin, cookie, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': key, 'sec-websocket-version': '13' } });
    const failure = () => reject(Error('The public page connected, but game connections did not. Check Cloudflare’s WebSocket setting and try again.'));
    request.on('upgrade', (response, socket) => { socket.destroy(); response.headers['sec-websocket-accept'] === accept ? resolve() : failure(); });
    request.on('response', response => { response.destroy(); failure(); });
    request.on('error', failure); request.on('timeout', () => request.destroy()); request.end();
  });
}
class SharingController {
  constructor({ directory, register, guard, onChange = () => {} }, { helper = ensureHelper, launch = spawn, health = publicHealth, websocket = publicSocket, Gateway = FriendGateway } = {}) {
    Object.assign(this, { directory, register, guard, onChange, helper, launch, health, websocket, Gateway }); this.state = 'stopped'; this.generation = 0;
  }
  status() { return { state: this.state, message: this.message || '', hostname: this.hostname || '', expires: this.gateway?.expires || null, connectedFriends: this.gateway ? [...this.gateway.sessions.values()].filter(entry => entry.sockets.size > 0).length : 0 }; }
  update(state, message = '') { this.state = state; this.message = message; this.onChange(this.status()); }
  async start(saved) {
    if (this.state !== 'stopped' && this.state !== 'failed') throw Error('Sharing is already starting or running.');
    const generation = ++this.generation;
    this.hostname = saved.hostname; this.update('preparing', 'Checking your server and preparing Cloudflare…');
    try {
      await this.guard();
      if (generation !== this.generation) return;
      const executable = await this.helper(path.join(this.directory, 'helpers'));
      if (generation !== this.generation) return;
      const origin = 'https://' + saved.hostname;
      const gateway = new this.Gateway({ origin, register: this.register });
      this.gateway = gateway;
      const port = await gateway.start();
      if (generation !== this.generation) { await gateway.stop(); return; }
      const { config, credentials } = configuration(saved, port);
      // This file contains routing only. Tunnel secrets are supplied via the
      // child's private environment and are never written to logs or argv.
      const configPath = path.join(this.directory, 'tunnel.json');
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 }); fs.writeFileSync(configPath, config, { mode: 0o600 });
      const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
        TUNNEL_CRED_CONTENTS: credentials };
      for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
      this.child = this.launch(executable, ['tunnel', '--config', configPath, '--no-autoupdate', '--loglevel', 'error', 'run', saved.tunnelId], { env, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
      const child = this.child;
      child.once('error', () => this.fail(generation, 'Cloudflare could not start. Try sharing again.'));
      child.once('exit', () => { if (this.child === child) this.fail(generation, 'Cloudflare stopped. Start sharing again to reconnect.'); });
      this.update('connecting', 'Waiting for the public game link…');
      const deadline = Date.now() + 120000;
      for (;;) {
        if (generation !== this.generation) return;
        try { const health = await this.health(origin); if (health.service === 'ragnarok-friends' && health.challenge === this.gateway.challenge) break; }
        catch {}
        if (Date.now() >= deadline) throw Error('The public link did not reach this server. Check the hostname’s Cloudflare DNS and try again.');
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
  replaceInvitation() { if (!this.gateway || !['sharing', 'reconnecting'].includes(this.state)) throw Error('Start sharing first.'); this.gateway.revoke(); }
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
module.exports = { SharingController, publicHealth, publicSocket };
