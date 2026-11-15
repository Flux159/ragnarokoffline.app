'use strict';
// The shell control API (patch 0027): script commands a mod uses to take a
// population shell away from the engine's AI and drive it. These read the
// sources, as the other engine tests do; the C++ is compiled by images.yml.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const MAP = 'third-party/population-engine/files/src/map';
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const engine = read(`${MAP}/population_engine.cpp`);
const engineHeader = read(`${MAP}/population_engine.hpp`);
const control = read(`${MAP}/population_engine/runtime/population_shell_control.cpp`);
const header = read(`${MAP}/population_engine/population_shell_control.hpp`);
const state = read(`${MAP}/population_engine/core/population_shell_state.hpp`);
const wander = read(`${MAP}/population_engine/runtime/population_engine_path.cpp`);
const patch = read('third-party/population-engine/patches/0027-shell-control-api.patch');
const doc = read('docs/mods/shell-control.md');

const COMMANDS = [
	'population_is_shell', 'population_shells', 'population_hold', 'population_unhold',
	'population_spawn', 'population_despawn', 'population_whisper_event', 'population_whisper',
	'population_lost_event',
];

const body = (src, start, end) => {
	const a = src.indexOf(start);
	assert.ok(a >= 0, `missing ${start}`);
	const b = src.indexOf(end, a + start.length);
	assert.ok(b > a, `missing ${end} after ${start}`);
	return src.slice(a, b);
};

