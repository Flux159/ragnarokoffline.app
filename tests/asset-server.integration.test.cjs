'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { fork } = require('node:child_process');
const { AssetServer, processIdentity } = require('../electron/asset-server');
const grf = require('./fixtures/grf.cjs');
const executable = process.env.REMOTECLIENT_BIN;

async function setup(t) {
	const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-rust-owner-'));
	const assets = path.join(stateRoot, 'assets');
	fs.mkdirSync(path.join(assets, 'resources'), { recursive: true });
	fs.writeFileSync(path.join(assets, 'resources', 'data.grf'), grf());
	fs.writeFileSync(path.join(assets, 'resources', 'DATA.INI'), '[Data]\n0=data.grf\n');
	const listener = net.createServer();
	await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
	const port = listener.address().port;
	await new Promise(resolve => listener.close(resolve));
	return { executable, cwd: stateRoot, stateRoot, environment: {
		PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'production',
		SERVER_ROOT: assets, CLIENT_PUBLIC_URL: `http://127.0.0.1:${port}`,
		CLIENT_AUTOEXTRACT: 'false', CLIENT_RESPATH: 'resources/', CLIENT_DATAINI: 'DATA.INI',
	} };
}

test('Electron lifecycle authenticates the real Rust binary and serves real archive bytes', { skip: !executable && 'set REMOTECLIENT_BIN to the built Rust server' }, async t => {
	const options = await setup(t);
	const server = new AssetServer();
	t.after(async () => {
		await server.stop();
		await fs.promises.rm(options.stateRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	});
	const identity = await server.start(options);
	assert.equal(await server.ready(), true);
	const base = `http://127.0.0.1:${identity.httpPort}`;
	assert.equal(await (await fetch(base + '/data/fixture.txt')).text(), 'synthetic archive bytes');
	const health = await (await fetch(base + '/api/health')).json();
	assert.deepEqual(Object.keys(health).sort(), ['service', 'status', 'version']);
	assert.equal(JSON.stringify(health).includes(options.stateRoot), false);
	await server.stop();
	assert.throws(() => process.kill(identity.pid, 0), { code: 'ESRCH' });
});

test('force-killing the owning parent shuts down its Rust child; next launch recovers the stale record', { skip: !executable && 'set REMOTECLIENT_BIN to the built Rust server' }, async t => {
	const options = await setup(t);
	const parent = fork(path.join(__dirname, 'fixtures/asset-owner-parent.cjs'), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
	parent.stderr.resume();
	const replacement = new AssetServer();
	t.after(async () => {
		if (parent.exitCode === null && parent.signalCode === null) {
			const exit = new Promise(resolve => parent.once('exit', resolve));
			parent.kill('SIGKILL');
			await exit;
		}
		await replacement.stop();
		await fs.promises.rm(options.stateRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	});
	const result = new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('parent fixture did not start')), 20000);
		parent.once('message', message => { clearTimeout(timer); message.error ? reject(new Error(message.error)) : resolve(message.identity); });
		parent.once('error', reject);
	});
	parent.send(options);
	const identity = await result;
	const osBefore = await processIdentity(identity.pid);
	const exit = new Promise(resolve => parent.once('exit', resolve));
	parent.kill('SIGKILL');
	await exit;
	let gone = false;
	const deadline = Date.now() + 8000;
	while (Date.now() < deadline) {
		try { const now = await processIdentity(identity.pid); if (JSON.stringify(now) !== JSON.stringify(osBefore)) { gone = true; break; } }
		catch { try { process.kill(identity.pid, 0); } catch (error) { if (error.code === 'ESRCH') { gone = true; break; } } }
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	assert.equal(gone, true, 'Rust child survived the parent crash');
	const next = await replacement.start(options);
	assert.notEqual(next.pid, identity.pid);
	assert.equal(await replacement.ready(), true);
});
