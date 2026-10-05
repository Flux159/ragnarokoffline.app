// Guards for Assumptio on party members (#290).
//
// HP_ASSUMPTIO is a single-target Support skill (TargetType: Support, Hit: Single), but every
// curated row for it was `Target: self`, so a High Priest companion only ever cast it on itself.
// The ally row has to come first: the rotation walks rows in order, and the self row's
// `not_self_status` gate is satisfied as soon as the companion lacks the buff.
//
// An ally row is seeded only when the companion has learned the skill (pc_checkskill in the
// attack rotation), unlike a self row, which casts from the YAML level alone. A non-transcendent
// Arch Bishop (4057) inherits Priest, not High_Priest, so it never learns Assumptio; an ally row
// there would never load, and it is left with its self row.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const YAML = path.join(ROOT, 'third-party', 'population-engine', 'files', 'db', 'population_skill_db.yml');
const yaml = fs.readFileSync(YAML, 'utf8').replace(/\r\n/g, '\n');

function block(jobId) {
	const m = new RegExp(`\\n  - JobId: ${jobId}\\n    Skills:\\n`).exec(yaml);
	assert.ok(m, `job ${jobId} must have a curated block`);
	const start = m.index + m[0].length;
	const next = yaml.indexOf('\n  - JobId: ', start);
	return yaml.slice(start, next < 0 ? yaml.length : next);
}

const ALLY = /\{ SkillId: HP_ASSUMPTIO,\s+Level: 5,\s+Rate: 10000, Target: ally, Condition: not_ally_status, CondValue: SC_ASSUMPTIO \}/;
const SELF = /\{ SkillId: HP_ASSUMPTIO,\s+Level: 5,\s+Rate: 10000, Target: self, Condition: not_self_status, CondValue: SC_ASSUMPTIO \}/;

test('High Priest and transcendent Arch Bishop cast Assumptio on party members before themselves', () => {
	for (const jobId of [4009, 4063]) {
		const body = block(jobId);
		const ally = ALLY.exec(body);
		const self = SELF.exec(body);
		assert.ok(ally, `job ${jobId} must carry an ally Assumptio row`);
		assert.ok(self, `job ${jobId} keeps its self Assumptio row`);
		assert.ok(ally.index < self.index, `job ${jobId}: the ally row must come before the self row`);
	}
});

test('a non-transcendent Arch Bishop gets no ally Assumptio row it could never learn', () => {
	assert.ok(!ALLY.test(block(4057)));
});

// In pre-renewal (db/pre-re/status.yml) Assumptio ends Kyrie Eleison and Kyrie ends Assumptio, and
// the population skill db is shared by both eras. The High Priest's ally Kyrie row and ally
// Assumptio row each check only their own status, so each cast ended the other on the same party
// member, tick after tick, until the companion ran out of SP. The ally search now passes over an
// ally holding a buff the new one would end and that would end it back, so the buff already there
// holds; renewal, where the two don't cancel, is unchanged. Debuffs are still cleared.
const combat = fs.readFileSync(path.join(ROOT, 'third-party', 'population-engine', 'files', 'src', 'map',
	'population_engine', 'runtime', 'population_engine_combat.cpp'), 'utf8').replace(/\r\n/g, '\n');

function fn(name) {
	const start = combat.indexOf(name);
	assert.ok(start >= 0, `${name} must exist`);
	return combat.slice(start, combat.indexOf('\n}\n', start));
}

test('two ally buffs that cancel each other are not cast over each other', () => {
	const clash = fn('static bool pop_ally_buff_clashes(');
	assert.match(clash, /status_db\.getEndOnStart\(sc_id\)/);
	assert.match(clash, /sca->hasSCE\(held\)/);
	assert.match(clash, /held_db->flag\[SCF_DEBUFF\]\)\s*continue;/, 'a debuff the new status ends is still cleared');
	assert.match(clash, /status_db\.getEndOnStart\(held\)/, 'only a buff that ends the new one back holds');
	assert.match(combat, /sc_type\s+gives_sc = SC_NONE;/, 'SC_NONE is -1, so a zeroed context must not mean SC_STONE');
	for (const cb of ['pop_ally_hp_scan_cb', 'pop_ally_status_scan_cb', 'pop_ally_any_scan_cb'])
		assert.match(fn(`static int32 ${cb}(`), /if \(pop_ally_buff_clashes\(ally, ctx->gives_sc\)\) return 0;/,
			`${cb} must pass over a clashing ally`);
	const find = fn('static map_session_data* population_shell_find_ally_target(');
	assert.match(find, /ctx\.gives_sc\s+= gives_sc;/);
	const calls = combat.match(/population_shell_find_ally_target\(\s*sd,[^;]*;/g) || [];
	assert.equal(calls.length, 3, 'every ally search is covered: the cast condition and both casters');
	for (const call of calls)
		assert.match(call, /skill_get_sc\((bs|sk)\.skill_id\), \1\.skill_id\)/, 'each caller passes the status its skill gives, and the skill');
});

test('the High Priest still carries both ally rows the clash gate keeps apart', () => {
	const body = block(4009);
	assert.ok(ALLY.test(body));
	assert.match(body, /\{ SkillId: PR_KYRIE,\s+Level: 10, Rate: 8000, Target: ally, Condition: not_ally_status, CondValue: SC_KYRIE \}/);
});
