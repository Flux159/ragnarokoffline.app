'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const skin = require('../electron/ui-skin');

const UI = skin.UI_DIR;
const tmp = tag => fs.mkdtempSync(path.join(os.tmpdir(), `ro-skin-${tag}-`));

// A GRF with nothing in it but a file table: the importer reads names only.
function fakeGrf(file, names, version = 0x200) {
	const tail = version === 0x300 ? 21 : 17;
	const entries = Buffer.concat(names.map(({ name, dir }) => {
		const meta = Buffer.alloc(tail);
		meta[12] = dir ? 0 : 1;
		return Buffer.concat([Buffer.from(name, 'latin1'), Buffer.from([0]), meta]);
	}));
	const packed = zlib.deflateSync(entries);
	const sizes = Buffer.alloc(8);
	sizes.writeUInt32LE(packed.length, 0);
	sizes.writeUInt32LE(entries.length, 4);
	const header = Buffer.alloc(46);
	header.write('Master of Magic', 0, 'latin1');
	if (version === 0x300) {
		header.writeUInt32LE(0, 30);
		header.writeUInt32LE(0, 34);
		header.writeUInt32LE(names.length, 38);
	} else {
		header.writeUInt32LE(0, 30);
		header.writeUInt32LE(0, 34);
		header.writeUInt32LE(names.length + 7, 38);
	}
	header.writeUInt32LE(version, 42);
	const lead = version === 0x300 ? Buffer.alloc(4) : Buffer.alloc(0);
	fs.writeFileSync(file, Buffer.concat([header, lead, sizes, packed]));
}

const ui = rel => ({ name: `data\\texture\\${UI}\\${rel.replace(/\//g, '\\')}` });
// È¸º¹a.bmp: a Korean file name, as CP949 read as Latin-1.
const KOREAN = Buffer.from([0xc8, 0xb8, 0xba, 0xb9]).toString('latin1') + 'a.bmp';
const GRF_NAMES = [
	ui('titlebar_mid.bmp'),
	ui('btn_ok.bmp'),
	ui('esc_07a.bmp'),
	ui('basic_interface/itemwin_mid.bmp'),
	ui('basic_interface/btn_close.bmp'),
	ui(`basic_interface/${KOREAN}`),
	ui('login_interface/login_btn.bmp'),
	ui('cashshop/tab.bmp'),
	ui('cashshop/twice.bmp'),
	ui('mapwin/twice.bmp'),
	{ name: `data\\texture\\${UI}\\basic_interface`, dir: true },
	{ name: 'data\\sprite\\cursors.spr' },
];

function grfIndex(version) {
	const dir = tmp('grf');
	const file = path.join(dir, 'data.grf');
	fakeGrf(file, GRF_NAMES, version);
	return skin.uiIndex([file, '']);
}

test('the GRF file table is read for both layouts, files only', () => {
	for (const version of [0x200, 0x300]) {
		const dir = tmp('names');
		const file = path.join(dir, 'x.grf');
		fakeGrf(file, GRF_NAMES, version);
		const names = skin.grfNames(file);
		assert.strictEqual(names.length, GRF_NAMES.length - 1, `0x${version.toString(16)}`);
		assert.ok(!names.some(n => n.endsWith('basic_interface')), 'a directory entry is not a file');
		const { index, problems } = grfIndex(version);
		assert.deepStrictEqual(problems, []);
		assert.strictEqual(index.get('basic_interface/itemwin_mid.bmp'), 'basic_interface/itemwin_mid.bmp');
		assert.ok(!index.has('cursors.spr'), 'only the interface folder is indexed');
	}
});

test('an archive that is not a GRF is reported, not thrown', () => {
	const dir = tmp('bad');
	fs.writeFileSync(path.join(dir, 'x.grf'), 'not a grf at all, but long enough to have a header.......');
	const { index, problems } = skin.uiIndex([path.join(dir, 'x.grf')]);
	assert.strictEqual(index.size, 0);
	assert.match(problems[0], /not a GRF/);
});

