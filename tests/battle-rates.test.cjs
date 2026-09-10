'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { dropRateConf } = require('../electron/battle-rates');

const settings = { item_rate_common: 400, item_rate_equip: 1000, item_rate_card: 1500 };
const parse = text => Object.fromEntries(
	text.trim().split('\n').map(line => line.split(': ').map(part => part.trim())));

// The reported bug: sliders worked on ordinary monsters, half-worked on bosses
// and did nothing at all on MVPs, because those are three separate key
// families in rAthena and only part of two were written.
test('every category is set for ordinary monsters, bosses and MVPs', () => {
	const conf = parse(dropRateConf(settings));
	for (const family of ['', '_boss', '_mvp']) {
		assert.equal(conf[`item_rate_common${family}`], '400', `common${family}`);
		assert.equal(conf[`item_rate_heal${family}`], '400', `heal${family}`);
		assert.equal(conf[`item_rate_use${family}`], '400', `use${family}`);
		assert.equal(conf[`item_rate_equip${family}`], '1000', `equip${family}`);
		assert.equal(conf[`item_rate_card${family}`], '1500', `card${family}`);
	}
	assert.equal(Object.keys(conf).length, 15, 'five categories across three families');
});

// Each of the three sliders reaches every family. A slider that only moved
// ordinary monsters is the shape of the original bug.
test('each slider moves independently and reaches all three families', () => {
	const conf = parse(dropRateConf({ item_rate_common: 100, item_rate_equip: 2500, item_rate_card: 700 }));
	const at = rate => Object.entries(conf).filter(([, v]) => v === rate).map(([k]) => k).sort();
	assert.deepEqual(at('2500'), ['item_rate_equip', 'item_rate_equip_boss', 'item_rate_equip_mvp']);
	assert.deepEqual(at('700'), ['item_rate_card', 'item_rate_card_boss', 'item_rate_card_mvp']);
	assert.equal(at('100').length, 9, 'common, heal and use across three families');
});

// These are set by the caller from the item slider, or not at all. Emitting
// them here would write each one twice into the same generated file.
test('the reward, treasure and equip-granted keys are left to the caller', () => {
	const conf = dropRateConf(settings);
	for (const key of ['item_rate_mvp:', 'item_rate_treasure:', 'item_rate_adddrop:']) {
		assert.equal(conf.includes(key), false, `${key} must not be emitted here`);
	}
});

// `item_rate_mvp` is a real key, so a naive "starts with" check would collide
// with the MVP family and silently drop it back to the default.
test('the MVP family is suffixed, never confused with the MVP reward key', () => {
	const conf = parse(dropRateConf(settings));
	assert.equal('item_rate_mvp' in conf, false);
	assert.equal(conf.item_rate_common_mvp, '400');
});

test('output is one key per line and parses as battle conf', () => {
	const text = dropRateConf(settings);
	assert.ok(text.endsWith('\n'), 'trailing newline, so the caller can concatenate');
	for (const line of text.trim().split('\n')) {
		assert.match(line, /^item_rate_[a-z]+(_boss|_mvp)?: \d+$/);
	}
});
