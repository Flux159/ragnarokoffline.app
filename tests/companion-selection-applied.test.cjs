// windows-latest checks text files out with CRLF; normalise on read so assertions about file
// content do not depend on the checkout's newline convention.
// Guards for "a restored skill selection must actually be APPLIED".
//
// The bug this pins, found by reading `@companion dump` rather than by inference:
//
//     @SHELL|307|Avaten|15|2000001|1|13|9|1|1|1|7|1
//                                        ^override=1  ^attack_n=13 ^buff_n=9
//
// Every identity field was correct - the shell was Avaten, it was a companion, it was on the
// grid, and it HAD received skill_override_active. Only the lists were wrong: 13 attack and 9
// buff entries while the selection was empty, when the filter should have rejected every
// curated entry and left both at 0.
//
// Cause: recall_one_companion restores the selection but never asks for a rebuild. The lists
// are seeded earlier in that same call, while `override_active` is still false, so they hold
// the full class list; the per-tick seeder only rebuilds when a list is EMPTY or when
// `skills_need_reseed` is set, and it was neither. A restored selection was therefore stored,
// displayed in the panel, and never applied - on every login, for every companion.
//
// That single omission is why three earlier fixes (per-tick re-seed, buff-guard, sphere-chain
// gate) all appeared ineffective: each one filters lists that had already been filled before
// the override existed.
//
// These assertions pin the RELATIONSHIPS that make it work, because a compile test cannot see
// this class at all - removing the reseed line still compiles cleanly (verified).
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const ENGINE = path.join(ROOT, 'third-party', 'population-engine', 'files', 'src', 'map', 'population_engine.cpp');
const COMBAT = path.join(ROOT, 'third-party', 'population-engine', 'files', 'src', 'map',
	'population_engine', 'runtime', 'population_engine_combat.cpp');
const src = fs.readFileSync(ENGINE, 'utf8').replace(/\r\n/g, '\n');
const cb = fs.readFileSync(COMBAT, 'utf8').replace(/\r\n/g, '\n');

test('recall requests a rebuild after restoring the selection', () => {
	// The restore block must both set the flag AND ask for a rebuild. Without the reseed the
	// selection is inert; without the active flag it is treated as "never chosen".
	const i = src.indexOf("// RAGNAROKMAC (skill selector): restore the player's skill selection.");
	assert.ok(i > 0, 'the selection-restore block must exist');
	const block = src.slice(i, i + 1400);
	assert.match(block, /shell->pop\.skill_override_active = true;/,
		'the restore must mark the override active (NULL vs "" must stay distinguishable)');
	assert.match(block, /shell->pop\.skills_need_reseed = true;/,
		'the restore MUST request a rebuild, or the lists keep the pre-override contents');
});

test('the reseed is requested AFTER the lists were seeded, not before', () => {
	// Ordering is the whole point: spawn_shell seeds the lists while override_active is still
	// false, so the flag has to be set strictly afterwards. A flag set before the spawn would
	// be cleared by the seeder inside spawn and change nothing.
	const spawn = src.indexOf('map_session_data *shell = population_engine_spawn_shell(');
	const restore = src.indexOf('shell->pop.skill_override_active = true;');
	const flag = src.indexOf('ASK FOR THE REBUILD');
	assert.ok(spawn > 0 && restore > 0 && flag > 0, 'all three anchors must exist');
	assert.ok(restore > spawn,
		'the selection restore must come after spawn_shell (which seeds the lists)');
	assert.ok(flag > restore,
		'the reseed flag must be set after the restore, so it covers the restored selection');
});

test('every path that changes the selection asks for a rebuild', () => {
	// Four legitimate sites: job advancement, the `set` command, the `toggle` command, and
	// recall. Recall was the missing one, and a fifth path added later must do the same.
	const sites = (src.match(/skills_need_reseed = true;/g) || []).length;
	assert.ok(sites >= 4,
		`expected at least the four known reseed sites (job advance, set, toggle, recall), found ${sites}`);
	// And the tick must be the one that consumes it, or the flag would only ever be cleared
	// by the seeder on its own schedule.
	assert.match(cb, /if \(sd->pop\.skills_need_reseed\)\n\t\tpopulation_shell_seed_attack_skills_if_empty\(sd\);/,
		'the per-tick path must consume the flag');
	assert.match(cb, /sd->pop\.skills_need_reseed = false;/,
		'and the seeder must clear it, so the rebuild runs exactly once per change');
});

test('the seeder applies the override to BOTH lists', () => {
	// A rebuilt attack list with a stale buff list would still leave a "none" companion
	// casting self-buffs - which is what the earlier rounds actually observed.
	const seeder = cb.slice(cb.indexOf('static void population_shell_seed_attack_skills_if_empty'));
	assert.match(seeder, /population_shell_skill_selected\(sd, e\.skill_id\)/,
		'the curated entries must be filtered through the selection');
	const filters = (seeder.match(/if \(!population_shell_skill_selected\(sd, e\.skill_id\)\)/g) || []).length;
	assert.ok(filters >= 2,
		`both the attack rotation and the buff list must be filtered (found ${filters})`);
});

test('the empty-list guard cannot refill a deliberate empty selection', () => {
	// The companion's own "none" choice produces an empty list, which the guard must not read
	// as "not yet seeded" - that collision regenerated the skills every tick.
	assert.match(cb, /const bool buffs_chosen_none = sd->pop\.skill_override_active;/,
		'the buff guard must consult whether a selection is active');
	assert.match(cb, /if \(\(!buffs_chosen_none && sd->pop\.buff_skills\.empty\(\)\) \|\| sd->pop\.skills_need_reseed\)/,
		'emptiness only means "needs seeding" when nothing was chosen');
});