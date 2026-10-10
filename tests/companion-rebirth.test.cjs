// windows-latest checks text files out with CRLF; normalise on read so assertions about file
// content do not depend on the checkout's newline convention.
// Guards for companion rebirth: the player's explicit choice, never automatic.
//
// WHY this exists, in one line: advancement used to take the rebirth on its own, and the gate on
// those rows asked for job 70 while a 2nd class stops at job 50 - so no companion could ever get
// past its 2nd job, and fixing the gate alone would have started stripping gear without asking.
//
// The three things pinned here are the ones that would silently regress:
//   1. the gate on the REBIRTH rows is 50 and the trans->3rd rows stay 70 (they cap at 70);
//   2. the automatic path cannot take a rebirth, and the player's path reuses the same machinery;
//   3. the panel only offers the control the server says is ready.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const ENGINE = path.join(ROOT, 'third-party', 'population-engine', 'files', 'src', 'map', 'population_engine.cpp');
const HEADER = path.join(ROOT, 'third-party', 'population-engine', 'files', 'src', 'map', 'population_engine.hpp');
const PATCH = path.join(ROOT, 'third-party', 'population-engine', 'patches', '0028-companion-rebirth.patch');
const PANEL = path.join(ROOT, 'patches', 'CompanionPanel.js');
const PANEL_HTML = path.join(ROOT, 'patches', 'CompanionPanel.html');

const engine = fs.readFileSync(ENGINE, 'utf8').replace(/\r\n/g, '\n');
const header = fs.readFileSync(HEADER, 'utf8').replace(/\r\n/g, '\n');
const panel = fs.readFileSync(PANEL, 'utf8').replace(/\r\n/g, '\n');
const html = fs.readFileSync(PANEL_HTML, 'utf8').replace(/\r\n/g, '\n');
// a patch file may be absent on the parent commit; do not crash at module load
const patch = fs.existsSync(PATCH) ? fs.readFileSync(PATCH, 'utf8').replace(/\r\n/g, '\n') : '';

function rows() {
	// every { from, to_a, to_b, base, job } literal in the table
	const out = [];
	const re = /\{ (\d+),\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d+) \}/g;
	let m;
	while ((m = re.exec(engine)) !== null) {
		out.push({ from: +m[1], toA: +m[2], toB: +m[3], base: +m[4], job: +m[5] });
	}
	return out;
}

function isRebirthRow(r) {
	return r.from >= 7 && r.from <= 20 && r.toA >= 4008 && r.toA <= 4022;
}

test('the rebirth rows gate on job 50, and only those rows changed', () => {
	const all = rows();
	const rebirth = all.filter(isRebirthRow);
	assert.equal(rebirth.length, 13, `expected the 13 2nd -> trans rows, found ${rebirth.length}`);
	for (const r of rebirth) {
		assert.equal(r.job, 50,
			`${r.from} -> ${r.toA} must gate on job 50: a 2nd class caps at 50, so 70 could never be met`);
	}
	// the rows that legitimately keep 70: entering a 3rd class from a trans one
	const trans = all.filter(r => r.from >= 4008 && r.from <= 4022 && r.toA >= 4054 && r.toA <= 4072);
	assert.ok(trans.length > 5, 'the trans -> 3rd rows must still be there');
	for (const r of trans) {
		assert.equal(r.job, 70, `${r.from} -> ${r.toA} must keep the 70 gate: that class caps at 70`);
	}
});

test('the High Novice route exists', () => {
	// High Novice rolls a high 1st job at base 40, like Novice rolls a 1st job at base 10
	assert.match(engine, /job_id == JOB_NOVICE_HIGH && base_lv >= 40/,
		'High Novice must roll into the high first jobs');
	assert.match(engine, /JOB_SWORDMAN_HIGH \+ rnd\(\) % 6/,
		'and the roll must cover the six high first jobs');
	// and each high first job reaches its transcendent class
	for (const [from, toA] of [[4002, 4008], [4003, 4010], [4004, 4012], [4005, 4009], [4006, 4011], [4007, 4013]]) {
		const hit = rows().find(r => r.from === from && r.toA === toA);
		assert.ok(hit, `high first job ${from} must advance to ${toA}`);
		// These are 1st -> 2nd steps, not rebirths, so they take the SAME gate as the plain
		// 1st -> 2nd rows: a reborn companion must not sit as a high 1st job up to base 99.
		assert.equal(hit.base, 40, `${from} -> ${toA} gates on base 40 like the other 1st -> 2nd rows`);
		assert.equal(hit.job, 0, `${from} -> ${toA} has no job gate, like the other 1st -> 2nd rows`);
	}
});

test('the automatic path can never take a rebirth', () => {
	assert.match(engine, /static bool pop_job_change_is_rebirth\(uint16_t from, uint16_t to\)/,
		'the predicate must exist');
	assert.match(engine, /if \(!allow_rebirth && pop_job_change_is_rebirth\(job_id, target\)\)/,
		'the ladder must skip a rebirth unless it is allowed');
	// the automatic caller passes allow_rebirth=false
	assert.match(engine, /pop_companion_next_job\(sd->status\.class_, sd->status\.base_level, sd->status\.job_level,\s*\n\s*\/\*allow_rebirth=\*\/false\)/,
		'the automatic path must pass false');
	// and it calls the shared change with NO forced target
	assert.match(engine, /\(void\)pop_companion_apply_job_change\(sd, 0\);/,
		'the automatic caller must not force a target');
});

