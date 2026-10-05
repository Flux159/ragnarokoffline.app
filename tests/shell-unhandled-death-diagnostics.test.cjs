// Diagnostics for ambient shells left at 0 HP without dying (#373).
//
// Some shells reach 0 HP without rAthena's dead flag, walk the map for good and never respawn.
// How is not known yet, so the engine records the three moments that tell the causes apart (a hit
// took it to 0 HP, pc_dead handled the death, the respawn timer found it no longer dead) and logs
// a shell once when the wander sweep finds it in that state. It does not repair the shell: the
// point is to see the cause, not hide it.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const MAP = path.join(__dirname, '..', 'third-party', 'population-engine', 'files', 'src', 'map');
const read = (p) => fs.readFileSync(path.join(MAP, p), 'utf8').replace(/\r\n/g, '\n');
const engine = read('population_engine.cpp');
const sweep = read('population_engine/runtime/population_engine_path.cpp');
const state = read('population_engine/core/population_shell_state.hpp');

test('the shell state carries the three diagnostic fields', () => {
	for (const field of ['diag_zero_hp_tick', 'diag_death_tick', 'diag_unhandled_logged'])
		assert.ok(state.includes(field), field);
});

test('the hit to 0 HP and the death pc_dead handles are both recorded', () => {
	assert.match(engine, /if \(status_isdead\(\*sd\)\)\n\t\tsd->pop\.diag_zero_hp_tick = sd->pop\.last_attacked_tick;/);
	assert.match(engine, /sd->pop\.diag_death_tick = gettick\(\);/);
	assert.match(engine, /\[#373\] respawn of shell %u \(%s\) skipped: 0 HP but not dead/,
		'a respawn that finds the dead flag gone says so');
});

test('the wander sweep logs such a shell once and leaves it as it is', () => {
	assert.match(sweep, /if \(status_isdead\(\*sd\)\)\n\t\t\tpop_shell_log_unhandled_death\(sd, now\);\n\t\telse\n\t\t\tsd->pop\.diag_unhandled_logged = false;/);
	const i = sweep.indexOf('void pop_shell_log_unhandled_death(');
	const body = sweep.slice(i, sweep.indexOf('\n}\n', i));
	assert.match(body, /if \(sd->pop\.diag_unhandled_logged\)\n\t\treturn;/, 'once per shell');
	assert.ok(!/status_kill|status_revive|battle_status\.hp =/.test(body), 'diagnostics only: no repair');
});
