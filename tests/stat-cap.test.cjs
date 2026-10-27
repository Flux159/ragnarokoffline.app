'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// The Settings window's stat cap is one number; rAthena caps each class group
// with its own key (conf/battle/player.conf). parameterConf must write them all.
const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
const start = main.indexOf('const PARAM_STOCK = {');
const end = main.indexOf('\n}\n', main.indexOf('function parameterConf(v) {')) + 3;
const sandbox = {};
vm.runInNewContext(main.slice(start, end) + '\nthis.PARAM_STOCK = PARAM_STOCK; this.parameterConf = parameterConf;', sandbox);
const { parameterConf } = sandbox;
const conf = text => Object.fromEntries(text.trim().split('\n').map(l => l.split(': ')).map(([k, v]) => [k, Number(v)]));

// rAthena's conf/battle/player.conf on the fork.
const STOCK = {
	max_parameter: 99,
	max_trans_parameter: 99,
	max_third_parameter: 130,
	max_third_trans_parameter: 130,
	max_baby_parameter: 80,
	max_baby_third_parameter: 117,
	max_extended_parameter: 130,
	max_summoner_parameter: 130,
	max_fourth_parameter: 130,
};

test('the stock setting writes every class group at its stock cap', () => {
	assert.deepEqual(conf(parameterConf(99)), STOCK);
	assert.deepEqual(conf(parameterConf(undefined)), STOCK);
});

test('a raised cap lifts every class group, rebirth, trans third, baby third and fourth jobs too', () => {
	const raised = conf(parameterConf(255));
	assert.deepEqual(Object.keys(raised).sort(), Object.keys(STOCK).sort());
	for (const [k, v] of Object.entries(raised)) assert.equal(v, 255, k);
});

test('a cap between groups never lowers one below its stock value', () => {
	const mid = conf(parameterConf(120));
	assert.equal(mid.max_parameter, 120);
	assert.equal(mid.max_trans_parameter, 120);
	assert.equal(mid.max_baby_third_parameter, 120);
	assert.equal(mid.max_third_parameter, 130);
	assert.equal(mid.max_fourth_parameter, 130);
});
