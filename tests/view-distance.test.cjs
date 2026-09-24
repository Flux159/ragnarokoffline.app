'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { viewDistanceConf, PRESETS } = require('../electron/view-distance');

const parse = text => Object.fromEntries(
	text.trim().split('\n').map(line => line.split(': ').map(part => part.trim())));

// An install that never opens this setting must write what rAthena ships in
// conf/battle/client.conf and monster.conf, so upgrading changes nothing.
test('an untouched install writes rAthena\'s own defaults', () => {
	assert.deepEqual(parse(viewDistanceConf({})), {
		area_size: '14',
		max_walk_path: '17',
		view_range_rate: '100',
		chase_range_rate: '100',
	});
});

test('a damaged or unknown preset falls back to the defaults', () => {
	for (const view_distance of ['huge', '', 28, null, 'constructor', '__proto__']) {
		assert.deepEqual(parse(viewDistanceConf({ view_distance })), parse(viewDistanceConf({})), String(view_distance));
	}
});

// The four only work together: a view past monster sight hits monsters that
// never react, and a view past the walk limit shows ground a click cannot reach.
test('every preset writes all four keys, and none shrinks what official gives', () => {
	for (const [name, values] of Object.entries(PRESETS)) {
		const conf = parse(viewDistanceConf({ view_distance: name }));
		assert.deepEqual(Object.keys(conf).sort(),
			['area_size', 'chase_range_rate', 'max_walk_path', 'view_range_rate'], name);
		for (const [key, stock] of Object.entries(PRESETS.official)) {
			assert.ok(values[key] >= stock, `${name} ${key}`);
		}
	}
});

// rAthena refuses max_walk_path above MAX_WALKPATH and falls back to 17, which
// would look like the setting doing nothing.
test('no preset asks for a walk the server would refuse', () => {
	for (const [name, values] of Object.entries(PRESETS)) {
		assert.ok(values.max_walk_path <= 32, name);
	}
});

// The Settings window cannot load the module, so it carries its own copy of
// the numbers in the text under the picker. Checked here so a preset change
// cannot leave the window describing the old one.
test('the Settings window describes each preset with its real numbers', () => {
	const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/settings.html'), 'utf8');
	for (const [name, v] of Object.entries(PRESETS)) {
		const line = html.match(new RegExp(`^\\s*${name}: '([^']*)'`, 'm'));
		assert.ok(line, `no description for ${name}`);
		assert.match(line[1], new RegExp(`see ${v.area_size} cells`), name);
		assert.match(line[1], new RegExp(`walks up to ${v.max_walk_path}\\b`), name);
		assert.match(html, new RegExp(`<option value="${name}">[^<]*${v.area_size} cells, walk ${v.max_walk_path}<`), name);
		const rate = v.view_range_rate === 100 ? 'normal range' : `${v.view_range_rate / 100}x as far`;
		assert.ok(line[1].includes(rate), `${name}: ${rate}`);
		assert.equal(v.view_range_rate, v.chase_range_rate, `${name}: one number describes both`);
	}
});