test('the player\'s rebirth reuses the same machinery, with the level reset only for High Novice', () => {
	assert.match(engine, /static bool pop_companion_apply_job_change\(map_session_data \*sd, uint16_t forced_target\)/,
		'the change must be shared, not duplicated');
	assert.match(engine, /if \(next == JOB_NOVICE_HIGH\) \{\s*\n\s*pc_resetlvl\(sd, 1\);/,
		'the High Novice rebirth runs the official resetlvl(1): level, stats and status points');
	// every OTHER change (straight to transcendent, or any automatic advance) keeps its base
	// level and stats, and only the new job level starts over.
	assert.match(engine, /pc_resetlvl\(sd, 1\);\s*\n\t\} else \{\s*\n\s*sd->status\.job_level = 1;\s*\n\s*sd->status\.job_exp = 0;/,
		'a non-rebirth change resets only the job level, never the stats');
	assert.ok(!/if \(next == JOB_NOVICE_HIGH\) \{\s*\n\s*sd->status\.base_level = 1;/.test(engine),
		'hand-assigning the level kept the level-99 build; pc_resetlvl is the only reset now');
	assert.match(engine, /int population_engine_companion_rebirth\(uint32_t owner_account, const char \*name_, int mode,/,
		'the rebirth command must exist');
	assert.match(header, /int population_engine_companion_rebirth\(uint32_t owner_account, const char\* name_, int mode,/,
		'and be declared in the header');
	// eligibility uses the same predicate as the automatic path, so the two cannot disagree
	assert.match(engine, /shell->status\.job_level, \/\*allow_rebirth=\*\/true\);\s*\n\s*if \(target == 0 \|\| !pop_job_change_is_rebirth/,
		'the command must gate on the shared predicate');
});

test('the at-command verb ships in its own patch', () => {
	assert.ok(patch.length > 0, '0028-companion-rebirth.patch must exist');
	assert.match(patch, /@companion rebirth <name> novice\|trans/,
		'the usage string must name both options');
	assert.match(patch, /population_engine_companion_rebirth\(/,
		'the verb must call the command');
	assert.ok(!/-1 \{/.test(patch), 'a malformed hunk header would truncate the patch on a fresh apply');
});

test('the roster carries rebirth readiness, computed like the homunculus field', () => {
	assert.match(engine, /hom_enabled(, \w+)*, job_level(, \w+)* FROM `cp_companion_persistence`/,
		'the SELECT must read job_level (appended, so the earlier fields keep their positions)');
	assert.match(engine, /int rebirth = -1;/,
		'-1 must mean "this class cannot be reborn"');
	assert.match(engine, /else if \(tree_class >= 7 && tree_class <= 20\)\s*\n\s*rebirth = 0;/,
		'0 must mean "a 2nd class that is not ready yet"');
	assert.match(engine, /"@CP\|%s\|%s\|%d\|%d\|%d\|%d\|%s\|%d(\|%d){1,8}"/,
		'the line carries the pet switch and the fields appended after it');
});

test('each confirmation names its own action - a rebirth must not offer to Delete', () => {
	// confirmInWindow served one caller (the delete button) and baked "Cancel"/"Delete" into its
	// markup. Reusing it for rebirth made a rebirth dialog offer to Delete, which says the
	// opposite of what the button does; the helper now takes the label, with Delete as the default
	// so the delete caller is unchanged.
	assert.match(panel, /function confirmInWindow\(question, detail, okLabel = 'Delete'/,
		'the helper must take the confirming label');
	assert.ok(!/>Delete<\/button>/.test(panel),
		'the label must not be baked into the markup any more');
	assert.match(panel, /okButton\.textContent = okLabel;/, 'and must be applied at call time');
	// the two rebirth paths name themselves, and only the level-resetting one keeps the warning style
	assert.match(panel, /'Rebirth', true/, 'the High Novice path must say Rebirth (and keep the warning style)');
	assert.match(panel, /'Advance', false/, 'the straight path must say Advance, without the danger style');
	// and the delete caller keeps its wording
	assert.match(panel, /`Delete \$\{m\.name\} permanently\?`/, 'the delete prompt is unchanged');
});

test('the panel offers the tab only for what the server reports as ready', () => {
	assert.match(html, /data-tab="rebirth"[^>]*>Rebirth</,
		'the Rebirth tab must exist');
	// it must sit after Gear, which is where the user asked for it
	const gearAt = html.indexOf('data-tab="gear"');
	const rebirthAt = html.indexOf('data-tab="rebirth"');
	assert.ok(gearAt > 0 && rebirthAt > gearAt, 'the tab must come after Gear');
	assert.match(html, /data-page="rebirth"/, 'and have its page');
	assert.match(panel, /rebirth: \(\(\) => \{/, 'the roster row must carry it');
	assert.match(panel, /const ready = _roster\.filter\(m => m\.rebirth === 1\);/,
		'only ready companions get the controls');
	assert.match(panel, /_drawGear\(\);\s*\n\s*_drawRebirth\(\);/, '_render must draw it');
	assert.match(panel, /talk\(`@companion rebirth \$\{m\.name\} novice`, false\)/,
		'the button must send the novice verb');
	assert.match(panel, /talk\(`@companion rebirth \$\{m\.name\} trans`, false\)/,
		'and the trans verb');
	// the destructive half is confirmed in-window, because the level resets
	assert.match(panel, /confirmInWindow\([\s\S]{0,600}?talk\(`@companion rebirth \$\{m\.name\} novice/,
		'the level-resetting choice must ask first');
});