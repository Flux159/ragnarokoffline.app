'use strict';
// The Tools windows read the client's own tables, mods' included (#195 left
// them reading the base table only). These check the two readers against a
// served asset root laid out the way `link-assets` leaves it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { clientItemInfo, clientMonsterSprites } = require('../electron/tools.js');

function world(files) {
	const web = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-tools-'));
	for (const [rel, body] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(web, rel)), { recursive: true });
		fs.writeFileSync(path.join(web, rel), body);
	}
	return web;
}

const item = (id, name) => `[${id}] = { identifiedDisplayName = "${name}", identifiedResourceName = "x" },\n`;

test('item tables are joined base first, so a later mod wins as it does in game', () => {
	const web = world({
		'Config.local.js': "window.ROConfigLocal = {\n\tcustomItemInfo: ['System/itemInfo-b.lua', 'System/itemInfo-a.lua', 'System/itemInfo.lua'],\n};\n",
		'System/itemInfo.lua': 'tbl = {\n' + item(501, 'Red Potion') + item(502, 'Orange Potion') + '}',
		'System/itemInfo-a.lua': 'tbl = {\n' + item(30001, 'Islander Brew') + item(502, 'A renamed it') + '}',
		'System/itemInfo-b.lua': 'tbl = {\n' + item(502, 'B renamed it last') + '}',
	});
	const text = clientItemInfo(web).toString('utf8');
	const last = {};
	for (const m of text.matchAll(/\[(\d+)\] = \{ identifiedDisplayName = "([^"]+)"/g)) last[m[1]] = m[2];
	assert.equal(last[501], 'Red Potion');
	assert.equal(last[30001], 'Islander Brew', 'a new item from a mod is there');
	assert.equal(last[502], 'B renamed it last', 'the client takes b first, so b must parse last');
});

test('a CP949 base and a UTF-8 mod table both come out readable', () => {
	const korean = Buffer.from([0xbb, 0xa1, 0xb0, 0xa3]); // 빨간 in CP949
	const web = world({
		'Config.local.js': "customItemInfo: ['System/itemInfo-m.lua', 'System/itemInfo.lua'],\n",
		'System/itemInfo.lua': Buffer.concat([Buffer.from('[501] = { identifiedResourceName = "'), korean, Buffer.from('" },')]),
		'System/itemInfo-m.lua': '[30001] = { identifiedResourceName = "빨간포션" },',
	});
	const text = clientItemInfo(web).toString('utf8');
	assert.match(text, /\[501\] = \{ identifiedResourceName = "빨간" \}/);
	assert.match(text, /빨간포션/);
});

test('with no mod item tables, the first base table the client would read', () => {
	const web = world({ 'Config.local.js': '{}', 'System/itemInfo_true.lub': '[1] = {}', 'System/itemInfo.lub': '[2] = {}' });
	assert.equal(clientItemInfo(web).toString('utf8'), '[2] = {}');
	assert.throws(() => clientItemInfo(world({})), /Start the game once/);
});

test("mods' monster sprites come from their npcidentity/jobname pairs, later mods winning", () => {
	const web = world({
		'Config.local.js': "\tcustomLuaTables: { accessory: [['System/ids-none-accessory-a.lua', 'System/accname-a.lua']], monster: [['System/npcidentity-a.lub', 'System/jobname-a.lub'], ['System/ids-none-monster-b.lua', 'System/jobname-b.lua']] },\n",
		'System/npcidentity-a.lub': 'jobtbl.JT_MY_MOB = 31001\njobtbl.JT_OTHER = 31002\n',
		'System/jobname-a.lub': 'JobNameTable = {\n\t[jobtbl.JT_MY_MOB] = "MY_MOB",\n\t[jobtbl.JT_OTHER] = "OTHER",\n}\n',
		'System/ids-none-accessory-a.lua': '',
		'System/ids-none-monster-b.lua': '',
		'System/jobname-b.lua': 'JobNameTable = { [31002] = "B_OTHER" }',
	});
	assert.deepEqual(clientMonsterSprites(web), { 31001: 'MY_MOB', 31002: 'B_OTHER' });
	assert.deepEqual(clientMonsterSprites(world({ 'Config.local.js': '{}' })), {});
});
