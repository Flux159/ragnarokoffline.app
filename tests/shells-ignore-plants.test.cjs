// Guards against shells fighting harvest plants (#290 testing).
//
// Green, Red, White Plant and the mushrooms are Plants that can neither move nor attack, and every
// hit on one does 1 damage. Shells took them as targets and counted them as enemies nearby, so
// companions spent their turns, and SP on skills, on things that were no threat, and area skills
// fired at a garden. Mandragora and Geographer are Plants that attack, so they stay targets.
// A companion still joins in once its owner attacks a plant, but with plain attacks only: a skill
// does the same 1 damage, so it would only spend SP and cast time.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const combat = fs.readFileSync(path.join(__dirname, '..', 'third-party', 'population-engine', 'files', 'src',
	'map', 'population_engine', 'runtime', 'population_engine_combat.cpp'), 'utf8').replace(/\r\n/g, '\n');
const runtime = fs.readFileSync(path.join(__dirname, '..', 'third-party', 'population-engine', 'files', 'src',
	'map', 'population_engine', 'runtime', 'population_shell_runtime.cpp'), 'utf8').replace(/\r\n/g, '\n');

function fn(name) {
	const start = runtime.indexOf(name);
	assert.ok(start >= 0, `${name} must exist`);
	return runtime.slice(start, runtime.indexOf('\n}\n', start));
}

test('a plant is a Plant that can neither move nor attack', () => {
	const body = fn('bool population_shell_mob_is_plant(');
	assert.match(body, /md->status\.race == RC_PLANT/);
	assert.match(body, /!status_has_mode\(&md->status, MD_CANMOVE\)/);
	assert.match(body, /!status_has_mode\(&md->status, MD_CANATTACK\)/, 'Mandragora attacks, so it stays a target');
});

test('shells neither target plants nor count them as enemies nearby', () => {
	for (const f of ['bool population_shell_check_target(', 'bool population_shell_check_target_for_movement('])
		assert.match(fn(f), /if \(population_shell_mob_is_plant\(md\) && !population_shell_plant_allowed\(sd, md\)\)\s*return false;/, f);
	assert.match(runtime, /if \(population_shell_mob_player_owned\(md\)\) return 0;[\s\S]{0,200}if \(population_shell_mob_is_plant\(md\)\) return 0;/,
		'the mob tracker skips plants');
});

test('a companion joins its owner on a plant, with plain attacks only', () => {
	const allowed = fn('static bool population_shell_plant_allowed(');
	assert.match(allowed, /population_engine_companion_loot_owner\(sd\)/, 'only a companion, through its owner');
	assert.match(allowed, /ud->target == md->id/);
	const pick = combat.slice(combat.indexOf('static void population_shell_pick_attack_skill('));
	assert.match(pick.slice(0, 1200), /population_shell_mob_is_plant\(reinterpret_cast<const mob_data \*>\(target_bl\)\)\)\s*return;/,
		'no attack skill is picked against a plant');
});