test('each picture goes where the GRF has it: own path, then the root, then the usual subfolders', () => {
	const { index } = grfIndex();
	const plan = skin.planSkin([
		'titlebar_mid.bmp',                  // root, at the root
		'ESC_07A.BMP',                       // case differs from the GRF
		'basic_interface/itemwin_mid.bmp',   // subfolder, in place
		'itemwin_mid.bmp',                   // flattened: but basic_interface/ already has it
		'btn_close.bmp',                     // flattened, only in basic_interface/
		'login_btn.bmp',                     // flattened, only in login_interface/
		'tab.bmp',                           // flattened, in exactly one other folder
		'twice.bmp',                         // flattened, in two folders: no guess
		'btn_vip.bmp',                       // a newer client's button
		`basic_interface/${KOREAN.normalize('NFD')}`, // decomposed by the filesystem
		'option/sysbox/btn_ok.bmp',          // the official client's per-skin choices
		'readme.txt', '.DS_Store', 'Thumbs.db',
	], index);
	const to = Object.fromEntries(plan.placed.map(p => [p.from.normalize('NFC'), p.to]));
	assert.deepStrictEqual(to, {
		'titlebar_mid.bmp': 'titlebar_mid.bmp',
		'ESC_07A.BMP': 'esc_07a.bmp',
		'basic_interface/itemwin_mid.bmp': 'basic_interface/itemwin_mid.bmp',
		'btn_close.bmp': 'basic_interface/btn_close.bmp',
		'login_btn.bmp': 'login_interface/login_btn.bmp',
		'tab.bmp': 'cashshop/tab.bmp',
		[`basic_interface/${KOREAN}`]: `basic_interface/${KOREAN}`,
	});
	assert.deepStrictEqual(plan.unplaced.map(u => [u.file, u.reason]), [
		['itemwin_mid.bmp', 'same file as basic_interface/itemwin_mid.bmp'],
		['twice.bmp', 'in 2 folders of your GRF; could not tell which'],
		['btn_vip.bmp', 'not in your GRF'],
	]);
	assert.deepStrictEqual(plan.options, ['option/sysbox/btn_ok.bmp']);
	assert.deepStrictEqual(plan.skipped.sort(), ['.DS_Store', 'Thumbs.db', 'readme.txt']);
	assert.strictEqual(plan.checked, true);
});

test('with no GRF to check against, every picture keeps its own path', () => {
	const plan = skin.planSkin(['a.bmp', 'basic_interface/b.bmp'], new Map());
	assert.deepStrictEqual(plan.placed.map(p => p.to), ['a.bmp', 'basic_interface/b.bmp']);
	assert.strictEqual(plan.checked, false);
});

function skinFolder(files) {
	const dir = path.join(tmp('src'), 'Clear Blue');
	for (const [rel, body] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
		fs.writeFileSync(path.join(dir, rel), body);
	}
	return dir;
}

test('a skin becomes a mod of kind skin, overlaying data/texture/ui/', () => {
	const { index } = grfIndex();
	const src = skinFolder({ 'titlebar_mid.bmp': 'T', 'btn_close.bmp': 'C', 'btn_vip.bmp': 'V' });
	const mods = tmp('mods');
	const result = skin.buildSkinMod({ srcRoot: src, modsDir: mods, display: 'Clear Blue', index, appVersion: '1.4.0', source: src });
	assert.strictEqual(result.name, 'skin-clear-blue');
	const dir = path.join(mods, 'skin-clear-blue');
	assert.strictEqual(fs.readFileSync(path.join(dir, 'data/texture/ui/titlebar_mid.bmp'), 'utf8'), 'T');
	assert.strictEqual(fs.readFileSync(path.join(dir, 'data/texture/ui/basic_interface/btn_close.bmp'), 'utf8'), 'C');
	assert.ok(!fs.existsSync(path.join(dir, 'data/texture/ui/btn_vip.bmp')), 'an unplaced file is left out');
	const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'mod.json'), 'utf8'));
	assert.strictEqual(manifest.kind, 'skin');
	assert.deepStrictEqual(manifest.requires, { app: '>=1.4.0', era: 'any' });
	assert.ok(!fs.existsSync(path.join(dir, 'client')), 'a skin without a cursor ships no code');
	assert.match(fs.readFileSync(path.join(dir, 'skin-import.txt'), 'utf8'), /btn_vip\.bmp \(not in your GRF\)/);
	assert.match(skin.summary(result), /2 of 3 interface pictures placed.*Not placed: btn_vip\.bmp/);
	assert.deepStrictEqual(fs.readdirSync(mods), ['skin-clear-blue'], 'no staging folder is left behind');

	assert.throws(() => skin.buildSkinMod({ srcRoot: src, modsDir: mods, display: 'Clear Blue', index }), /already installed/);
});

