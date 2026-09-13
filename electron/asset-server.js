'use strict';

// One owner, one launch configuration, one serialized lifecycle. Public health
// is only a liveness check; the authenticated private channel establishes which
// process is responding. No process is adopted or killed by port/image name.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const PREFIX = 'RAGNAROK_ASSET_READY ';
const SERVICE = 'robrowser-remoteclient';
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const nonce = () => crypto.randomBytes(32).toString('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const canonical = object => JSON.stringify(Object.fromEntries(Object.entries(object).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));

function authenticate(secret, payload) {
	return crypto.createHmac('sha256', Buffer.from(secret, 'hex')).update(payload).digest('hex');
}

function sameMac(a, b) {
	return typeof b === 'string' && /^[a-f0-9]{64}$/.test(b)
		&& crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

async function processIdentity(pid, inspector = process.env.STACK_BIN) {
	if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('invalid process ID');
	if (process.platform === 'linux') {
		const stat = await fs.promises.readFile(`/proc/${pid}/stat`, 'utf8');
		return { start: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19], executable: await fs.promises.readlink(`/proc/${pid}/exe`) };
	}
	if (process.platform === 'win32') {
		if (!inspector) throw new Error('Windows process identity needs the bundled supervisor (STACK_BIN for tests)');
		const { stdout } = await exec(inspector, ['process-identity', String(pid)], { timeout: 3000, windowsHide: true, maxBuffer: 131072 });
		const identity = JSON.parse(stdout);
		if (!identity.start || !identity.executable) throw new Error('cannot verify process identity');
		return identity;
	}
	const { stdout } = await exec('/bin/ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'comm='], { timeout: 3000 });
	const match = /^(.{24})\s+(.+)$/m.exec(stdout.trim());
	if (!match) throw new Error('cannot verify process identity');
	return { start: match[1], executable: match[2] };
}

function control(identity, secret, action, timeout = 2000) {
	return new Promise((resolve, reject) => {
		const challenge = nonce();
		const payload = JSON.stringify({ launchId: identity.launchId, challenge, action });
		const socket = net.connect({ host: '127.0.0.1', port: identity.controlPort });
		let text = '';
		const finish = (error, value) => {
			clearTimeout(timer);
			socket.destroy();
			if (error) reject(error); else resolve(value);
		};
		const timer = setTimeout(() => finish(new Error('asset control timed out')), timeout);
		socket.on('error', finish);
		socket.on('connect', () => socket.write(JSON.stringify({ payload, mac: authenticate(secret, payload) }) + '\n'));
		socket.on('data', chunk => {
			text += chunk.toString('utf8');
			if (Buffer.byteLength(text) > 16384) return finish(new Error('oversized asset control reply'));
			if (!text.includes('\n')) return;
			try {
				const envelope = JSON.parse(text.slice(0, text.indexOf('\n')));
				if (typeof envelope.payload !== 'string' || !sameMac(authenticate(secret, envelope.payload), envelope.mac)) throw new Error('asset control authentication failed');
				const reply = JSON.parse(envelope.payload);
				if (reply.challenge !== challenge || reply.action !== action || canonical(reply.identity) !== canonical(identity)) throw new Error('asset control identity mismatch');
				finish(null, reply.identity);
			} catch (error) { finish(error); }
		});
		socket.on('end', () => finish(new Error('asset control closed without a reply')));
	});
}

function portBusy(port) {
	return new Promise((resolve, reject) => {
		const socket = net.connect({ host: '127.0.0.1', port });
		// A closed loopback port can take more than a second to report refusal
		// on Windows. Keep a bounded wait, and never treat silence as free.
		const timer = setTimeout(() => { socket.destroy(); reject(new Error(`Port ${port} did not respond; cannot establish whether it is free.`)); }, 5000);
		const finish = value => { clearTimeout(timer); socket.destroy(); resolve(value); };
		socket.on('connect', () => finish(true));
		socket.on('error', error => {
			if (error.code === 'ECONNREFUSED') finish(false);
			else { clearTimeout(timer); socket.destroy(); reject(error); }
		});
	});
}

function healthy(identity, timeout = 2000) {
	return new Promise(resolve => {
		let body = '';
		const request = http.get({ host: '127.0.0.1', port: identity.httpPort, path: '/api/health', agent: false }, response => {
			response.on('error', () => done(false));
			response.on('data', bytes => {
				body += bytes.toString('utf8');
				if (body.length > 4096) { response.destroy(); done(false); }
			});
			response.on('end', () => {
				try { const value = JSON.parse(body); done(response.statusCode === 200 && value.status === 'ok' && value.service === SERVICE && value.version === identity.version); }
				catch { done(false); }
			});
		});
		const timer = setTimeout(() => done(false), timeout);
		function done(value) { clearTimeout(timer); request.destroy(); resolve(value); }
		request.on('error', () => done(false));
	});
}

function atomicJson(filename, value) {
	const temporary = `${filename}.${nonce()}.tmp`;
	try {
		fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
		fs.renameSync(temporary, filename);
	} finally { fs.rmSync(temporary, { force: true }); }
}

class AssetServer {
	constructor({ log = () => {}, startTimeout = 60000, stopTimeout = 7000, identify = processIdentity } = {}) {
		this.log = log;
		this.startTimeout = startTimeout;
		this.stopTimeout = stopTimeout;
		this.identify = identify;
		this.current = null;
		this.queue = Promise.resolve();
	}

	get running() { return !!this.current?.child && this.current.child.exitCode === null && this.current.child.signalCode === null; }
	serialize(operation) {
		const pending = this.queue.then(operation);
		this.queue = pending.catch(() => {});
		return pending;
	}
	start(options) { return this.serialize(() => this.startOwned(options)); }
	stop() { return this.serialize(() => this.stopOwned()); }
	prepare(stateRoot, port = 3338) {
		return this.serialize(async () => {
			await this.stopOwned();
			fs.mkdirSync(stateRoot, { recursive: true });
			stateRoot = fs.realpathSync(stateRoot);
			const record = path.join(stateRoot, 'asset-owner.json');
			if (fs.existsSync(record)) {
				const secret = fs.readFileSync(path.join(stateRoot, 'asset-control.secret'), 'utf8').trim();
				if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error('Invalid asset ownership secret; cannot safely rebuild assets.');
				await this.recover(record, stateRoot, secret);
			}
			if (await portBusy(port)) throw new Error(`Port ${port} is occupied by a server this app does not own. Quit that server before rebuilding assets.`);
		});
	}

	async ready() {
		const launch = this.current;
		if (!this.running || !launch.identity) return false;
		try {
			await control(launch.identity, launch.secret, 'status');
			return this.current === launch && this.running && await healthy(launch.identity);
		} catch { return false; }
	}

	// Only used on synchronous OS teardown. Closing this child's private stdin
	// requests bounded shutdown; no port scanning or asynchronous queue needed.
	stopSync() {
		if (this.running) {
			this.current.child.stdin.destroy();
			this.current.child.kill();
		}
	}

	async startOwned({ executable, args = [], cwd, stateRoot, environment }) {
		fs.mkdirSync(stateRoot, { recursive: true });
		stateRoot = fs.realpathSync(stateRoot);
		executable = fs.realpathSync(executable);
		const digest = sha256(fs.readFileSync(executable));
		const fingerprint = sha256(canonical(environment));
		const port = Number(environment.PORT);
		if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid asset port');
		if (this.running && this.current.identity?.configFingerprint === fingerprint && this.current.identity?.executableDigest === digest && this.current.identity?.stateRoot === stateRoot && await this.ready()) return this.current.identity;
		await this.stopOwned();
		const recordPath = path.join(stateRoot, 'asset-owner.json');
		const secretPath = path.join(stateRoot, 'asset-control.secret');
		let secret;
		try { secret = fs.readFileSync(secretPath, 'utf8').trim(); }
		catch (error) {
			if (error.code !== 'ENOENT') throw error;
			secret = nonce();
			fs.writeFileSync(secretPath, secret + '\n', { flag: 'wx', mode: 0o600 });
		}
		if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error('The asset ownership secret is invalid. Restore it from this installation’s backup.');
		await this.recover(recordPath, stateRoot, secret);
		if (await portBusy(port)) throw new Error(`Port ${port} is occupied by a process this app does not own. Quit the other server or app, then retry. No unrelated process was stopped.`);

		const logPath = path.join(stateRoot, 'assets.log');
		// Keep a small history; never truncate an unrelated process's log.
		for (let i = 3; i >= 1; i--) {
			const from = i === 1 ? logPath : `${logPath}.${i - 1}`;
			try { fs.renameSync(from, `${logPath}.${i}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
		}
		const launchId = nonce();
		const header = `launch ${launchId}: executable=${executable} sha256=${digest} configuration=${fingerprint}\n`;
		fs.writeFileSync(logPath, header, { mode: 0o600 });
		this.log(header.trim());
		const fd = fs.openSync(logPath, 'a');
		let child;
		try {
			child = spawn(executable, [...args, '--managed'], {
				cwd, env: { ...process.env, ...environment },
				stdio: ['pipe', 'pipe', fd], windowsHide: true,
			});
		} finally { fs.closeSync(fd); }
		const launch = { child, secret, recordPath, identity: null, osIdentity: null };
		this.current = launch;
		launch.exited = new Promise(resolve => {
			child.once('exit', (code, signal) => {
				this.log(`asset process ${child.pid} exited: code=${code} signal=${signal}`);
				if (this.current === launch) this.current = null;
				this.removeRecord(launch);
				resolve();
			});
			child.once('error', () => { if (this.current === launch) this.current = null; resolve(); });
		});
		child.stdin.on('error', () => {});
		try {
			const ready = new Promise((resolve, reject) => {
				let buffer = '';
				let settled = false;
				const finish = (error, identity) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					if (error) reject(error); else resolve(identity);
				};
				const timer = setTimeout(() => finish(new Error('Asset server readiness timed out. Check assets.log; this build requires managed protocol 1.')), this.startTimeout);
				child.once('error', error => finish(error));
				child.once('exit', (code, signal) => finish(new Error(`Asset server exited before readiness (${code ?? signal}). Check assets.log.`)));
				child.stdout.setEncoding('utf8');
				child.stdout.on('data', chunk => {
					try { fs.appendFileSync(logPath, chunk); } catch (error) { this.log(`asset log write failed: ${error.message}`); }
					if (settled) return;
					buffer += chunk;
					if (buffer.length > 65536) return finish(new Error('Oversized asset startup output'));
					let end;
					while ((end = buffer.indexOf('\n')) >= 0) {
						const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
						if (!line.startsWith(PREFIX)) continue;
						try { finish(null, JSON.parse(line.slice(PREFIX.length))); } catch { finish(new Error('Malformed asset identity')); }
					}
				});
			});
			child.stdin.write(JSON.stringify({ secret, launchId, stateRoot, environment }) + '\n');
			const identity = await ready;
			if (identity.protocol !== 1 || identity.service !== SERVICE || identity.pid !== child.pid || identity.launchId !== launchId || identity.stateRoot !== stateRoot || identity.executableDigest !== digest || identity.configFingerprint !== fingerprint || identity.httpPort !== port || !Number.isInteger(identity.controlPort) || identity.controlPort < 1 || identity.controlPort > 65535) throw new Error('Asset server launch identity does not match this build/configuration');
			launch.identity = identity;
			launch.osIdentity = await this.identify(child.pid);
			// A busy host can reset the first control connection before the
			// private peer's deadline. Retry only this owned launch's read-only
			// status, with a new challenge and full verification each time.
			const deadline = Date.now() + Math.min(this.startTimeout, 6000);
			for (let attempt = 0; ; attempt++) {
				try {
					await control(identity, secret, 'status', Math.max(1, Math.min(2000, deadline - Date.now())));
					break;
				} catch (error) {
					const transient = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE'].includes(error.code)
						|| ['asset control timed out', 'asset control closed without a reply'].includes(error.message);
					if (!transient || attempt >= 2 || Date.now() + 100 >= deadline
						|| !this.running || this.current !== launch) throw error;
					await new Promise(resolve => setTimeout(resolve, 100));
				}
			}
			if (!(await healthy(identity)) || !this.running || this.current !== launch) throw new Error('Asset server failed its readiness probe');
			atomicJson(recordPath, { identity, osIdentity: launch.osIdentity });
			this.log(`owned asset server ready: pid=${identity.pid} configuration=${fingerprint}`);
			return identity;
		} catch (error) {
			await this.stopLaunch(launch);
			throw error;
		}
	}

	removeRecord(launch) {
		try {
			const saved = JSON.parse(fs.readFileSync(launch.recordPath, 'utf8'));
			if (saved.identity?.launchId === launch.identity?.launchId) fs.rmSync(launch.recordPath, { force: true });
		} catch { /* No record, or somebody else owns it. */ }
	}

	async recover(recordPath, stateRoot, secret) {
		let saved;
		try { saved = JSON.parse(fs.readFileSync(recordPath, 'utf8')); }
		catch (error) {
			if (error.code === 'ENOENT') return;
			throw new Error('Cannot read the asset ownership record; no process was stopped.');
		}
		const id = saved.identity;
		if (id?.stateRoot !== stateRoot || id?.service !== SERVICE || id?.protocol !== 1 || !Number.isSafeInteger(id.pid) || !Number.isInteger(id.controlPort) || id.controlPort < 1 || id.controlPort > 65535) throw new Error('Invalid asset ownership record; no process was stopped.');
		let actual;
		try { actual = await this.identify(id.pid); }
		catch {
			// A failed OS query is not proof of exit (permissions/tools can fail).
			try { process.kill(id.pid, 0); }
			catch (error) { if (error.code === 'ESRCH') { fs.rmSync(recordPath, { force: true }); return; } }
			throw new Error(`Cannot verify asset process ${id.pid}; no process was stopped.`);
		}
		if (canonical(actual) !== canonical(saved.osIdentity || {})) {
			// PID reuse: discard the stale record but never signal the new owner.
			this.log(`discarding stale asset ownership record: PID ${id.pid} was reused`);
			fs.rmSync(recordPath, { force: true });
			return;
		}
		try {
			await control(id, secret, 'status');
			this.log(`replacing verified orphan: pid=${id.pid} binary=${id.executableDigest} configuration=${id.configFingerprint}`);
			await control(id, secret, 'shutdown');
		} catch { throw new Error(`Could not authenticate/shut down asset process ${id.pid}. Quit that app and retry; no unrelated process was stopped.`); }
		const deadline = Date.now() + this.stopTimeout;
		let exited = false;
		while (Date.now() < deadline) {
			try {
				const now = await this.identify(id.pid);
				if (canonical(now) !== canonical(actual)) { exited = true; break; }
			} catch {
				try { process.kill(id.pid, 0); } catch (error) { if (error.code === 'ESRCH') { exited = true; break; } }
			}
			await delay(75);
		}
		if (!exited) throw new Error(`Verified asset process ${id.pid} has not exited yet; retry after it finishes shutting down.`);
		if (await portBusy(id.httpPort)) throw new Error(`Port ${id.httpPort} is still occupied after orphan shutdown; retry when the server has exited.`);
		fs.rmSync(recordPath, { force: true });
	}

	async stopOwned() { if (this.current) await this.stopLaunch(this.current); }
	async stopLaunch(launch) {
		const child = launch.child;
		if (child.exitCode === null && child.signalCode === null) {
			if (launch.identity) {
				try { await control(launch.identity, launch.secret, 'shutdown'); } catch { /* stdin EOF still reaches our own child. */ }
			}
			child.stdin.end();
			let timer;
			const exited = await Promise.race([launch.exited.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), this.stopTimeout); })]);
			clearTimeout(timer);
			if (!exited && child.exitCode === null && child.signalCode === null) {
				if (launch.osIdentity && canonical(await this.identify(child.pid)) !== canonical(launch.osIdentity)) throw new Error('Asset PID changed during shutdown; refusing to signal it');
				child.kill('SIGKILL');
				let killTimer;
				await Promise.race([launch.exited, new Promise((_, reject) => { killTimer = setTimeout(() => reject(new Error('Asset server did not exit after shutdown')), 2000); })]).finally(() => clearTimeout(killTimer));
			}
		}
		this.removeRecord(launch);
		if (this.current === launch) this.current = null;
	}
}

module.exports = { AssetServer, processIdentity, control, healthy, canonical, sha256 };
