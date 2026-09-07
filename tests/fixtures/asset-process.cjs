'use strict';
// Independent protocol peer for process-lifecycle failures. Real Rust protocol
// interoperability is tested separately with the compiled server.
const readline = require('node:readline');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const crypto = require('node:crypto');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const mode = process.env.FIXTURE_MODE;
const input = readline.createInterface({ input: process.stdin });
input.once('line', bootstrap => {
	const config = JSON.parse(bootstrap);
	const mac = payload => crypto.createHmac('sha256', Buffer.from(config.secret, 'hex')).update(payload).digest('hex');
	if (mode === 'early-exit') return process.exit(17);
	const game = http.createServer((_, response) => {
		response.end(mode === 'bad-health' ? '<html>not health</html>' : JSON.stringify({ service: 'robrowser-remoteclient', version: 'fixture', status: 'ok' }));
	});
	const shutdown = () => {
		if (mode === 'ignore-stop') return;
		game.close(); control.close();
		setTimeout(() => process.exit(0), 30);
	};
	let identity;
	let statusCount = 0;
	const challenges = new Set();
	const control = net.createServer(socket => {
		let text = '';
		socket.on('error', () => {});
		socket.on('data', bytes => {
			text += bytes;
			if (!text.includes('\n')) return;
			const envelope = JSON.parse(text.trim());
			if (mac(envelope.payload) !== envelope.mac) return socket.end();
			const request = JSON.parse(envelope.payload);
			if (request.launchId !== config.launchId) return socket.end();
			if (request.action === 'status' && mode.includes('control')) {
				statusCount++;
				challenges.add(request.challenge);
				fs.writeFileSync('control-attempts.json', JSON.stringify({ count: statusCount, unique: challenges.size }));
				if (mode === 'reset-control-always' || (mode === 'reset-first-control' && statusCount === 1)) return socket.resetAndDestroy();
			}
			const firstStatus = request.action === 'status' && statusCount === 1;
			const claimed = mode === 'wrong-control-identity-first' && firstStatus ? { ...identity, launchId: '0'.repeat(64) } : identity;
			const payload = JSON.stringify({ identity: claimed, challenge: request.challenge, action: request.action });
			const signature = mode === 'bad-control-mac-first' && firstStatus ? '0'.repeat(64) : mac(payload);
			socket.end(JSON.stringify({ payload, mac: signature }) + '\n');
			if (request.action === 'shutdown') shutdown();
		});
	});
	game.on('error', () => process.exit(18));
	game.listen(Number(process.env.PORT), '127.0.0.1', () => {
		control.listen(0, '127.0.0.1', () => {
			identity = {
				protocol: 1, service: 'robrowser-remoteclient', version: 'fixture', pid: process.pid,
				launchId: config.launchId, stateRoot: config.stateRoot, executable: process.execPath,
				executableDigest: hash(fs.readFileSync(process.execPath)),
				configFingerprint: hash(JSON.stringify(Object.fromEntries(Object.entries(config.environment).sort()))),
				controlPort: control.address().port, httpPort: game.address().port,
			};
			if (mode === 'wrong-identity') identity.launchId = '0'.repeat(64);
			if (mode !== 'never-ready') console.log('RAGNAROK_ASSET_READY ' + JSON.stringify(identity));
		});
	});
	input.on('close', () => { if (mode !== 'orphan') shutdown(); });
});