test('every command is defined, registered and documented', () => {
	for (const name of COMMANDS) {
		assert.match(patch, new RegExp(`^\\+BUILDIN_FUNC\\(${name}\\)$`, 'm'), `${name} body`);
		assert.match(patch, new RegExp(`^\\+BUILDIN_DEF\\(${name}, "`, 'm'), `${name} registered`);
		assert.match(doc, new RegExp(`### \`${name}\\(`), `${name} documented`);
	}
	// The patch touches only rAthena's custom-command includes; the engine is in files/.
	const touched = [...patch.matchAll(/^\+\+\+ b\/(\S+)/gm)].map(m => m[1]).sort();
	assert.deepStrictEqual(touched, ['src/custom/script.inc', 'src/custom/script_def.inc']);
	assert.match(patch, /^\+#include "\.\.\/map\/population_engine\/population_shell_control\.hpp"$/m);
});

test('it lives in files of its own, reached from the engine through a few one-line hooks', () => {
	// Kept out of upstream's own files so an engine update merges around it.
	assert.strictEqual(engine.split('#include "population_engine/runtime/population_shell_control.cpp"').length - 1, 1,
		'included once, as population_customers.cpp is');
	assert.doesNotMatch(engineHeader, /PopulationShellKind|population_engine_shell_(kind|hold|unhold|spawn|despawn|is_held)\b|population_engine_find_shells/, 'population_engine.hpp is untouched');
	assert.match(state, /^\ts_pop_hold hold; /m, 'one member on s_population');
	assert.doesNotMatch(state, /hold_npc|whisper_event|follow_portal/, 'the fields live in population_shell_hold.hpp');
	// Every mention of the API in the engine's own source is a hook, not logic.
	const uses = engine.split('\n').filter(l => /population_shell_control_|population_engine_shell_is_held|pop\.hold\./.test(l));
	// 11: main's place_held hook, and shell guilds' release skip for held shells.
	assert.ok(uses.length <= 11, `hooks in population_engine.cpp: ${uses.length}\n${uses.join('\n')}`);
});

test('the hold belongs to an NPC, the script runs it by its own id', () => {
	assert.match(patch, /population_engine_shell_hold\(script_getnum\(st, 2\), st->oid, ms\)/);
	assert.match(patch, /population_engine_shell_unhold\(script_getnum\(st, 2\), st->oid\)/);
	assert.match(patch, /population_engine_shell_spawn\(st->oid, m,/);
	const hold = body(control, 'bool population_engine_shell_hold(', '\n}\n');
	assert.match(hold, /population_engine_shell_kind\(gid\) != POP_SHELL_AMBIENT/, 'never a companion or a vendor');
	assert.match(hold, /population_engine_shell_is_held\(sd\) && sd->pop\.hold\.npc != npc_id\)\n\t\treturn false;/, 'another NPC\'s live hold wins');
	assert.match(hold, /cap_value\(ms > 0 \? ms : POP_HOLD_DEFAULT_MS, POP_HOLD_MIN_MS, POP_HOLD_MAX_MS\)/, 'bounded');
	const unhold = body(control, 'bool population_engine_shell_unhold(', '\n}\n');
	assert.match(unhold, /sd->pop\.hold\.npc != npc_id/, 'only the holder releases');
});

test('the engine leaves a held shell alone everywhere it acts on one', () => {
	const gates = [
		['combat tick', body(engine, 'static int32 pop_combat_tick_bot_in_range(', 'population_engine_combat_per_tick(sd, true);')],
		['reactive cast on damage', body(engine, 'void population_engine_on_shell_damaged(', 'population_engine_shell_reactive_cast(sd);')],
		['ambient chat', body(engine, 'TIMER_FUNC(population_engine_chat_timer)', 'population_engine_db_for_shell(raw_sd)')],
		['name mentions', body(engine, 'void population_engine_on_global_chat_mention(', 'population_engine_deliver_chat_reply_locked(bot, nullptr);')],
		['wander sweep', body(wander, 'for (int ci = 0; ci < max_iterate; ++ci)', 'population_engine_map_has_real_players(sd->m)')],
	];
	for (const [where, src] of gates)
		assert.match(src, /population_engine_shell_is_held\((sd|raw_sd|bot)\)/, where);
	const whisper = body(engine, 'void population_engine_on_whisper_to_population_pc(', 'const bool has_msg');
	assert.match(whisper, /if \(population_shell_control_whisper\(from_sd, bot_sd, message\)\)\n\t\treturn;/, 'whispers');
	const drift = body(engine, 'std::vector<DriftEntry> drift_candidates;', 'drift_candidates.push_back(');
	assert.match(drift, /if \(sd->pop\.hold\.npc != 0\)\n\t\t\tcontinue;/, 'drift check');
	const held = body(control, 'bool population_shell_control_whisper(', '\n}\n');
	assert.match(held, /if \(!population_engine_shell_is_held\(bot_sd\)\)\n\t\treturn false;/, 'a free shell answers as usual');
});

test('holds end by themselves, and a script actor does not linger', () => {
	const timer = body(engine, 'TIMER_FUNC(population_engine_global_combat_timer)', '// Goal 2: gear re-snapshot poll');
	const sweepAt = timer.indexOf('population_shell_control_sweep();');
	const staleAt = timer.indexOf('population_engine_collect_stale_shells()');
	assert.ok(sweepAt > 0 && staleAt > sweepAt, 'swept from the combat timer, before the stale sweep frees an off-map shell');
	const sweep = body(control, 'void population_shell_control_sweep()\n{', '\n}\n');
	assert.match(sweep, /!population_engine_shell_is_held\(sd\) \|\| map_id2nd\(sd->pop\.hold\.npc\) == nullptr/, 'lapsed, or its NPC is gone');
	const end = body(control, 'static void pop_shell_end_hold(', '\n}\n');
	assert.match(end, /\(sd->pop\.hold\.spawned && !sd->pop\.hold\.keep\)/, 'a spawned actor logs out unless kept');
	assert.match(end, /sd->m != sd->pop\.spawn_map_id/, 'so does a shell left on another map');
	assert.match(end, /sd->pop\.hold\.whisper_event\.clear\(\);/);
	assert.match(end, /sd->pop\.hold\.lost_event\.clear\(\);/);
	assert.match(end, /pc_stop_following\(sd\);/, 'a released shell stops following');
	assert.match(end, /pop_shell_follow_reset\(sd\);/);
});

test('the engine does a client\'s part of stock commands for a held shell', () => {
	const sweep = body(control, 'void population_shell_control_sweep()\n{', '\n}\n');
	assert.match(sweep, /pop_shell_finish_script_warp\(sd\);/);
	assert.match(sweep, /pop_shell_chase_attack\(sd\);/);
	const warp = body(control, 'static void pop_shell_finish_script_warp(', '\n}\n');
	assert.match(warp, /sd->prev != nullptr/, 'only a shell pc_setpos left off the map');
	assert.match(warp, /pop_shell_finish_map_placement\(sd\)\)\n\t\tpop_shell_broadcast_map_placement\(sd\);/, 'placed and shown, as the engine\'s own warps');
	const chase = body(control, 'static void pop_shell_chase_attack(', '\n}\n');
	assert.match(chase, /unit_walktobl\(sd, tbl, range, 2\)/, 'walks into range and attacks on arrival');
	assert.match(chase, /unit_stop_attack\(sd\); \/\/ unreachable/, 'gives up an unreachable target');
	assert.match(chase, /ud\.attacktimer != INVALID_TIMER/, 'leaves an attack in progress alone');
});

