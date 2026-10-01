'use strict';
//
// Turning an official-client UI skin into a mod.
//
// The official client reads a skin from `skin/<name>/`, laid out exactly like
// `data/texture/유저인터페이스/`: the bulk of it flat at the root, the rest in
// the same subfolders the GRF uses (basic_interface/, login_interface/, ...).
// roBrowser draws its windows from that GRF folder, so a skin is a mod whose
// data/ overlays it -- written as `data/texture/ui/`, which the supervisor
// translates to the client's CP949 spelling as it lays the mod down.
//
// The one thing a skin folder does not say is where each file goes when its
// author flattened it, or when it comes from an older client than the GRF. So
// every file is placed against the GRF's own list of names under that folder,
// read straight out of the archive's file table: its own path first, then the
// root, then the subfolders most skins draw from. Whatever matches nothing is
// left out and reported -- a file the client never asks for would sit in the
// overlay looking like part of the skin and do nothing.
//
// A pack carrying `cursors.spr` + `cursors.act` (the "official cursor"
// sprite) becomes a cursor mod instead, or rides along with the skin.
//
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

// 유저인터페이스 in CP949, read as Latin-1 -- the spelling every tool in the
// chain uses on disk and in URLs, and the one a skin's own Korean-named
// files arrive in.
const UI_DIR = Buffer.from([0xc0, 0xaf, 0xc0, 0xfa, 0xc0, 0xce, 0xc5, 0xcd, 0xc6, 0xe4, 0xc0, 0xcc, 0xbd, 0xba]).toString('latin1');
const UI_PREFIX = `data\\texture\\${UI_DIR}\\`;

// Where a flattened file most likely came from, after the root. Taken from the
// 58 skins this was written against: these two hold nearly every file that is
// not at the root.
const PREFERRED_SUBFOLDERS = ['basic_interface', 'login_interface'];

// What a skin folder carries besides its pictures. Read-me files, thumbnails
// and the like are not part of the skin and are not worth reporting.
const IMAGE_EXT = new Set(['.bmp', '.jpg', '.jpeg', '.png', '.tga', '.gif']);
const SPRITE_EXT = new Set(['.spr', '.act']);

// Lower-cases A-Z only. GRF names are CP949 read as Latin-1, and a full
// toLowerCase() would turn the À of 유저인터페이스 into à and miss.
const asciiLower = s => s.replace(/[A-Z]/g, c => c.toLowerCase());

function u32(buf, at) { return buf.readUInt32LE(at); }

// The names in one GRF, as Latin-1 strings with backslashes, files only.
//
// The layout is the one the asset server reads (src/grf.rs in
// roBrowserLegacy-RemoteClient-Rust): a 46-byte header, then a zlib-compressed
// table of NUL-terminated names each followed by 17 bytes (0x200) or 21
// (0x300). 0x1xx archives encrypt their names and are a decade older than any
// skin a player will have, so they contribute nothing rather than an error.
function grfNames(file) {
	const fd = fs.openSync(file, 'r');
	try {
		const read = (at, length) => {
			const buf = Buffer.alloc(length);
			const got = fs.readSync(fd, buf, 0, length, at);
			if (got !== length) throw new Error(`${path.basename(file)} is shorter than its header says`);
			return buf;
		};
		const header = read(0, 46);
		if (header.toString('latin1', 0, 15) !== 'Master of Magic') throw new Error(`${path.basename(file)} is not a GRF`);
		let version = u32(header, 42);
		if (version >> 8 === 0x01) return [];
		if (version !== 0x200 && version !== 0x300) throw new Error(`${path.basename(file)} is GRF version 0x${version.toString(16)}, which this does not read`);
		let tableAt, count;
		const high = u32(header, 34);
		// GRF Editor's heuristic, as the asset server applies it: an archive
		// tagged 0x300 but written with the 0x200 layout has a high word that
		// cannot be one.
		if (version === 0x300 && high >> 8 !== 0) version = 0x200;
		if (version === 0x200) {
			tableAt = u32(header, 30) + 46;
			count = u32(header, 38) - u32(header, 34) - 7;
		} else {
			tableAt = high * 2 ** 32 + u32(header, 30) + 46 + 4;
			count = u32(header, 38);
		}
		const sizes = read(tableAt, 8);
		const table = zlib.inflateSync(read(tableAt + 8, u32(sizes, 0)));
		const tail = version === 0x300 ? 21 : 17;
		const names = [];
		let p = 0;
		for (let i = 0; i < count && p < table.length; i++) {
			const end = table.indexOf(0, p);
			if (end < 0 || end + 1 + tail > table.length) break;
			const flags = table[end + 1 + 12];
			if (flags & 1) names.push(table.toString('latin1', p, end));
			p = end + 1 + tail;
		}
		return names;
	} finally {
		fs.closeSync(fd);
	}
}

