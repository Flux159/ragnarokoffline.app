// windows-latest checks text files out with CRLF; normalise on read so assertions about file
// content do not depend on the checkout's newline convention.
// Guards for the companion skill presets (population_skill_db.yml).
//
// Phase 2 filled the curated presets from ground truth: 1057 rows added across 57
// classes, taking the 4th jobs from 4-5 rows each to 13-73. Those classes were the
// worst case, because the Summon tab makes a 4th-job companion the easiest to
// draft while the engine gave it almost nothing to cast - Cardinal ran 5 skills out
// of the 81 its class tree grants.
//
// What must stay true now that the rows are generated rather than hand-written:
//
//   * NO (SkillId, Target) duplicate inside one block. The engine dispatches the
//     attack rotation and the ally/self buff list separately, so the SAME skill is
//     legitimately listed twice with different Targets (AL_HEAL self + ally is the
//     hand-written idiom). But the same skill at the same Target twice means the
//     rotation can pick a slot whose sibling is shadowed - a generator bug.
//   * Every Condition must exist in the engine's name map
//     (config/population_skill_db.cpp). An unknown one is not an error: the parser
//     logs a warning and leaves the condition at `always`, so a typo silently turns
//     a gated skill into an unconditional one.
//   * Every row needs SkillId and Level, and Target must be one of the three the
//     parser understands (current/self/ally).
//   * A 4th-job block must not fall back to a token rotation. This is the assertion
//     that fails on the pre-phase-2 commit and is the point of the change.
//
// Parsing note: no YAML dependency is available to the node tests, and the rows use
// two shapes (inline `{ ... }` maps and multi-line block maps). The small parser
// below handles both; it is deliberately tolerant of formatting so reformatting the
// file cannot fail these tests, only changing the DATA can.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const YAML = path.join(ROOT, 'third-party', 'population-engine', 'files', 'db', 'population_skill_db.yml');
const SRCP = path.join(ROOT, 'third-party', 'population-engine', 'files', 'src', 'map', 'population_engine', 'config', 'population_skill_db.cpp');

/**
 * Parse the skill DB into [{ jobId, rows: [{...}] }].
 * Handles both `- { SkillId: X, Level: 3, ... }` and indented `SkillId: X` blocks.
 */
function parse(text) {
	const jobs = [];
	let cur = null;
	let pending = null;          // multi-line row in progress
	const closePending = () => {
		if (pending && cur) cur.rows.push(pending);
		pending = null;
	};
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (line.startsWith('#')) continue;

		const job = line.match(/^- JobId:\s*(\d+)/);
		if (job) {
			closePending();
			cur = { jobId: Number(job[1]), rows: [] };
			jobs.push(cur);
			continue;
		}
		if (!cur) continue;

		// inline map row
		const inline = line.match(/^- \{(.+)\}\s*$/);
		if (inline) {
			closePending();
			cur.rows.push(Object.fromEntries(
				inline[1].split(',').map(kv => {
					const i = kv.indexOf(':');
					return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
				}).filter(([k]) => k)
			));
			continue;
		}
		// multi-line block row
		if (line === '- JobId:'.slice(0, line.length) ) continue;
		if (/^-\s*SkillId:/.test(line)) {
			closePending();
			pending = {};
			const m = line.match(/^-\s*SkillId:\s*(\S+)/);
			if (m) pending.SkillId = m[1];
			continue;
		}
		if (pending) {
			const m = line.match(/^([A-Za-z_]+):\s*(.+)$/);
			if (m) pending[m[1]] = m[2];
		}
	}
	closePending();
	return jobs;
}

const text = fs.readFileSync(YAML, 'utf8').replace(/\r\n/g, '\n');
const jobs = parse(text);
const byId = new Map(jobs.map(j => [j.jobId, j]));

test('the file parses into job blocks whose rows all carry a SkillId and a Level', () => {
	assert.ok(jobs.length >= 70, `expected the full job table, parsed ${jobs.length} blocks`);
	const bad = [];
	for (const j of jobs) {
		assert.ok(j.rows.length > 0, `job ${j.jobId} has no rows`);
		for (const r of j.rows) {
			if (!r.SkillId) bad.push({ job: j.jobId, r, why: 'no SkillId' });
			if (!r.Level) bad.push({ job: j.jobId, r, why: 'no Level' });
			if (r.Target && !['current', 'self', 'ally'].includes(r.Target)) {
				bad.push({ job: j.jobId, r, why: `unknown Target ${r.Target}` });
			}
		}
	}
	assert.equal(bad.length, 0, `malformed rows: ${JSON.stringify(bad.slice(0, 5))}`);
});

