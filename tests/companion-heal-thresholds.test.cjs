// The panel's healer thresholds (heal_at, emergency_at) were stored, saved and restored, and
// nothing read them: heals fired on the skill database's fixed ally_hp_below values. These
// guards pin that a companion's heals wait for its own thresholds.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const COMBAT = path.join(ROOT, 'third-party', 'population-engine', 'files', 'src', 'map', 'population_engine',
	'runtime', 'population_engine_combat.cpp');
const combat = fs.readFileSync(COMBAT, 'utf8').replace(/\r\n/g, '\n');

function functionBody(signature) {
	const i = combat.lastIndexOf(signature);
	assert.ok(i >= 0, `expected to find ${signature}`);
	const rest = combat.slice(i);
	const end = rest.indexOf('\n}\n');
	return end > 0 ? rest.slice(0, end + 3) : rest;
}

test('a companion heal reads its own thresholds; everything else keeps the database value', () => {
	const body = functionBody('static uint8_t pop_ally_hp_threshold(');
	assert.match(body, /PopSkillCondition::AllyHpBelow/, 'only the ally-HP condition is about healing');
	assert.match(body, /companion_owner_account == 0/, 'an ambient shell keeps the database value');
	assert.match(body, /pop_skill_heals_ally\(skill_id\)/, 'Ki Translation or Kaute are not heals');
	assert.match(body, /cond_value < 50 \? sd->pop\.companion_emergency_at : sd->pop\.companion_heal_at/,
		'below 50 in the database is an emergency heal, the rest routine');
	const heals = functionBody('static bool pop_skill_heals_ally(');
	for (const skill of ['AL_HEAL', 'AB_HIGHNESSHEAL', 'AB_EPICLESIS', 'CD_REPARATIO'])
		assert.ok(heals.includes(`case ${skill}:`), `${skill} is a heal`);
});

test('the threshold reaches both the cast decision and the choice of whom to heal', () => {
	const gate = functionBody('static inline bool pop_skill_cond_satisfied(');
	assert.match(gate, /pop_ally_hp_threshold\(sd, sk\.skill_id, sk\.condition, sk\.cond_value_num\)/);
	const finds = combat.match(/population_shell_find_ally_target\(\s*sd,[^;]*;/g) || [];
	assert.equal(finds.length, 3, 'every ally-target search: the cast condition and both casters');
	for (const call of finds)
		assert.match(call, /pop_ally_hp_threshold\(/, `the ally search must use the threshold: ${call}`);
});
