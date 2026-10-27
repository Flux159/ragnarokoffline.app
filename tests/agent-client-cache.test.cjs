'use strict';
// An AI agent's window has a session of its own, so the client cache the player's launch clears
// is not the one it reads. With one stamp for every session, the agent kept files from before
// the mods changed: an itemInfo table a later mod release had fixed still failed to parse in the
// agent's window ("unfinished string"), and every item in it lost its name and description.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { createAgentPlay } = require('../electron/agent-play');

const ROOT = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8').replace(/\r\n/g, '\n');
const drop = main.slice(main.indexOf('async function dropStaleClientCache'), main.indexOf('function spawnSync'));

test('each session is compared against the overlay with a stamp of its own', () => {
	assert.match(drop, /async function dropStaleClientCache\(partition = null\)/);
	assert.match(drop, /partition \? `client-cache\.\$\{partition\.replace\(\/\^persist:\/, ''\)\}\.id` : 'client-cache\.id'/,
		'the game window keeps client-cache.id, so a player\'s warm cache is not dropped by the update');
	assert.match(drop, /partition \? session\.fromPartition\(partition\) : session\.defaultSession/);
	assert.ok(drop.indexOf('clearCache()') < drop.indexOf('fs.writeFileSync(stamp'), 'the stamp is still written only after the clear');
});

test('the agents are handed the same function', () => {
	const wiring = main.slice(main.indexOf("require('./agent-play').createAgentPlay({"), main.indexOf('return agentPlayInstance;'));
	assert.match(wiring, /\n\t+dropStaleClientCache,\n/);
});

test('an agent\'s window clears its own partition\'s cache before it is made', async t => {
	const state = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-client-cache-'));
	const game = http.createServer((req, res) => res.end('ok'));
	await new Promise(r => game.listen(0, '127.0.0.1', r));
	t.after(() => game.close());

	const calls = [];
	class BrowserWindow {
		constructor(options) {
			calls.push(['window', options.webPreferences.partition]);
			throw new Error('no window in a test');
		}
	}
	const agents = createAgentPlay({
		BrowserWindow, stateDir: () => state, stackBin: () => '/nonexistent/ragnarok-stack', port: () => 0,
		gameBase: () => `http://127.0.0.1:${game.address().port}`, gamePath: '/',
		hosting: () => true, runAccount: async () => {}, era: () => 'renewal', log: () => {},
		dropStaleClientCache: async partition => { calls.push(['drop', partition]); },
	});
	await agents.start({ show: false, agents: 2 });
	t.after(() => agents.stop());
	const { port, token } = JSON.parse(fs.readFileSync(path.join(state, 'agent', 'connection.json'), 'utf8'));
	for (const agent of [1, 2]) {
		const res = await fetch(`http://127.0.0.1:${port}/v1/command`, {
			method: 'POST',
			headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
			body: JSON.stringify({ cmd: 'state', agent }),
		});
		assert.equal((await res.json()).error, 'no window in a test');
	}
	assert.deepEqual(calls, [
		['drop', 'persist:ai-agent'], ['window', 'persist:ai-agent'],
		['drop', 'persist:ai-agent-2'], ['window', 'persist:ai-agent-2'],
	]);
});
