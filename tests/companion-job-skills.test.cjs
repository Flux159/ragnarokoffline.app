// windows-latest checks text files out with CRLF; normalise on read so assertions about file
// content do not depend on the checkout's newline convention.
// Guards for: a companion that changes job keeps using its OLD class's skills.
//
// Live evidence (map log + DB): 11 companions advanced from Acolyte
// ("advanced from Acolyte to Monk"/"...to Priest", DB job_id 15/8) and every one of
// them still cast Acolyte skills.
//
// Mechanism: the skill rotation and the self-buff list are seeded from
// sd->status.class_ but only built while their vectors are EMPTY:
//
//     if (sd->pop.attack_skills.empty()) { ...find(sd->status.class_)... }
//     if (sd->pop.buff_skills.empty())   { ...find(sd->status.class_)... }
//
// They are built once on the shell's first combat tick and never rebuilt, so a job
// change left the previous class's presets in place for the rest of the shell's
// life. The job-change path claimed to "re-arm the skill preset" but only ran
// sd->pop.skill_next_use_tick.clear(), which empties neither vector - so the
// empty() guard could never pass again.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const ENGINE = path.join(ROOT, 'third-party', 'population-engine', 'files', 'src', 'map', 'population_engine.cpp');
const COMBAT = path.join(ROOT, 'third-party', 'population-engine', 'files', 'src', 'map', 'population_engine', 'runtime', 'population_engine_combat.cpp');
const STATE = path.join(ROOT, 'third-party', 'population-engine', 'files', 'src', 'map', 'population_engine', 'core', 'population_shell_state.hpp');

const eng = fs.readFileSync(ENGINE, 'utf8').replace(/\r\n/g, '\n');
const cb = fs.readFileSync(COMBAT, 'utf8').replace(/\r\n/g, '\n');
const st = fs.readFileSync(STATE, 'utf8').replace(/\r\n/g, '\n');

test('a job change requests a skill reseed instead of only clearing cooldowns', () => {
	const i = eng.indexOf('static void pop_companion_try_job_advance');
	assert.ok(i > 0, 'job-advance function not found');
	const body = eng.slice(i, i + 4500);
	assert.match(body, /sd->pop\.skills_need_reseed = true;/,
		'the job change must flag the presets for a rebuild');
	// and the misleading comment that let this ship must be gone
	assert.ok(!/clear per-skill cooldowns and let the\s*\n?\s*\/\/ combat session re-seed/.test(body),
		'the "cooldowns alone re-seed" claim was wrong and must not remain');
});

