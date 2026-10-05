// Guards for ally buffs a companion also casts on itself (#384).
//
// Blessing, Increase AGI and Kyrie Eleison are `Target: ally` rows, and every ally scan skipped
// the caster, so a companion buffed everyone near it but never itself. The row's own condition
// (not_ally_status, ally_hp_below) counted only the others too, so with nobody else around the
// row never reached the target search at all.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const COMBAT = path.join(ROOT, 'third-party', 'population-engine', 'files', 'src', 'map', 'population_engine',
	'runtime', 'population_engine_combat.cpp');
const combat = fs.readFileSync(COMBAT, 'utf8').replace(/\r\n/g, '\n');

function fn(signature) {
	const i = combat.lastIndexOf(signature);
	assert.ok(i >= 0, `expected to find ${signature}`);
	const rest = combat.slice(i);
	const end = rest.indexOf('\n}\n');
	return end > 0 ? rest.slice(0, end + 3) : rest;
}

test('the ally scans take the caster when the skill may go to it', () => {
	for (const cb of ['pop_ally_hp_scan_cb', 'pop_ally_status_scan_cb', 'pop_ally_any_scan_cb'])
		assert.match(fn(`static int32 ${cb}(`), /if \(ally->id == ctx->shell->id && !ctx->allow_self\) return 0;/,
			`${cb} skips the caster only when the skill may not go to it`);
	const find = fn('static map_session_data* population_shell_find_ally_target(');
	assert.match(find, /ctx\.allow_self\s+= pop_ally_row_may_self\(skill_id\);/);
});

test('not the skills that refuse or harm the caster', () => {
	const self = fn('static bool pop_ally_row_may_self(');
	assert.match(self, /skill_get_inf2\(skill_id, INF2_NOTARGETSELF\)/, 'rAthena refuses Devotion and Providence on the caster');
	assert.match(self, /WL_WHITEIMPRISON/, 'White Imprison locks the caster up');
	assert.match(self, /SP_KAUTE/, 'Kaute pays the caster\'s HP for its own SP');
});

test('the cast condition of an ally row counts the caster as well', () => {
	const gate = fn('static inline bool pop_skill_cond_satisfied(');
	assert.match(gate, /sk\.target == 2 && pop_is_ally_condition\(sk\.condition\)/);
	assert.match(gate, /population_shell_find_ally_target\([^;]*sk\.skill_id\) != nullptr;/,
		'the condition is answered by the same search the cast uses');
	const cond = fn('static bool pop_is_ally_condition(');
	for (const c of ['AllyHpBelow', 'AllyStatus', 'NotAllyStatus'])
		assert.ok(cond.includes(`PopSkillCondition::${c}`), `${c} is about an ally`);
});