// Every file under 유저인터페이스 in the given archives: lower-cased path ->
// the path as the GRF spells it, relative to that folder, with forward
// slashes. Archives that cannot be read are skipped and named in `problems`.
function uiIndex(grfs) {
	const index = new Map();
	const problems = [];
	for (const file of grfs.filter(Boolean)) {
		let names;
		try { names = grfNames(file); } catch (e) { problems.push(`${path.basename(file)}: ${e.message}`); continue; }
		const prefix = asciiLower(UI_PREFIX);
		for (const name of names) {
			if (!asciiLower(name).startsWith(prefix)) continue;
			const rel = name.slice(UI_PREFIX.length).replace(/\\/g, '/');
			const key = asciiLower(rel);
			if (rel && !index.has(key)) index.set(key, rel);
		}
	}
	return { index, problems };
}

// Every file under `root`, relative, with forward slashes, in NFC: macOS can
// hand back a decomposed È for a name that was written composed, and the GRF
// spelling is composed.
function listFiles(root) {
	const out = [];
	const walk = (dir, rel) => {
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			if (e.isSymbolicLink()) continue;
			const child = rel ? `${rel}/${e.name}` : e.name;
			if (e.isDirectory()) walk(path.join(dir, e.name), child);
			else if (e.isFile()) out.push(child);
		}
	};
	walk(root, '');
	return out.sort();
}

// A pack is often zipped as `Name/` or even `Name/Name/`: descend while the
// folder holds exactly one folder and nothing else worth having.
function skinRoot(dir) {
	for (;;) {
		const entries = fs.readdirSync(dir, { withFileTypes: true })
			.filter(e => !e.name.startsWith('.') && e.name !== '__MACOSX');
		if (entries.length === 1 && entries[0].isDirectory()) dir = path.join(dir, entries[0].name);
		else return dir;
	}
}

const isJunk = rel => rel.split('/').some(p => p.startsWith('.') || p === '__MACOSX')
	|| /^(thumbs\.db|desktop\.ini)$/i.test(path.posix.basename(rel));