test('the attack rotation rebuilds for the new class, not only when empty', () => {
	// Anchor on the DEFINITION, not the forward declaration. The seeder is declared
	// early (the per-tick re-seed needs it before its definition) and both lines start
	// with the same text, so a plain indexOf lands on the one-line declaration and
	// every assertion below then reads the wrong region - which is exactly how these
	// two tests broke when the declaration was added.
	// Find the DECLARATION first, then the next occurrence after it. A plain
	// indexOf(definitionText) lands on the declaration, because the declaration line
	// contains the definition text as a prefix (it just adds a ';'). Searching past the
	// declaration is explicit and cannot be fooled by that shared prefix.
	const declText = 'static void population_shell_seed_attack_skills_if_empty(map_session_data *sd);';
	const declIdx = cb.indexOf(declText);
	assert.ok(declIdx > 0, 'the forward declaration must exist (the per-tick reseed needs it)');
	const defText = 'static void population_shell_seed_attack_skills_if_empty(map_session_data *sd)';
	const i = cb.indexOf(defText, declIdx + declText.length);
	assert.ok(i > declIdx, 'attack seeder DEFINITION not found after its declaration');
	assert.ok(!cb.slice(i, i + defText.length + 2).endsWith(';\n'), 'anchored on the declaration, not the definition');
	assert.ok(i > 0, 'attack seeder not found');
	// Window = this function's real extent, not a guessed size. A fixed 4000-char slice
	// held the "no preset" comment at offset 3979, so any edit inside the seeder could
	// push it out and fail this assertion for a reason it does not check.
	const body = cb.slice(i, cb.indexOf('\nstatic ', i + 1) > 0 ? cb.indexOf('\nstatic ', i + 1) : i + 12000);
	assert.match(body, /const bool rebuild_skills = sd->pop\.attack_skills\.empty\(\) \|\| sd->pop\.skills_need_reseed;/,
		'the guard must rebuild when the reseed flag is set as well as when empty');
	assert.match(body, /if \(rebuild_skills\) \{/, 'and that condition must gate the seeding');
	// the class lookup itself must be untouched (it was always correct)
	assert.match(body, /population_skill_db\(\)\.find\(sd->status\.class_\)/,
		'seeding is still keyed on the shell class');
	// a class with no preset must not keep the old rotation
	assert.match(body, /The new class has no preset/,
		'a rebuild with no candidates must CLEAR the old rotation rather than keep it');
});

test('the self-buff list rebuilds too, and the flag is cleared afterwards', () => {
	// Anchor on the DEFINITION, not the forward declaration. The seeder is declared
	// early (the per-tick re-seed needs it before its definition) and both lines start
	// with the same text, so a plain indexOf lands on the one-line declaration and
	// every assertion below then reads the wrong region - which is exactly how these
	// two tests broke when the declaration was added.
	// Find the DECLARATION first, then the next occurrence after it. A plain
	// indexOf(definitionText) lands on the declaration, because the declaration line
	// contains the definition text as a prefix (it just adds a ';'). Searching past the
	// declaration is explicit and cannot be fooled by that shared prefix.
	const declText = 'static void population_shell_seed_attack_skills_if_empty(map_session_data *sd);';
	const declIdx = cb.indexOf(declText);
	assert.ok(declIdx > 0, 'the forward declaration must exist (the per-tick reseed needs it)');
	const defText = 'static void population_shell_seed_attack_skills_if_empty(map_session_data *sd)';
	const i = cb.indexOf(defText, declIdx + declText.length);
	assert.ok(i > declIdx, 'attack seeder DEFINITION not found after its declaration');
	assert.ok(!cb.slice(i, i + defText.length + 2).endsWith(';\n'), 'anchored on the declaration, not the definition');
	const body = cb.slice(i, cb.indexOf('\nstatic ', i + 1) > 0 ? cb.indexOf('\nstatic ', i + 1) : i + 12000);
	// The buff seeder must rebuild on a reseed request AND when the list is empty - but
	// emptiness only means "not yet seeded" while the player has made no choice. Once an
	// override is active an empty list is a legitimate end state (the player selected
	// nothing), and treating it as "needs seeding" refills it from the curated rows, so a
	// companion set to "none" regenerated its own skills every tick.
	assert.match(body, /const bool buffs_chosen_none = sd->pop\.skill_override_active;/,
		'the buff guard must consult whether a selection is active');
	assert.match(body, /if \(\(!buffs_chosen_none && sd->pop\.buff_skills\.empty\(\)\) \|\| sd->pop\.skills_need_reseed\)/,
		'the buff seeder rebuilds on reseed, and on emptiness ONLY when nothing was chosen');
	assert.match(body, /sd->pop\.skills_need_reseed = false;/,
		'the flag must be cleared once both lists are rebuilt, or the seeders run every tick');
});

test('the reseed flag lives on the shell state', () => {
	assert.match(st, /bool\s+skills_need_reseed = false;/,
		'the flag must be per-shell state');
});

test('the cooldown clear is still there (it was never the bug on its own)', () => {
	// Keeping this guards against "fixing" it by removing the cooldown reset, which
	// would leave the new job's skills on their old class's cooldown timers.
	assert.match(eng, /sd->pop\.skill_next_use_tick\.clear\(\);/,
		'per-skill cooldowns must still reset on a job change');
});
