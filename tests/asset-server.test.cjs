'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { AssetServer, control, processIdentity } = require('../electron/asset-server');

async function listen(server) {
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	return server.address().port;
}
async function freePort() {
	const server = net.createServer();
	const port = await listen(server);
	await new Promise(resolve => server.close(resolve));
	return port;
}
async function fixture(t, mode = '') {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-owner-'));
	const server = new AssetServer({ startTimeout: 1000, stopTimeout: 250 });
	const servers = [server];
	const options = {
		executable: process.execPath, args: [path.join(__dirname, 'fixtures/asset-process.cjs')],
		cwd: dir, stateRoot: dir,
		environment: { PORT: String(await freePort()), FIXTURE_MODE: mode },
	};
	t.after(async () => {
		for (const owned of servers.reverse()) await owned.stop();
		await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	});
	return { server, options, dir, own: owned => servers.push(owned) };
}

test('OS identity includes the current process creation time and executable', async () => {
	const id = await processIdentity(process.pid);
	assert.ok(id.start);
	assert.ok(id.executable.includes('node'));
});

test('parallel OS identity queries agree without a shell startup dependency', async () => {
	const identities = await Promise.all(Array.from({ length: 8 }, () => processIdentity(process.pid)));
	for (const id of identities) assert.deepEqual(id, identities[0]);
});

test('concurrent starts share one owned process; stop awaits actual exit', async t => {
	const { server, options, dir } = await fixture(t);
	const [a, b] = await Promise.all([server.start(options), server.start(options)]);
	assert.equal(a.pid, b.pid);
	assert.equal(await server.ready(), true);
	assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'asset-owner.json'))).identity.pid, a.pid);
	await server.stop();
	assert.equal(await server.ready(), false);
	assert.equal(fs.existsSync(path.join(dir, 'asset-owner.json')), false);
	assert.throws(() => process.kill(a.pid, 0), { code: 'ESRCH' });
});

for (const label of ['HTTP 200', 'non-HTTP listener']) {
	test(`never adopts or kills an unrelated ${label}`, async t => {
		const { server, options, dir } = await fixture(t);
		const foreign = label === 'HTTP 200' ? http.createServer((_, res) => res.end('{}')) : net.createServer(socket => { socket.on('error', () => {}); socket.end('not HTTP'); });
		const port = await listen(foreign);
		t.after(() => new Promise(resolve => foreign.close(resolve)));
		options.environment.PORT = String(port);
		fs.writeFileSync(path.join(dir, 'assets.log'), 'previous evidence');
		await assert.rejects(server.start(options), /does not own/);
		assert.equal(foreign.listening, true);
		assert.equal(fs.readFileSync(path.join(dir, 'assets.log'), 'utf8'), 'previous evidence');
		await server.stop();
		assert.equal(foreign.listening, true);
	});
}

for (const mode of ['early-exit', 'never-ready', 'wrong-identity', 'bad-health']) {
	test(`startup rejects ${mode} and leaves no child`, async t => {
		const { server, options } = await fixture(t, mode);
		await assert.rejects(server.start(options));
		assert.equal(server.running, false);
		assert.equal(await server.ready(), false);
	});
}

test('spawn failure is recoverable on the next serialized start', async t => {
	const { server, options } = await fixture(t);
	await assert.rejects(server.start({ ...options, cwd: path.join(options.cwd, 'absent') }));
	const ready = await server.start(options);
	assert.equal(ready.protocol, 1);
});

test('a reset initial control connection retries with a fresh authenticated challenge', async t => {
	const { server, options, dir } = await fixture(t, 'reset-first-control');
	await server.start(options);
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'control-attempts.json'))), { count: 2, unique: 2 });
	assert.equal(await server.ready(), true);
});

for (const mode of ['bad-control-mac-first', 'wrong-control-identity-first', 'reset-control-always']) {
	test(`startup fails closed for ${mode}`, async t => {
		const { server, options, dir } = await fixture(t, mode);
		await assert.rejects(server.start(options));
		const { count, unique } = JSON.parse(fs.readFileSync(path.join(dir, 'control-attempts.json')));
		assert.equal(count, mode === 'reset-control-always' ? 3 : 1);
		assert.equal(unique, count);
		assert.equal(server.running, false);
		assert.equal(fs.existsSync(path.join(dir, 'asset-owner.json')), false);
	});
}

test('configuration changes replace the process and rotate diagnostic logs', async t => {
	const { server, options, dir } = await fixture(t);
	let previous = await server.start(options);
	for (const [key, value] of [['DATA_OVERRIDE_PATH', '/pre-renewal'], ['WS_ALLOWED_TARGETS', '127.0.0.1:6121'], ['RAGNAROK_MANIFEST_ID', 'new-grfs'], ['RAGNAROK_PAYLOAD_VERSION', 'new-build']]) {
		options.environment[key] = value;
		const next = await server.start(options);
		assert.notEqual(next.pid, previous.pid);
		assert.notEqual(next.configFingerprint, previous.configFingerprint);
		assert.equal(await server.ready(), true);
		previous = next;
	}
	assert.match(fs.readFileSync(path.join(dir, 'assets.log'), 'utf8'), /configuration=/);
	assert.equal(fs.existsSync(path.join(dir, 'assets.log.1')), true);
});

test('a new owner replaces an authenticated orphan instead of adopting it', async t => {
	const { server, options, own } = await fixture(t, 'orphan');
	const old = await server.start(options);
	const replacement = new AssetServer({ stopTimeout: 1000 });
	own(replacement);
	const current = await replacement.start(options);
	assert.notEqual(current.pid, old.pid);
	assert.equal(await replacement.ready(), true);
	assert.throws(() => process.kill(old.pid, 0), { code: 'ESRCH' });
});

test('a reused PID never receives a shutdown or kill', async t => {
	const { server, options, dir } = await fixture(t);
	await server.start(options);
	const filename = path.join(dir, 'asset-owner.json');
	const record = JSON.parse(fs.readFileSync(filename));
	record.osIdentity.start = 'a different process';
	fs.writeFileSync(filename, JSON.stringify(record));
	const contender = new AssetServer();
	await assert.rejects(contender.start(options), /does not own/);
	assert.equal(await server.ready(), true);
});

test('an invalid authentication secret cannot stop a live owned process', async t => {
	const { server, options, dir } = await fixture(t);
	const identity = await server.start(options);
	await assert.rejects(control(identity, 'f'.repeat(64), 'shutdown', 200));
	assert.equal(await server.ready(), true);
	const filename = path.join(dir, 'asset-control.secret');
	fs.writeFileSync(filename, 'f'.repeat(64));
	const contender = new AssetServer();
	await assert.rejects(contender.start(options), /authenticate/);
	assert.equal(await server.ready(), true);
});

test('an unresponsive owned child is killed by its own process handle after the deadline', async t => {
	const { server, options } = await fixture(t, 'ignore-stop');
	const ready = await server.start(options);
	await server.stop();
	assert.throws(() => process.kill(ready.pid, 0), { code: 'ESRCH' });
});

test('an old exit callback cannot clear a subsequent launch', async t => {
	const { server, options } = await fixture(t);
	await server.start(options);
	const old = server.current.child;
	options.environment.RAGNAROK_OVERLAY_ID = 'new-overlay';
	const next = await server.start(options);
	old.emit('exit', 0, null);
	assert.equal(server.current.identity.pid, next.pid);
	assert.equal(await server.ready(), true);
});
