'use strict';

// Serial, owner-only monitoring; it never starts an engine or restarts a game.
class CrashMonitor {
  constructor({ active, collect, log, interval = 15000 }) {
    Object.assign(this, { active, collect, log, interval });
    this.busy = false;
    this.lastError = '';
  }
  async tick() {
    if (this.busy || !this.active()) return;
    this.busy = true;
    try {
      const message = await this.collect();
      this.lastError = '';
      if (message?.trim()) this.log(message.trim());
    } catch {
      const message = 'Crash evidence collection failed; check local storage and engine diagnostics.';
      if (this.lastError !== message) this.log(message);
      this.lastError = message;
    } finally { this.busy = false; }
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.interval);
    this.timer.unref();
  }
  stop() { clearInterval(this.timer); this.timer = null; }
}
module.exports = { CrashMonitor };