test('a cursor pack becomes a cursor mod that keeps the official cursor on', () => {
	const { index } = grfIndex();
	const src = skinFolder({ 'cursor7/cursors.spr': 'S', 'cursor7/cursors.act': 'A', 'cursor7/Uploaded by Katchan.txt': 'hi' });
	const mods = tmp('mods');
	const result = skin.buildSkinMod({ srcRoot: skin.skinRoot(src), modsDir: mods, display: 'red_cursor', index });
	assert.strictEqual(result.name, 'cursor-red-cursor');
	const dir = path.join(mods, result.name);
	assert.strictEqual(fs.readFileSync(path.join(dir, 'data/sprite/cursors.spr'), 'utf8'), 'S');
	assert.strictEqual(fs.readFileSync(path.join(dir, 'data/sprite/cursors.act'), 'utf8'), 'A');
	const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'mod.json'), 'utf8'));
	assert.strictEqual(manifest.kind, 'cursor');
	assert.strictEqual(manifest.settings[0].key, 'official_cursor');
	assert.strictEqual(fs.readFileSync(path.join(dir, 'client/index.js'), 'utf8'), skin.CURSOR_PLUGIN);
	assert.match(skin.summary(result), /Show official cursor/);
});

test('the cursor plugin turns the option on once, and only when it was off', async () => {
	const url = 'data:text/javascript;base64,' + Buffer.from(skin.CURSOR_PLUGIN).toString('base64');
	const { default: init } = await import(url);
	const store = () => {
		const m = new Map();
		return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m };
	};
	let reloads = 0;
	globalThis.location = { reload: () => { reloads++; } };
	const run = (graphics, parameters = {}) => {
		globalThis.localStorage = store();
		globalThis.sessionStorage = store();
		if (graphics) localStorage.setItem('Graphics', JSON.stringify(graphics));
		init(parameters);
		return JSON.parse(localStorage.getItem('Graphics') || 'null');
	};
	try {
		assert.strictEqual(run({ cursor: false, _version: 1.1 }).cursor, true);
		assert.strictEqual(reloads, 1);
		init({}); // the reloaded page: already on, nothing to do
		assert.strictEqual(reloads, 1);
		assert.strictEqual(run({ cursor: true }).cursor, true);
		assert.strictEqual(run(null), null, 'never saved: the client default (on) stands');
		assert.strictEqual(run({ cursor: false }, { official_cursor: false }).cursor, false, 'the player said to leave it');
		assert.strictEqual(reloads, 1);
	} finally {
		delete globalThis.location; delete globalThis.localStorage; delete globalThis.sessionStorage;
	}
});

test('a folder with nothing a skin would have is refused with the reason', () => {
	const { index } = grfIndex();
	const src = skinFolder({ 'notes.txt': 'x', 'mystery.bmp': 'y' });
	assert.throws(
		() => skin.buildSkinMod({ srcRoot: src, modsDir: tmp('mods'), display: 'x', index }),
		/none of its 1 pictures match/,
	);
});

test('a zip of Name/Name/ is read from the inner folder', () => {
	const outer = tmp('nest');
	fs.mkdirSync(path.join(outer, 'Skin', 'Skin'), { recursive: true });
	fs.mkdirSync(path.join(outer, '__MACOSX'));
	fs.writeFileSync(path.join(outer, 'Skin', 'Skin', 'a.bmp'), '');
	assert.strictEqual(skin.skinRoot(outer), path.join(outer, 'Skin', 'Skin'));
});

test('mod names are plain and stable', () => {
	assert.strictEqual(skin.modName('skin', 'Clear Blue'), 'skin-clear-blue');
	assert.strictEqual(skin.modName('skin', 'Fairy\'s Dawn!'), 'skin-fairy-s-dawn');
	assert.strictEqual(skin.modName('skin', '한글'), 'skin-imported');
	assert.strictEqual(skin.modName('cursor', '../../etc'), 'cursor-etc');
});
