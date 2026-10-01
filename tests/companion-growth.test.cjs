// windows-latest checks text files out with CRLF; normalise on read so assertions about file
// content do not depend on the checkout's newline convention.
// Guards for companion growth (stat/trait spending, job advancement) and the
// selective gear return. Each assertion fails against the commit before the one
// that added the behaviour.
//
// The first test is the buffer guard: the recall SELECT grew past its
// `char q[560]` buffer when the v4 costume/shadow columns were added, and
// snprintf truncated the SQL mid-WHERE ("Unknown column 'owner_acc'"), so login
// recall silently returned 0 and every companion vanished from the party on
// every restart. Any future column addition must grow the buffer with it.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const ENGINE = path.join(ROOT, 'third-party', 'population-engine', 'files', 'src', 'map', 'population_engine.cpp');
const CONFIG = path.join(ROOT, 'third-party', 'population-engine', 'files', 'src', 'map', 'population_engine', 'config', 'population_config.cpp');
const TYPES = path.join(ROOT, 'third-party', 'population-engine', 'files', 'src', 'map', 'population_engine', 'config', 'population_yaml_types.hpp');
const PATCH6 = path.join(ROOT, 'third-party', 'population-engine', 'patches', '0007-companion-gear-return.patch');
const CMDS = path.join(ROOT, 'stack', 'src', 'cmds.rs');

const src = fs.readFileSync(ENGINE, 'utf8').replace(/\r\n/g, '\n');
const types = fs.readFileSync(TYPES, 'utf8').replace(/\r\n/g, '\n');
const config = fs.readFileSync(CONFIG, 'utf8').replace(/\r\n/g, '\n');
const patch6 = fs.readFileSync(PATCH6, 'utf8').replace(/\r\n/g, '\n');
const cmds = fs.readFileSync(CMDS, 'utf8').replace(/\r\n/g, '\n');
// The CREATE lives in the one schema file cmds.rs includes; the upgrade list stays in cmds.rs.
const schema = fs.readFileSync(path.join(ROOT, 'third-party', 'population-engine', 'files', 'sql-files', 'population_engine', 'cp_companion_persistence.sql'), 'utf8').replace(/\r\n/g, '\n');

test('the recall SELECT buffer can hold the full column list', () => {
	// Pull the actual snprintf format string out of the recall function and
	// render it with the widest plausible values, then compare to its buffer.
	const fn = src.slice(src.indexOf('int population_engine_recall_companions'));
	assert.ok(fn.length > 0, 'recall function not found');
	const buf = fn.match(/char q\[(\d+)\]/);
	assert.ok(buf, 'recall must declare a fixed query buffer');
	const capacity = Number(buf[1]);

	// Rebuild the SQL the same way the C++ does: concatenated literals.
	const literals = [...fn.matchAll(/"((?:[^"\\]|\\.)*)"/g)]
		.map(m => m[1])
		.filter(s => /SELECT|FROM/.test(s) || /nameid|_level|str_|pow_/.test(s));
	assert.ok(literals.length > 0, 'could not extract the SELECT literals');
	let sql = literals.join('');
	// substitute the format specifiers with worst-case renderings
	sql = sql.replace(/%u/g, '9999999999').replace(/%d/g, '-2147483648').replace(/%s/g, '');
	// plus the appended " AND shell_index=<n>"
	const rendered = sql.length + ' AND shell_index=4294967295'.length;
	assert.ok(rendered < capacity,
		`recall SQL renders to ~${rendered} bytes but the buffer is ${capacity}; ` +
		'adding columns without growing this buffer truncates the query mid-WHERE ' +
		'and the recall silently returns nothing');
});

test('every persisted trait column is written by the recurring UPDATE', () => {
	// The snapshot UPDATE is what carries post-recruit changes; a column added to
	// the SELECT but not the UPDATE stays 0 forever.
	const upd = src.slice(src.indexOf('void population_engine_persist_companion_gear'));
	const body = upd.slice(0, 4000);
	for (const col of ['pow_', 'sta_', 'wis_', 'spl_', 'con_', 'crt_']) {
		assert.ok(body.includes(`${col}=%d`) || body.includes(`${col}=%u`),
			`the snapshot UPDATE must write ${col} or grown traits never persist`);
	}
	assert.match(body, /job_id=%d/, 'a job change only survives a restart if the UPDATE writes job_id');
});