test('no skill is listed twice with the SAME trigger, value and target inside one block', () => {
	// The key must be the full trigger, not just its name. The file deliberately
	// lists the same skill at the same target several times with different triggers
	// (SM_BASH plain plus a `damaged_gt` counter; AL_HEAL at self for `hp_below` plus
	// a `damaged_gt` emergency row) AND the same trigger name with a different value
	// (Stalker's RG_BACKSTAP on `self_status` twice - once for SC_HIDING, once for
	// SC_CHASEWALK). Both are the hand-written design.
	//
	// A repeat of the same (skill, target, trigger, value) IS a bug: the rotation can
	// reach only one of the two slots, so the other is dead weight that was meant to
	// be something else. Phase 2 added 1057 rows and moved this count by zero, so the
	// bar stays exactly where the hand-written file already was.
	const offenders = [];
	for (const j of jobs) {
		const seen = new Set();
		for (const r of j.rows) {
			const key = `${r.SkillId}|${r.Target || 'current'}|${r.Condition || 'always'}|${r.CondValue || ''}`;
			if (seen.has(key)) offenders.push(`job ${j.jobId}: ${key}`);
			seen.add(key);
		}
	}
	assert.equal(offenders.length, 0, `duplicate (skill, target, trigger, value) rows:\n${offenders.slice(0, 10).join('\n')}`);
});

test('the per-skill variety the file relies on survives (skill reused with a different trigger)', () => {
	// The complement of the test above: the same skill + target MAY appear more than
	// once as long as the trigger differs. Asserting on the shape rather than a count
	// keeps a future reformat from passing while a dedupe script silently flattened
	// the combo rows.
	const withTriggers = jobs.flatMap(j => j.rows)
		.filter(r => r.Condition && r.Condition !== 'always');
	assert.ok(withTriggers.length > 100,
		`expected the trigger-gated rows to remain, found ${withTriggers.length}`);
	const combos = ['damaged_gt', 'after_skill', 'skill_used'];
	for (const c of combos) {
		assert.ok(withTriggers.some(r => r.Condition === c),
			`the '${c}' combo rows disappeared`);
	}
});

test('every Condition used is one the engine parser recognises', () => {
	// An unknown Condition is NOT rejected: population_skill_db.cpp logs
	// "unknown Condition" and leaves the entry at `always`, so a typo silently turns
	// a gated skill into an unconditional one - the failure this catches.
	const src = fs.readFileSync(SRCP, 'utf8').replace(/\r\n/g, '\n');
	const known = new Set([...src.matchAll(/\{\s*"([a-z_]+)"/g)].map(m => m[1]));
	assert.ok(known.size > 20, 'could not read the condition name map');
	const used = new Set();
	for (const j of jobs) for (const r of j.rows) if (r.Condition) used.add(r.Condition);
	const unknown = [...used].filter(c => !known.has(c));
	assert.equal(unknown.length, 0, `conditions with no parser entry: ${unknown.join(', ')}`);
});

test('a 4th-job companion has a real rotation, not a token list', () => {
	// THE assertion that fails before phase 2. Curated rows per 4th-job class were
	// 3-5 while their trees grant 56-119 skills, so a drafted 4th-job companion had
	// almost nothing to cast. 12 is a floor, not a target: the generated blocks land
	// between 13 and 73.
	const FOURTH = [4252, 4253, 4254, 4255, 4256, 4257, 4258, 4259, 4260, 4261, 4262,
		4263, 4264, 4302, 4303, 4304, 4305, 4306, 4307, 4308];
	const thin = [];
	for (const id of FOURTH) {
		const j = byId.get(id);
		assert.ok(j, `4th-job block ${id} is missing entirely`);
		if (j.rows.length < 12) thin.push(`${id}=${j.rows.length}`);
	}
	assert.equal(thin.length, 0, `4th-job blocks with a token rotation: ${thin.join(', ')}`);
});

test('the generated rows include offensive skill, not only upkeep', () => {
	// A block of nothing but self-buffs would satisfy a row count and still leave the
	// companion unable to fight. Enemy-targeted rows are the attack rotation.
	for (const id of [4252, 4255, 4256, 4261, 4307]) {
		const j = byId.get(id);
		const offense = j.rows.filter(r => !r.Target || r.Target === 'current').length;
		assert.ok(offense >= 3, `job ${id} has only ${offense} enemy-targeted rows`);
	}
});

test('the file keeps its Header/Body shape and gains no trailing block', () => {
	// Appending to this file lands rows inside a Footer, corrupting its Imports list
	// and killing the map server at startup. The file must end inside a job block.
	assert.match(text, /^Header:/m, 'Header block must survive');
	assert.match(text, /^\s*Type: POPULATION_SKILL_DB$/m);
	const tail = text.trimEnd().split(/\r?\n/).slice(-6).join('\n');
	assert.ok(!/^Footer:/m.test(text), 'this file must not grow a Footer');
	assert.match(tail, /SkillId:/, `last lines are not a skill row:\n${tail}`);
});
