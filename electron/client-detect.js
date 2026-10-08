'use strict';
// Which client the player's GRFs come from: kRO, iRO, bRO...
//
// Mods can be written for one client's data (an iteminfo.lua made for kRO's
// item tables overwrites iRO's), so mod.json can say which clients a mod is
// for (`requires.client`) and give each one a folder (`clientFolders`). The
// supervisor reads the answer from state/client-detected.json, written here
// each time the client is indexed.
//
// The service is in the file names: every client ships its message table as
// `msgstring_<service>.lub` -- msgstring_kr.lub in kRO's data.grf,
// msgstring_us.lub in iRO's. The GRF's signature can't tell them apart: iRO's
// data.grf says "Event Horizon" (GRF Editor's) and its event.grf "Master of
// Magic", the same as kRO's.

const fs = require('node:fs');
const path = require('node:path');
const { grfNames } = require('./ui-skin');

// The services whose code is known. Anything else is reported by its code,
// and refuses no mod.
const SERVICES = {
	kr: 'kRO', us: 'iRO', br: 'bRO', jp: 'jRO', tw: 'twRO', th: 'thRO',
	id: 'idRO', ph: 'pRO', ru: 'ruRO', cn: 'cRO', vn: 'vRO',
};

const MSGSTRING = /(?:^|\\)msgstring_([a-z]{2,4})\.lub$/i;

/** The service codes a GRF's file names point to, most common first. */
function serviceCodes(names) {
	const counts = new Map();
	for (const name of names) {
		const m = MSGSTRING.exec(name);
		if (m) counts.set(m[1].toLowerCase(), (counts.get(m[1].toLowerCase()) || 0) + 1);
	}
	return [...counts].sort((a, b) => b[1] - a[1]).map(([code]) => code);
}

/**
 * The client, from the GRFs in the order the client reads them: data.grf
 * decides, then the others if it says nothing. `read(file)` lists a GRF's
 * names (grfNames; a parameter for the tests).
 */
function detectClient(paths, read = grfNames) {
	const order = [['data.grf', paths.data_grf], ['rdata.grf', paths.rdata_grf], ['official_data.grf', paths.official_grf]];
	const problems = [];
	for (const [label, file] of order) {
		if (!file) continue;
		let names;
		try { names = read(file); } catch (e) { problems.push(`${label}: ${e.message}`); continue; }
		const [code] = serviceCodes(names);
		if (code) return { client: SERVICES[code] || null, code, from: label, problems };
	}
	return { client: null, code: null, from: null, problems };
}

/**
 * Detect, and record it for the supervisor and Settings. Skipped when the
 * GRFs are the ones already detected (same paths, sizes and times): reading a
 * data.grf's table takes a moment, and this runs on every start.
 */
function detectAndSave(stateDir, paths, log = () => {}, fallbackOf = detectFallback) {
	const file = path.join(stateDir, 'client-detected.json');
	const stampOf = keys => keys.map(k => {
		if (!paths[k]) return `${k}:`;
		try { const st = fs.statSync(paths[k]); return `${k}:${paths[k]}:${st.size}:${st.mtimeMs}`; } catch { return `${k}:${paths[k]}:missing`; }
	}).join('|');
	const stamp = stampOf(['data_grf', 'rdata_grf', 'official_grf']);
	// The fallback GRF is another client's: named in Settings and the
	// diagnostics, never what mods are checked against. Stamped on its own,
	// so picking one does not read data.grf again.
	const fallbackStamp = stampOf(['fallback_grf']);
	let saved = null;
	try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none yet */ }
	const sameMain = saved && saved.stamp === stamp;
	if (sameMain && 'date' in saved && (saved.fallbackStamp || 'fallback_grf:') === fallbackStamp) return saved;
	const found = sameMain ? null : detectClient(paths);
	const out = found ? { client: found.client, code: found.code, from: found.from, stamp } : { client: saved.client, code: saved.code, from: saved.from, stamp };
	// The date of the GRF the answer came from; a detection saved before
	// dates were kept gets one without reading the GRF again.
	const fromKey = { 'data.grf': 'data_grf', 'rdata.grf': 'rdata_grf', 'official_data.grf': 'official_grf' }[out.from];
	out.date = fileDate(fromKey ? paths[fromKey] : paths.data_grf);
	out.fallbackStamp = fallbackStamp;
	if (paths.fallback_grf) {
		out.fallback = fallbackOf(paths.fallback_grf);
		log(`client: fallback GRF ${paths.fallback_grf} is ${describeFallback(out.fallback)}`);
	}
	fs.mkdirSync(stateDir, { recursive: true });
	fs.writeFileSync(file, JSON.stringify(out, null, 1) + '\n');
	if (found) {
		log(found.client
			? `client: ${found.client} (msgstring_${found.code}.lub in ${found.from})`
			: found.code
				? `client: unknown service "${found.code}" (msgstring_${found.code}.lub in ${found.from}); mods for one client are not refused`
				: `client: could not tell which client this is${found.problems.length ? ` (${found.problems.join('; ')})` : ''}; mods for one client are not refused`);
	}
	return out;
}

/**
 * A GRF's date: when its files were last patched, on the player's own
 * calendar, as Explorer shows it. `mtime` is a parameter for the tests.
 */
function fileDate(file, mtime = f => fs.statSync(f).mtime) {
	if (!file) return null;
	try {
		const t = mtime(file);
		return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
	} catch { return null; }
}

/**
 * Which client a fallback GRF is from, and its date: { client, code, from,
 * date }, `from` being the file's name only (a full path can be long).
 * `read` and `mtime` are parameters for the tests.
 */
function detectFallback(file, read = grfNames, mtime) {
	let code = null;
	try { [code = null] = serviceCodes(read(file)); } catch { /* unreadable: no service */ }
	return { client: code ? SERVICES[code] || null : null, code, from: path.basename(file), date: fileDate(file, mtime) };
}

/** "iRO (from data.grf) · files 2026-10-07", for the main client and the fallback alike. */
function describeOne(d) {
	const who = d.client ? `${d.client} (from ${d.from})`
		: d.code ? `unknown service "${d.code}" (from ${d.from})`
			: d.from ? `unknown client (${d.from})` : 'not detected';
	return d.date ? `${who} · files ${d.date}` : who;
}
const describeFallback = describeOne;

/** What Settings and the diagnostics show; `fallback` is a text or null. */
function describe(stateDir) {
	try {
		const d = JSON.parse(fs.readFileSync(path.join(stateDir, 'client-detected.json'), 'utf8'));
		const fallback = d.fallback ? describeOne(d.fallback) : null;
		const text = d.client || d.code ? describeOne(d) : 'not detected';
		return { client: d.client || null, code: d.code || null, from: d.from || null, date: d.date || null, text, fallback };
	} catch { /* not detected yet */ }
	return { client: null, code: null, from: null, date: null, text: 'not detected', fallback: null };
}

module.exports = { detectClient, detectAndSave, detectFallback, describe, describeFallback, fileDate, serviceCodes, SERVICES };