test('trait stats are declared in the profile type and parsed from YAML', () => {
	for (const t of ['pow', 'sta', 'wis', 'spl', 'con', 'crt']) {
		assert.ok(new RegExp(`int16_t ${t}_min`).test(types),
			`${t}_min must exist on the profile type or the YAML value is dropped`);
		assert.ok(new RegExp(`"${t.charAt(0).toUpperCase() + t.slice(1)}"`).test(config),
			`the config parser must read the ${t} key`);
	}
});

test('spending uses the real stat APIs and honors the server cap', () => {
	const fn = src.slice(src.indexOf('pop_companion_spend_stat_points'));
	const body = fn.slice(0, 4000);
	assert.match(body, /pc_statusup\(/, 'base stats must be spent through pc_statusup so cost scaling applies');
	assert.match(body, /pc_traitstatusup\(/, 'trait points go through pc_traitstatusup');
	assert.match(body, /bs\.cur >= 500/, 'the server maxparameter cap (500) must be respected');
	assert.match(body, /guard/, 'the spend loop needs a hard iteration cap');
});

test('job advancement walks the full line with a 50:50 fork and official gates', () => {
	const fn = src.slice(src.indexOf('static uint16_t pop_companion_next_job'));
	const body = fn.slice(0, 3000);
	assert.match(body, /job_id == 0 && base_lv >= 10/, 'a Novice must pick a 1st job at base 10');
	assert.match(body, /rnd\(\) % 2/, 'forked lines take a coin flip, not a fixed branch');
	assert.match(body, /rnd\(\) % 6/, 'the Novice line is a uniform six-way roll');
	// official gates present in the table
	const table = src.slice(src.indexOf('kPopJobAdvanceTable'));
	assert.match(table, /\{\s*1,\s*7,\s*14,\s*40,\s*0\s*\}/, 'Swordsman -> Knight|Crusader at base 40');
	assert.match(table, /99,\s*70/, '2nd -> trans and trans -> 3rd use the 99/70 gate');
	assert.match(table, /200,\s*70/, '3rd -> 4th uses the 200/70 gate');
	assert.match(table, /4,\s*8,\s*15/, 'Acolyte forks to Priest or Monk');
});

test('a job change re-equips and re-arms rather than leaving stale gear', () => {
	const fn = src.slice(src.indexOf('pop_companion_try_job_advance'));
	const body = fn.slice(0, 4000);
	assert.match(body, /pc_jobchange\(/, 'job changes go through pc_jobchange');
	assert.match(body, /pc_unequipitem\(sd, i, 2\)/, 'the old job gear is unequipped, not destroyed');
	assert.match(body, /skill_next_use_tick\.clear\(\)/, 'the skill preset must be re-armed for the new job');
	assert.match(body, /population_engine_shell_equip_item\(sd/, 'and the new job Eden set equipped');
});

test('the gear command resolves the name before parsing slots', () => {
	// A two-word name plus a slot list cannot be split by a single whitespace pass:
	// the old form looked up "Talivis armor" and reported it missing.
	assert.ok(patch6.includes('companion_resolve_name_and_tail'),
		'the gear path must resolve the longest name prefix first');
	assert.ok(patch6.includes('safestrncpy(slots, gear_tail'),
		'the slot parser must read the resolved tail, not re-split the raw message');
	assert.ok(patch6.includes('mask |= EQP_'), 'slot names must map to the equip_pos bitmask');
	for (const slot of ['weapon', 'shield', 'armor', 'shoes', 'garment', 'acc', 'head', 'costume', 'shadow', 'ammo']) {
		assert.ok(patch6.includes(`"${slot}"`), `the ${slot} slot name must be accepted`);
	}
	assert.ok(patch6.includes('const int moved = population_engine_companion_return_gear(sd, live, mask)'),
		'and the parsed mask must reach the engine call');
});

test('the boot DDL carries the v5 trait columns for fresh installs', () => {
	// CREATE TABLE IF NOT EXISTS means a fresh install would silently lack any
	// column missing here - the live DBs only got them because they were ALTERed
	// by hand, so the boot path must be complete on its own.
	for (const col of ['pow_', 'sta_', 'wis_', 'spl_', 'con_', 'crt_']) {
		assert.ok(schema.includes('`' + col + '`'),
			`the boot DDL must declare ${col}; IF NOT EXISTS means a fresh install never gets it otherwise`);
	}
	assert.ok(/ADD COLUMN IF NOT EXISTS/.test(cmds),
		'existing installs are migrated by the ALTER loop, which must stay idempotent');
});