// Decide where each of a skin's files goes.
//
// `files` are paths relative to the skin folder. Returns:
//   placed   [{ from, to }]  `to` relative to 유저인터페이스, in the GRF's spelling
//   unplaced [{ file, reason }]
//   options  files under option/: the official client's per-skin choices
//            (alternative bars and buttons the player picks between in its own
//            settings). roBrowser has no such setting, so they are left out.
//   cursor   [{ from, to }]  cursors.spr / cursors.act, to data/sprite/
//   skipped  everything that is not a picture or a sprite: read-me files and
//            the like, not worth reporting
//
// With an empty index -- no GRF could be read -- every picture is kept at
// its own path, which is the official convention, and `checked` is false.
function planSkin(files, index) {
	const placed = [], unplaced = [], options = [], cursor = [], skipped = [];
	const byBase = new Map();
	for (const [key, rel] of index) {
		const base = path.posix.basename(key);
		if (!byBase.has(base)) byBase.set(base, []);
		byBase.get(base).push(rel);
	}
	const checked = index.size > 0;
	const claimed = new Map();
	const later = [];

	for (const raw of files) {
		const rel = raw.normalize('NFC');
		const ext = path.posix.extname(rel).toLowerCase();
		const base = asciiLower(path.posix.basename(rel));
		if (isJunk(rel)) { skipped.push(rel); continue; }
		if (base === 'cursors.spr' || base === 'cursors.act') { cursor.push({ from: raw, to: base }); continue; }
		if (!IMAGE_EXT.has(ext) && !SPRITE_EXT.has(ext)) { skipped.push(rel); continue; }
		if (/^option\//i.test(rel)) { options.push(rel); continue; }
		if (!checked) { placed.push({ from: raw, to: rel }); continue; }
		const exact = index.get(asciiLower(rel));
		if (exact) {
			if (claimed.has(exact)) { unplaced.push({ file: rel, reason: `same file as ${claimed.get(exact)}` }); continue; }
			claimed.set(exact, rel);
			placed.push({ from: raw, to: exact });
		} else {
			later.push({ raw, rel, base });
		}
	}

	// Second pass, so a file in its right place always beats a flattened
	// copy that a guess would send to the same spot.
	for (const { raw, rel, base } of later) {
		const candidates = byBase.get(base) || [];
		let to = index.get(base)
			|| PREFERRED_SUBFOLDERS.map(dir => candidates.find(c => asciiLower(path.posix.dirname(c)) === dir)).find(Boolean)
			|| (candidates.length === 1 ? candidates[0] : null);
		if (!to) {
			unplaced.push({ file: rel, reason: candidates.length ? `in ${candidates.length} folders of your GRF; could not tell which` : 'not in your GRF' });
		} else if (claimed.has(to)) {
			unplaced.push({ file: rel, reason: `same file as ${claimed.get(to)}` });
		} else {
			claimed.set(to, rel);
			placed.push({ from: raw, to });
		}
	}
	return { placed, unplaced, options, cursor, skipped, checked };
}

// A folder name for the mod: `skin-clear-blue` from "Clear Blue".
function modName(kind, display) {
	const slug = String(display).normalize('NFKD').toLowerCase()
		.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'imported';
	return `${kind}-${slug}`;
}

// Turns on the client's "Show official cursor" option, which a cursor pack
// needs: without it the client draws the system pointer and the pack's
// sprites are never asked for. The option lives in roBrowser's own `Graphics`
// preference, which the client reads once as it starts, so a change is saved
// and the page reloaded -- once, and only when the player had switched it
// off. The `official_cursor` setting lets them keep it off.
//
// Thanks to Clarois, whose custom-cursor mod worked out how that option
// draws the cursor sprite.
const CURSOR_PLUGIN = `// Generated by Ragnarok Offline's skin import. Keeps the client's
// "Show official cursor" option on, which this pack needs: without it the
// client draws the system pointer and never asks for cursors.spr.
// Credit: Clarois's custom-cursor mod, for how that option works.
export default function init(parameters) {
	if (parameters?.official_cursor === false) return;
	let saved;
	try { saved = JSON.parse(localStorage.getItem('Graphics') || 'null'); } catch { return; }
	if (!saved || saved.cursor !== false) return;
	// Once per session: if the write does not stick, do not reload forever.
	if (sessionStorage.getItem('ro-official-cursor')) return;
	sessionStorage.setItem('ro-official-cursor', '1');
	saved.cursor = true;
	localStorage.setItem('Graphics', JSON.stringify(saved));
	location.reload();
}
`;

const CURSOR_SETTING = {
	key: 'official_cursor',
	type: 'boolean',
	default: true,
	label: 'Turn on "Show official cursor"',
	description: 'The pack is drawn only while the game\'s Graphics option "Show official cursor" is on. Untick to manage that option yourself.',
};

// Build the mod in `modsDir` from the skin folder `srcRoot`.
//
// `display` is the skin's name as the player knows it (its folder or archive
// name). Written to a hidden staging folder and renamed into place, so a
// failure half way leaves nothing the supervisor would load.
function buildSkinMod({ srcRoot, modsDir, display, index, appVersion, source }) {
	const files = listFiles(srcRoot);
	const plan = planSkin(files, index);
	const hasCursor = ['cursors.spr', 'cursors.act'].every(n => plan.cursor.some(c => c.to === n));
	if (!plan.placed.length && !hasCursor) {
		const why = plan.unplaced.length
			? `none of its ${plan.unplaced.length} pictures match a file in your client's interface folder`
			: 'it has no .bmp pictures and no cursors.spr / cursors.act';
		throw new Error(`That does not look like a UI skin or a cursor pack: ${why}.`);
	}
	const kind = plan.placed.length ? 'skin' : 'cursor';
	const name = modName(kind, display);
	const target = path.join(modsDir, name);
	if (fs.existsSync(target)) throw new Error(`${name} is already installed. Remove it first.`);
	const stage = path.join(modsDir, `.importing-${name}`);
	fs.rmSync(stage, { recursive: true, force: true });
	try {
		for (const { from, to } of plan.placed) {
			const dst = path.join(stage, 'data', 'texture', 'ui', ...to.split('/'));
			fs.mkdirSync(path.dirname(dst), { recursive: true });
			fs.copyFileSync(path.join(srcRoot, from), dst);
		}
		if (hasCursor) {
			fs.mkdirSync(path.join(stage, 'data', 'sprite'), { recursive: true });
			for (const { from, to } of plan.cursor) fs.copyFileSync(path.join(srcRoot, from), path.join(stage, 'data', 'sprite', to));
			fs.mkdirSync(path.join(stage, 'client'), { recursive: true });
			fs.writeFileSync(path.join(stage, 'client', 'index.js'), CURSOR_PLUGIN);
		}
		const what = kind === 'skin'
			? `UI skin "${display}": ${plan.placed.length} interface pictures${hasCursor ? ' and a cursor' : ''}.`
			: `Cursor pack "${display}".`;
		const manifest = {
			name,
			version: '1.0.0',
			description: `${what} Imported from ${path.basename(source || srcRoot)}.`,
			kind,
			requires: { app: `>=${appVersion || '1.0.0'}`, era: 'any' },
		};
		if (hasCursor) manifest.settings = [CURSOR_SETTING];
		fs.writeFileSync(path.join(stage, 'mod.json'), JSON.stringify(manifest, null, 2) + '\n');
		fs.writeFileSync(path.join(stage, 'skin-import.txt'), report(display, plan, hasCursor));
		fs.renameSync(stage, target);
	} catch (e) {
		fs.rmSync(stage, { recursive: true, force: true });
		throw e;
	}
	return { name, kind, hasCursor, ...plan };
}

function report(display, plan, hasCursor) {
	const lines = [
		`Imported "${display}".`,
		plan.checked
			? `Each picture was matched against your GRF's data/texture/${'유저인터페이스'}/: its own path, then the root, then ${PREFERRED_SUBFOLDERS.join(', ')}.`
			: 'No GRF could be read to check against, so every picture was kept at its own path.',
		'',
		`placed: ${plan.placed.length}`,
	];
	for (const p of plan.placed) lines.push(p.from.normalize('NFC') === p.to ? `  ${p.to}` : `  ${p.from.normalize('NFC')} -> ${p.to}`);
	lines.push('', `not placed: ${plan.unplaced.length}`);
	for (const u of plan.unplaced) lines.push(`  ${u.file} (${u.reason})`);
	if (plan.options.length) {
		lines.push('', `left out, under option/ (the official client's per-skin choices; roBrowser has no such setting): ${plan.options.length}`);
		for (const o of plan.options) lines.push(`  ${o}`);
	}
	if (hasCursor) lines.push('', 'cursor: cursors.spr and cursors.act, to data/sprite/');
	return lines.join('\n') + '\n';
}

// One line for the Settings window.
function summary(result) {
	const parts = [];
	if (result.kind === 'skin') {
		const total = result.placed.length + result.unplaced.length;
		parts.push(`Installed ${result.name}: ${result.placed.length} of ${total} interface pictures placed.`);
		if (result.unplaced.length) {
			const shown = result.unplaced.slice(0, 6).map(u => u.file).join(', ');
			const more = result.unplaced.length > 6 ? ` and ${result.unplaced.length - 6} more` : '';
			parts.push(`Not placed: ${shown}${more} (the list is in skin-import.txt in its folder).`);
		}
		if (!result.checked) parts.push('Your GRF could not be read, so nothing was checked.');
	} else {
		parts.push(`Installed ${result.name} (a cursor pack).`);
	}
	if (result.hasCursor) parts.push('Its cursor needs the game\'s Graphics option "Show official cursor"; the mod switches that on for you.');
	return parts.join(' ');
}

module.exports = { UI_DIR, grfNames, uiIndex, listFiles, skinRoot, planSkin, modName, buildSkinMod, summary, CURSOR_PLUGIN };
