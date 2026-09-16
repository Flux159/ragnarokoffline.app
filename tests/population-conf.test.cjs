'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lines, companionLimit, COMPANION_LIMIT_MIN, COMPANION_LIMIT_MAX } = require('../electron/population-conf');

// The bounds the Settings slider exposes: 4 (the historic cap) to 11, because
// rAthena's MAX_PARTY in our fork is 12 and a slot must stay free for real
// players.
test('bounds match the party headroom', () => {
	assert.equal(COMPANION_LIMIT_MIN, 4);
	assert.equal(COMPANION_LIMIT_MAX, 11);
});

test('the slider value passes through when in range', () => {
	for (const v of [4, 5, 6, 7, 8, 9, 10, 11]) assert.equal(companionLimit({ population_companion_limit: v }), v);
});

// Old saves have no key at all; NaN and garbage land on the historic default
// rather than silently raising or lowering what a player already had.
test('missing or invalid values fall back to the historic cap of 4', () => {
	for (const v of [undefined, null, NaN, 'nonsense']) assert.equal(companionLimit({ population_companion_limit: v }), 4);
});

// A hand-edited settings.json above the party headroom is clamped down rather
// than allowed to fill every slot; below 4 it comes back up.
test('out-of-range values are clamped, never refused', () => {
	assert.equal(companionLimit({ population_companion_limit: 3 }), 4);
	assert.equal(companionLimit({ population_companion_limit: 12 }), 11);
	assert.equal(companionLimit({ population_companion_limit: 99 }), 11);
});

// Every key the server reads for the feature, one per line, so battle_conf.txt
// stays parseable no matter what the window sends.
test('every population key is written on its own line', () => {
	const text = lines({ population_enable: true, population_max: 1500, population_density: 200, population_companion_limit: 9 });
	const keys = ['population_engine_enable', 'population_engine_max_count', 'population_engine_density_pct', 'population_engine_companion_limit', 'population_engine_vending_enable'];
	for (const key of keys) assert.match(text, new RegExp(`^${key}: \\d+$`, 'm'), key);
});

test('the companion limit is written even while the engine is off', () => {
	// Turning it on later must not silently use a stale cap: the count always
	// lands in battle_conf.txt so the server never runs one configuration
	// while the window shows another.
	const text = lines({ population_enable: false, population_max: 1500, population_density: 100, population_companion_limit: 7 });
	assert.match(text, /^population_engine_companion_limit: 7$/m);
});

test('neighbouring keys keep their own clamps', () => {
	const text = lines({ population_enable: true, population_max: 0, population_density: 900, population_companion_limit: 12 });
	assert.match(text, /^population_engine_max_count: 1$/m);   // rAthena refuses 0; the flag alone means off
	assert.match(text, /^population_engine_density_pct: 500$/m);
	assert.match(text, /^population_engine_companion_limit: 11$/m);
});
