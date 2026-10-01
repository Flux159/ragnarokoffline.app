'use strict';
// The host ports this copy of the app listens on.
//
// The source of truth is the environment -- RAGNAROK_OFFLINE_ASSET_PORT,
// _LOGIN_PORT, _CHAR_PORT, _MAP_PORT, _AGENT_PORT -- and the only thing that
// parses it is the supervisor (stack/src/ports.rs). This asks it,
// `ragnarok-stack ports`, rather than reading the variables a second time, so
// the shell, the supervisor and the test scripts cannot disagree about what a
// value means or whether it is valid.
//
// With none of them set -- every real install -- nothing is spawned and the
// answer is the ports the app has always used.

const { spawnSync } = require('node:child_process');

const DEFAULTS = Object.freeze({ asset: 3338, login: 6900, char: 6121, map: 5121, agent: 7490 });
const OVERRIDE = /^RAGNAROK_OFFLINE_[A-Z]+_PORT$/;

function overridden(env = process.env) {
	return Object.keys(env).some(key => OVERRIDE.test(key) && String(env[key]).trim() !== '');
}

// Throws when an override is set and the supervisor refuses it (or is too old
// to know the command): falling back to the defaults there would put this copy
// on the ports of the one it was moved away from.
function readPorts(stackBin, env = process.env, run = spawnSync) {
	if (!overridden(env)) return DEFAULTS;
	const result = run(stackBin, ['ports'], { env, encoding: 'utf8', timeout: 15000, windowsHide: true });
	if (result.error) throw new Error(`port overrides are set, but ${stackBin} could not be run: ${result.error.message}`);
	if (result.status !== 0) {
		const why = String(result.stderr || result.stdout || '').trim();
		throw new Error(`port overrides are set, but the supervisor refused them: ${why || `exit ${result.status}`}`);
	}
	let parsed;
	try { parsed = JSON.parse(result.stdout); } catch { throw new Error(`ragnarok-stack ports answered something that is not JSON: ${String(result.stdout).slice(0, 200)}`); }
	for (const key of Object.keys(DEFAULTS)) {
		if (!Number.isInteger(parsed[key]) || parsed[key] < 1 || parsed[key] > 65535) throw new Error(`ragnarok-stack ports gave no ${key} port`);
	}
	return Object.freeze(Object.fromEntries(Object.keys(DEFAULTS).map(key => [key, parsed[key]])));
}

// The WebSocket proxy's allowlist and the friends gateway's path check both
// need these as `host:port` strings; one function so they cannot drift.
function gameTargets(ports, backend = '127.0.0.1') {
	return [`127.0.0.1:${ports.login}`, `${backend}:${ports.char}`, `${backend}:${ports.map}`];
}

module.exports = { DEFAULTS, overridden, readPorts, gameTargets };
