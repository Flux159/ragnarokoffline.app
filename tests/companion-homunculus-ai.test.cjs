// windows-latest checks text files out with CRLF; normalise on read so assertions about file
// content do not depend on the checkout's newline convention.
// Guards for the companion homunculus driver (phase 2): the pet must pick its own target, fight
// through the calls rAthena's own homunculus AI commands use, stay leashed to the companion, and
// run inside the shell's existing combat tick rather than a timer of its own.
//
// Why this file matters: a homunculus has no AI server-side at all - its brain is client-side Lua
// (docs/CUSTOM_HOMUNCULUS_AI.md), which a population shell can never run. Nothing in rAthena makes
// a BL_HOM act on its own, so these relationships are the entire mechanism, and a compile check
// cannot see any of them.
//
// Every assertion fails against the commit before the driver landed.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const MAP = path.join(ROOT, 'third-party', 'population-engine', 'files', 'src', 'map');
const AI = path.join(MAP, 'population_engine', 'runtime', 'population_engine_combat.cpp');
const ENGINE = path.join(MAP, 'population_engine.cpp');

const ai = fs.readFileSync(AI, 'utf8').replace(/\r\n/g, '\n');
const engine = fs.readFileSync(ENGINE, 'utf8').replace(/\r\n/g, '\n');

// A negative assertion must not be satisfiable by prose: a comment explaining why something is NOT
// done still names it.
function codeOnly(text) {
	return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

// Slice a function by matching the brace that closes it, NOT by a character count: a fixed window
// silently drops whatever a later, legitimate change pushes past it, and the test then fails for a
// reason that has nothing to do with the behaviour it guards.
function functionBody(text, signature) {
	const i = text.indexOf(signature);
	assert.ok(i > 0, `expected to find ${signature}`);
	const rest = text.slice(i);
	const end = rest.indexOf('\n}\n');
	return end > 0 ? rest.slice(0, end + 3) : rest;
}

function bodyOf(signature) {
	return functionBody(ai, signature);
}

const DRIVER_SIG = 'static void population_engine_homunculus_per_tick(map_session_data *sd)\n{';
const PICKER_SIG = 'static uint32 population_engine_homunculus_target(map_session_data *sd, homun_data *hd)\n{';

test('the driver and its target picker exist in the tick that owns shell AI', () => {
	assert.ok(ai.includes(DRIVER_SIG), 'the per-tick driver must exist');
	assert.ok(ai.includes(PICKER_SIG), 'the target picker must exist');
	// homun_data / hom_is_active must be reachable: the type has to be included, not assumed
	assert.match(ai, /#include "\.\.\/\.\.\/homunculus\.hpp"/,
		'the TU must include homunculus.hpp for homun_data and hom_is_active');
});

test('it only ever drives one of our own live pets', () => {
	const body = bodyOf(DRIVER_SIG);
	assert.match(body, /if \(!population_engine_is_population_pc\(sd->id\)\)\s*\n\s*return;/,
		'a real player has their own client-driven pet - never drive it');
	assert.match(body, /if \(hd->master != sd\)\s*\n\s*return;/,
		'only the pet this shell owns may be commanded');
	assert.match(body, /hom_is_active\(hd\)/,
		"use rAthena's own liveness predicate rather than re-deriving dead/resting/vaporized");
	assert.match(body, /if \(pc_isdead\(sd\)\)\s*\n\s*return;/,
		'a downed companion must not leave its pet fighting on alone');
});

test('it acts through the canonical homunculus calls, and does not re-implement chasing', () => {
	const body = bodyOf(DRIVER_SIG);
	// the exact shape script.cpp uses for setunitdata UHOM_TARGETID
	assert.match(body, /unit_attack\(hd, target_id, 1\);/,
		'the attack must be unit_attack(hd, id, 1)');
	assert.match(body, /unit_stop_attack\(hd\);/,
		'clearing a target must use unit_stop_attack(hd)');
	assert.match(body, /unit_walktobl\(hd, sd, 2, 1\);/,
		'returning to the companion must use unit_walktobl stop-2-cells-short');
	// unit_attack walks the unit into range itself; a hand-rolled chase would be a second pathfinder
	assert.ok(!/unit_walktobl\(hd, mob_bl/.test(codeOnly(body)),
		'do not walk toward the monster by hand - unit_attack owns the approach');
});

test('it picks its own target: nearest to the PET, not a mirror of the shell', () => {
	const picker = bodyOf(PICKER_SIG, 2000);
	// agreed scope #4: the pet chooses independently, so two companions get two engaged pets
	assert.match(picker, /distance_bl\(hd, mob_bl\)/,
		'the ranking distance must be measured from the PET');
	assert.ok(!/distance_bl\(sd, mob_bl\)\s*;/.test(codeOnly(picker)),
		'ranking from the master would make the pet a mirror of the shell target');
	assert.match(picker, /best_distance = pet_distance;/,
		'the nearest-to-the-pet candidate must win');
	// and it reuses the engine's validity notion rather than inventing one
	assert.match(picker, /population_shell_check_target\(sd, mob\.mob_id\)/,
		'the engine already defines what a legal enemy is');
	assert.match(picker, /population_shell_check_target_for_movement\(sd, mob\.mob_id\)/,
		'targets reachable-but-not-attackable must still be considered');
});

test('it stays leashed to the companion and does not stray', () => {
	const picker = bodyOf(PICKER_SIG, 2000);
	assert.match(picker, /check_distance_bl\(sd, mob_bl, master_radius\)/,
		'a target the master cannot see is not this pet\'s fight');
	const body = bodyOf(DRIVER_SIG);
	assert.match(body, /if \(distance_bl\(sd, hd\) > 12\) \{/,
		'there must be a leash distance');
	assert.match(body, /if \(distance_bl\(sd, hd\) > 3\)/,
		'an idle pet must drift back to the companion it followed away from');
});

test('it runs inside the shell combat tick, not on a timer of its own', () => {
	// locate per_tick and its closing brace, then require the call to be inside it
	const lines = ai.split('\n');
	const start = lines.findIndex((l) => l.startsWith('int population_engine_combat_per_tick('));
	assert.ok(start >= 0, 'per_tick must exist');
	let end = -1;
	for (let i = start + 1; i < lines.length; i++) {
		if (lines[i] === '}') { end = i; break; }
	}
	assert.ok(end > start, 'per_tick must have a body');

	const call = lines.findIndex((l) => l.trim() === 'population_engine_homunculus_per_tick(sd);');
	assert.ok(call > start && call < end,
		`the driver must be called inside per_tick (call ${call}, body ${start}-${end})`);
	assert.equal(lines.filter((l) => l.trim() === 'population_engine_homunculus_per_tick(sd);').length, 1,
		'exactly one call site, so the pet takes one turn per tick');

	// the cadence is the shell's tick: no timer of its own
	const body = codeOnly(bodyOf(DRIVER_SIG));
	assert.ok(!/add_timer/.test(body), 'the driver must not schedule its own timer');
});

test('the driver cannot reach the char server, and stays deterministic', () => {
	const body = codeOnly(bodyOf(DRIVER_SIG) + bodyOf(PICKER_SIG, 2000));
	assert.ok(!/intif_homunculus/.test(body),
		'a synthetic char_id means every char-server call is meaningless here');
	assert.ok(!/rnd_value|rnd\(\)/.test(body),
		'the pet must behave the same way each tick for the same state');
});
