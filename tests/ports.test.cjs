'use strict';
// Port overrides (stack/src/ports.rs, electron/ports.js): a second world --
// the agent test world -- runs beside the player's app only if every listener
// moves together, and only if nothing falls back to a default on the way.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DEFAULTS, overridden, readPorts, gameTargets } = require('../electron/ports');
const { FriendGateway } = require('../electron/sharing/gateway');
const probe = require('../electron/listener-probe');

const MOVED = { RAGNAROK_OFFLINE_ASSET_PORT: '13338', RAGNAROK_OFFLINE_LOGIN_PORT: '16900', RAGNAROK_OFFLINE_CHAR_PORT: '16121', RAGNAROK_OFFLINE_MAP_PORT: '15121', RAGNAROK_OFFLINE_AGENT_PORT: '17490' };

test('with no override nothing is spawned and the ports are the ones the app always used', () => {
  const run = () => { throw new Error('must not run the supervisor'); };
  assert.deepEqual(readPorts('/nonexistent/ragnarok-stack', { HOME: '/x' }, run), { asset: 3338, login: 6900, char: 6121, map: 5121, agent: 7490 });
  // An empty variable is unset, as the supervisor reads it.
  assert.equal(overridden({ RAGNAROK_OFFLINE_MAP_PORT: ' ' }), false);
  assert.equal(overridden({ RAGNAROK_OFFLINE_MAP_PORT: '15121' }), true);
  // Not one of ours.
  assert.equal(overridden({ RAGNAROK_OFFLINE_HOME: '/w', PORT: '1' }), false);
});

test('an override is the supervisor\'s answer, and a refusal is never a quiet fallback to the defaults', () => {
  const answer = JSON.stringify({ asset: 13338, login: 16900, char: 16121, map: 15121, agent: 17490 });
  const seen = [];
  const ok = (bin, args, options) => { seen.push([bin, args, options.env.RAGNAROK_OFFLINE_LOGIN_PORT]); return { status: 0, stdout: answer + '\n', stderr: '' }; };
  assert.deepEqual(readPorts('/w/bin/ragnarok-stack', MOVED, ok), JSON.parse(answer));
  assert.deepEqual(seen, [['/w/bin/ragnarok-stack', ['ports'], '16900']]);

  const refused = () => ({ status: 1, stdout: '', stderr: 'the login and char ports are both 6900\n' });
  assert.throws(() => readPorts('stack', MOVED, refused), /refused them: the login and char ports are both 6900/);
  assert.throws(() => readPorts('stack', MOVED, () => ({ error: new Error('ENOENT') })), /could not be run/);
  // An old supervisor prints its usage for a verb it does not know.
  assert.throws(() => readPorts('stack', MOVED, () => ({ status: 0, stdout: 'usage: ragnarok-stack ...' })), /not JSON/);
  assert.throws(() => readPorts('stack', MOVED, () => ({ status: 0, stdout: '{"asset":13338}' })), /no login port/);
});

test('the proxy allowlist and the friends gateway follow the moved game servers', () => {
  assert.deepEqual(gameTargets(DEFAULTS), ['127.0.0.1:6900', '127.0.0.1:6121', '127.0.0.1:5121']);
  assert.deepEqual(gameTargets({ ...DEFAULTS, login: 16900, char: 16121, map: 15121 }, '192.168.1.20'), ['127.0.0.1:16900', '192.168.1.20:16121', '192.168.1.20:15121']);

  const register = async () => {};
  const usual = new FriendGateway({ origin: 'https://play.example.com', register });
  assert.equal(usual.upstreamPort, 3338);
  assert.deepEqual([...usual.socketPaths].sort(), ['/ws/127.0.0.1:5121', '/ws/127.0.0.1:6121', '/ws/127.0.0.1:6900']);
  assert.equal(usual.loginPath, '/ws/127.0.0.1:6900');

  const moved = new FriendGateway({ origin: 'https://play.example.com', register, ports: { asset: 13338, login: 16900, char: 16121, map: 15121, agent: 17490 } });
  assert.equal(moved.upstreamPort, 13338);
  assert.deepEqual([...moved.socketPaths].sort(), ['/ws/127.0.0.1:15121', '/ws/127.0.0.1:16121', '/ws/127.0.0.1:16900']);
  // The login packet limits apply to the moved login server, not to 6900.
  assert.equal(moved.loginPath, '/ws/127.0.0.1:16900');
  assert.equal(moved.socketPaths.has('/ws/127.0.0.1:6900'), false);
});

test('the listener check probes the moved ports', () => {
  assert.deepEqual(probe.gamePorts(DEFAULTS), probe.GAME_PORTS);
  assert.deepEqual(probe.gamePorts({ asset: 13338, login: 16900, char: 16121, map: 15121 }), [13338, 16900, 16121, 15121]);
});

// Against the real supervisor when one has been built, so the two halves are
// checked against each other and not only against this file's idea of them.
const built = path.join(__dirname, '..', 'stack', 'target', 'debug', 'ragnarok-stack' + (process.platform === 'win32' ? '.exe' : ''));
test('the built supervisor answers `ports` the way the shell reads it', { skip: !fs.existsSync(built) && 'stack is not built' }, () => {
  assert.deepEqual(readPorts(built, { ...process.env, ...MOVED }), { asset: 13338, login: 16900, char: 16121, map: 15121, agent: 17490 });
  assert.throws(() => readPorts(built, { ...process.env, RAGNAROK_OFFLINE_CHAR_PORT: '6900' }), /RAGNAROK_OFFLINE_LOGIN_PORT/);
  assert.throws(() => readPorts(built, { ...process.env, RAGNAROK_OFFLINE_MAP_PORT: '80' }), /1024 to 65535/);
});
