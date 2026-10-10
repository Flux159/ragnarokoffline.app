'use strict';
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'setup.html'), 'utf8');
const KEYS = html.match(/const KEYS = (\[[^\]]*\]);/)[1];
const fn = html.match(/function takeFolder\(paths, found\) \{[\s\S]*?\r?\n\}\r?\n/);
assert.ok(fn, 'takeFolder is defined in setup.html');
const takeFolder = new Function(`const KEYS = ${KEYS}; ${fn[0]} return takeFolder;`)();

// #392: switching from kRO to iRO through "Choose a folder" kept kRO's
// rdata.grf, because only the files the new folder had were replaced.
test('a folder replaces every path, clearing the ones it lacks', () => {
	const paths = {
		data_grf: '/kro/data.grf', rdata_grf: '/kro/rdata.grf',
		official_grf: '/kro/optional_data.grf', bgm_dir: '/kro/BGM',
	};
	const n = takeFolder(paths, {
		data_grf: '/iro/data.grf', rdata_grf: '', official_grf: '/iro/event.grf', bgm_dir: '/iro/BGM',
	});
	assert.equal(n, 3);
	assert.deepStrictEqual(paths, {
		data_grf: '/iro/data.grf', rdata_grf: '',
		official_grf: '/iro/event.grf', bgm_dir: '/iro/BGM',
	});
});

test('a folder with no game files changes nothing', () => {
	const paths = { data_grf: '/kro/data.grf', rdata_grf: '/kro/rdata.grf', official_grf: '', bgm_dir: '' };
	const before = { ...paths };
	assert.equal(takeFolder(paths, { data_grf: '', rdata_grf: '', official_grf: '', bgm_dir: '' }), 0);
	assert.deepStrictEqual(paths, before);
});

// The fallback GRF is another client's, so a new client folder keeps it.
test('a folder leaves the fallback GRF alone', () => {
	const paths = { data_grf: '/kro/data.grf', rdata_grf: '', official_grf: '', bgm_dir: '', fallback_grf: '/iro/data.grf' };
	takeFolder(paths, { data_grf: '/bro/data.grf', rdata_grf: '', official_grf: '', bgm_dir: '' });
	assert.equal(paths.fallback_grf, '/iro/data.grf');
});

test('the folder button goes through takeFolder', () => {
	assert.match(html, /const n = takeFolder\(paths, found\);/);
});