test('a held shell follows through portals and never teleports after its target', () => {
	const sweep = body(control, 'void population_shell_control_sweep()\n{', '\n}\n');
	assert.match(sweep, /delete_timer\(sd->followtimer, pc_follow_timer\);/, 'rAthena\'s follow timer, which teleports, is taken over');
	assert.match(sweep, /pop_shell_follow_step\(sd, now\)/);
	const fire = sweep.indexOf('pop_shell_follow_lost(l.shell, l.target, l.reason);');
	const loopEnd = sweep.lastIndexOf('pop_shell_chase_attack(sd);');
	assert.ok(fire > loopEnd, 'lost events run after the loop, whose vector a script could grow');
	const step = body(control, 'static int pop_shell_follow_step(', '\n}\n');
	assert.doesNotMatch(step, /pc_setpos/, 'no teleport: a portal is walked into');
	assert.match(step, /pop_find_warp_near\(sd->m, p\.follow_seen_x, p\.follow_seen_y, map_id2index\(tbl->m\)\)/, 'a portal near the last sighting, leading where the target went');
	assert.match(step, /p\.follow_next_walk = now \+ 400 \+ rnd\(\) % 800;/, 'a short pause before following through');
	assert.match(step, /return tbl->m == sd->m \? POP_LOST_TELEPORTED : POP_LOST_LEFT_MAP;/);
	const lost = body(control, 'static void pop_shell_follow_lost(', '\n}\n');
	assert.match(lost, /population_engine_is_population_pc\(tsd->id\)/, 'only a real player is attached');
});

test('removal is deferred and only removes what was asked for', () => {
	const despawn = body(control, 'bool population_engine_shell_despawn(', '\n}\n');
	assert.match(despawn, /add_timer\(gettick\(\) \+ 1, pop_shell_despawn_timer, gid,/);
	assert.doesNotMatch(despawn, /population_engine_shell_release\(/, 'never frees the shell inside the script run');
	const timer = body(control, 'static TIMER_FUNC(pop_shell_despawn_timer)\n{', '\n}\n');
	assert.match(timer, /!sd->pop\.hold\.despawn_pending/, 'an id reused meanwhile is left alone');
	assert.match(timer, /pop_is_companion\(sd\)/, 'never a companion');
});

test('a spawned actor is outside the map quotas, standing and not a shop', () => {
	assert.match(body(engine, 'static size_t population_engine_count_shells_on_map(', '\n}\n'), /!sd->pop\.hold\.spawned/);
	assert.match(body(engine, 'static size_t population_engine_count_shells_on_map_for_profile(', '\n}\n'), /sd->pop\.hold\.spawned\) continue;/);
	const spawn = body(control, 'int32_t population_engine_shell_spawn(', '\n}\n');
	assert.match(spawn, /g_pop_draft_level = 0;/, 'the level override does not leak into the next spawn');
	assert.match(spawn, /population_engine_shell_close_stall\(sd\);/, 'an actor is not a shop');
	assert.match(spawn, /if \(pc_issit\(sd\) && pc_setstand\(sd, false\)\)/, 'and arrives standing, so it can walk');
	assert.match(header, /int32_t population_engine_shell_spawn\(int32_t npc_id,/);
});

test('the commands name their words apart, like the other population and companion commands', () => {
	const defs = [...patch.matchAll(/^\+BUILDIN_DEF\((\w+), "/gm)].map(m => m[1]);
	assert.deepStrictEqual(defs.sort(), [...COMMANDS].sort());
	// population_vendor_price, companion_hire_jobs: words joined by "_", never run together.
	for (const name of ['population_isshell', 'population_whisperevent', 'population_lostevent']) {
		assert.ok(!patch.includes(name) && !doc.includes(name), `${name} is spelled with its words apart`);
	}
});

test('a job name population_spawn does not know is refused, not taken as Novice', () => {
	const spawn = body(patch, '+BUILDIN_FUNC(population_spawn)', '+BUILDIN_FUNC(population_despawn)');
	// population_engine_job_id_from_name answers 0 for an unknown name, and 0 is Novice.
	assert.match(spawn, /if \(job == 0 && strcmpi\(script_getstr\(st, 5\), "Novice"\) != 0\) \{/);
	assert.match(spawn, /Unknown job '%s'/);
	assert.match(spawn, /script_pushint\(st, 0\);\n\+\t\t\treturn SCRIPT_CMD_SUCCESS;/);
});

test('population_despawn removes only what the calling NPC may: its own actor or a free ambient shell', () => {
	const cmd = body(patch, '+BUILDIN_FUNC(population_despawn)', '+BUILDIN_FUNC(population_whisper_event)');
	assert.match(cmd, /population_engine_shell_despawn_for\(script_getnum\(st, 2\), st->oid, style\)/,
		'the script command goes through the checked call, with its own NPC id');
	const fn = body(control, 'bool population_engine_shell_despawn_for(', '\n}\n');
	assert.match(fn, /if \(npc_id == 0 \|\| !population_engine_is_population_pc\(gid\)\)\s*return false;/);
	assert.match(fn, /const bool own = sd->pop\.hold\.npc == npc_id;/);
	// Free and ambient: nobody's actor, not a vendor mid-trade, not a companion.
	assert.match(fn, /const bool free_ambient = sd->pop\.hold\.npc == 0 && population_engine_shell_kind\(gid\) == POP_SHELL_AMBIENT;/);
	assert.match(fn, /if \(!own && !free_ambient\)\s*return false;/);
	assert.match(doc, /never a\s+vendor[\s\S]*?a\s+shell\s+another\s+NPC\s+holds/, 'documented');
});
