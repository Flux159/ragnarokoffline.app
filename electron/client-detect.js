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
	if (sameMain && (saved.fallbackStamp || 'fallback_grf:') === fallbackStamp) return saved;
	const found = sameMain ? null : detectClient(paths);
	const out = found ? { client: found.client, code: found.code, from: found.from, stamp } : { client: saved.client, code: saved.code, from: saved.from, stamp };
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

// Where the publisher dates its executable, that is the client's build
// (kRO's 2026-02-19_Ragexe_1770960005.exe); otherwise the GRF's own date,
// which is when its files were last patched.
const DATED_EXE = /^(\d{4})-?(\d{2})-?(\d{2})_?ragexe[^\\/]*\.exe$/i;

/**
 * Which client a fallback GRF is from, and how old:
 * { client, code, date, dateFrom: 'client' | 'files' }. `read`, `list` and
 * `mtime` are parameters for the tests.
 */
function detectFallback(file, read = grfNames, list = dir => fs.readdirSync(dir), mtime = f => fs.statSync(f).mtime) {
	let code = null;
	try { [code = null] = serviceCodes(read(file)); } catch { /* unreadable: no service */ }
	let date = null, dateFrom = null;
	try {
		const dated = list(path.dirname(file)).map(n => DATED_EXE.exec(n)).filter(Boolean)
			.map(m => `${m[1]}-${m[2]}-${m[3]}`).sort();
		if (dated.length) { date = dated[dated.length - 1]; dateFrom = 'client'; }
	} catch { /* folder not listable */ }
	if (!date) {
		try {
			// The player's own calendar day, as Explorer shows the file.
			const t = mtime(file);
			date = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
			dateFrom = 'files';
		} catch { /* gone */ }
	}
	return { client: code ? SERVICES[code] || null : null, code, date, dateFrom };
}

/** "kRO, client 2026-02-19" or "iRO, files from 2026-10-07". */
function describeFallback(f) {
	const who = f.client || (f.code ? `unknown service "${f.code}"` : 'unknown client');
	if (!f.date) return who;
	return `${who}, ${f.dateFrom === 'client' ? 'client' : 'files from'} ${f.date}`;
}

/** What Settings and the diagnostics show; `fallback` is a text or null. */
function describe(stateDir) {
	try {
		const d = JSON.parse(fs.readFileSync(path.join(stateDir, 'client-detected.json'), 'utf8'));
		const fallback = d.fallback ? describeFallback(d.fallback) : null;
		if (d.client) return { client: d.client, code: d.code, from: d.from, text: `${d.client} (from ${d.from})`, fallback };
		if (d.code) return { client: null, code: d.code, from: d.from, text: `unknown service "${d.code}" (from ${d.from})`, fallback };
		return { client: null, code: null, from: null, text: 'not detected', fallback };
	} catch { /* not detected yet */ }
	return { client: null, code: null, from: null, text: 'not detected', fallback: null };
}

module.exports = { detectClient, detectAndSave, detectFallback, describe, describeFallback, serviceCodes, SERVICES };
