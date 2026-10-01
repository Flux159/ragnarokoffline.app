// windows-latest checks text files out with CRLF; normalise on read so assertions about file
// content do not depend on the checkout's newline convention.
// Guards for the per-companion skill selector (phase 1: storage + command).
//
// The feature's whole risk is a WIRING omission, not a logic error: a skill
// selection is useless if one of the four places that must carry it is missed.
// That is this project's documented recurring failure class - a new column
// threaded through three of four touchpoints (recruit REPLACE, recurring
// snapshot UPDATE, recall SELECT, and the shell-field assignment after it) leaves
// the others silently wrong, and the map server reports it only as
// "Unknown column" at login, or not at all.
//
// So every assertion here pins a RELATIONSHIP, not a string:
//   * the recall SELECT lists skill_preset  AND  the row reader reads it
//     AND  it is passed to recall_one_companion  AND  that function declares the
//     parameter  AND  restores it
//   * the seeder calls the filter  AND  the filter is DEFINED in that same
//     translation unit (a call without its definition is a link error, and a grep
//     for the call alone passes on exactly that broken version)
//   * the v7 column exists in the CREATE  AND  in the idempotent migration loop
//     (CREATE TABLE IF NOT EXISTS is a no-op on an existing table, so a column
//     missing from the loop never reaches a player who already installed)
//
// Calibration: run against the parent commit; the wiring tests below must fail
// there, which is what proves they exercise the change and not a pre-existing fact.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const PE = path.join(ROOT, 'third-party', 'population-engine');
const MAP = path.join(PE, 'files', 'src', 'map');
const ENGINE = path.join(MAP, 'population_engine.cpp');
const COMBAT = path.join(MAP, 'population_engine', 'runtime', 'population_engine_combat.cpp');
const STATE = path.join(MAP, 'population_engine', 'core', 'population_shell_state.hpp');
const HPP = path.join(MAP, 'population_engine.hpp');
const CMDS = path.join(ROOT, 'stack', 'src', 'cmds.rs');
const SQL = path.join(PE, 'files', 'sql-files', 'population_engine', 'cp_companion_persistence.sql');
const PATCH = path.join(PE, 'patches', '0009-companion-skill-selector.patch');

const read = p => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

test('the shell carries a selection AND a flag that distinguishes "none chosen" from "never chosen"', () => {
	const s = read(STATE);
	// The flag is load-bearing: the seeders rebuild a list while it is EMPTY, so
	// without it a player who unticked everything would silently get the whole
	// class preset list back on the next tick.
	assert.match(s, /std::vector<uint16_t> skill_override;/,
		'the per-shell selection must exist');
	assert.match(s, /bool\s+skill_override_active = false;/,
		'a flag must separate "nothing chosen" from "never chosen" - emptiness alone cannot');
});

test('both public entry points are declared', () => {
	const h = read(HPP);
	assert.match(h, /int population_engine_companion_set_skill_override\(uint32_t owner_account, const char\* name_,/,
		'the setter must be declared for the atcommand to call');
	assert.match(h, /void population_engine_companion_skill_list\(uint32_t owner_account, const char\* name_, int fd\);/,
		'the lister must be declared for the atcommand to call');
});

test('the atcommand branch ships AND calls both entry points', () => {
	// atcommand.inc is a rathena-side file: it is not copied from files/, so the
	// PATCH is the artifact that ships. Asserting on a bench copy would prove the
	// wrong thing.
	const p = read(PATCH);
	assert.match(p, /strcmpi\(cmd, "skills"\)/,
		'the @companion skills branch must be in the patch that ships');
	assert.match(p, /population_engine_companion_skill_list\(/,
		'the list form must call the lister');
	assert.match(p, /population_engine_companion_set_skill_override\(/,
		'the set form must call the setter');
	// Longest-prefix name resolution, the same helper `gear` uses: a plain
	// whitespace split would break on a multi-word companion name.
	assert.match(p, /companion_resolve_name_and_tail\(/,
		'the name must be resolved with the shared longest-prefix matcher');
});

test('the selection is threaded through ALL FOUR recall touchpoints', () => {
	const e = read(ENGINE);

	// 1. the SELECT column list
	assert.match(e, /shadow_acc_r_nameid, skill_preset"/,
		'the recall SELECT must fetch skill_preset');

	// 2. the row reader must tolerate NULL, which is the "auto" state
	const reader = e.slice(e.indexOf('uint32_t sh_acc_r = atoi(data);'));
	assert.match(reader.slice(0, 900),
		/Sql_GetData\(mmysql_handle, col\+\+, &data, nullptr\);\s*\n\s*if \(data != nullptr\)/,
		'the reader must test the column for NULL rather than copying it blindly');

	// 3. the call site passes it
	assert.match(e, /mode_, duty_, heal_at_, emergency_at_,\s*\n\s*skill_preset\);/,
		'recall_companions must PASS the selection to recall_one_companion');

	// 4. the callee declares it
	assert.match(e, /int mode_, int duty_, int heal_at_, int emergency_at_,\s*\n\s*const char\* skill_preset\)/,
		'recall_one_companion must take the selection as a parameter');

	// and restores it, gated on non-NULL so "auto" stays auto
	assert.match(e, /if \(skill_preset != nullptr\) \{[\s\S]{0,220}skill_override_active = true;/,
		'the selection must be restored on the respawned shell, and only when the column was not NULL');
});

test('the seeders filter on the selection AND the filter is defined in that translation unit', () => {
	const c = read(COMBAT);

	// A call whose definition is missing still greps positive; the pairing is what
	// matters - the same trap the client-component gate exists for.
	assert.match(c, /static bool population_shell_skill_selected\(const map_session_data \*sd, uint16_t skill_id\)/,
		'the filter must be DEFINED in the file that calls it');

	const calls = c.match(/population_shell_skill_selected\(sd, e\.skill_id\)/g) || [];
	assert.ok(calls.length >= 2,
		`the filter must gate BOTH the attack rotation and the buff list (found ${calls.length} call(s))`);

	// Each call must precede its push, not follow it.
	const attackIdx = c.indexOf('population_shell_skill_selected(sd, e.skill_id)');
	const attackPush = c.indexOf('population_shell_push_attack_skill_candidate(sd, e.skill_id');
	assert.ok(attackIdx > 0 && attackPush > attackIdx,
		'the attack filter must run before the candidate is pushed');
	const buffIdx = c.lastIndexOf('population_shell_skill_selected(sd, e.skill_id)');
	const buffPush = c.indexOf('sd->pop.buff_skills.push_back(bs)');
	assert.ok(buffIdx > 0 && buffPush > buffIdx,
		'the buff filter must run before the buff is pushed');
});

test('the v7 column reaches BOTH a fresh install and an existing one', () => {
	const r = read(CMDS);
	// Fresh install: the CREATE TABLE, in the schema file cmds.rs includes.
	assert.match(r, /include_str!\(".*cp_companion_persistence\.sql"\)/,
		'the supervisor must run the schema file, not a copy of it');
	assert.match(read(SQL), /`skill_preset`\s+TEXT\s+NULL DEFAULT NULL/,
		'the CREATE must carry the column for a fresh install');
	// Existing install: the idempotent migration loop. Without this a player who
	// installed before v7 keeps the old schema and every selection write fails.
	assert.match(r, /\("skill_preset", "TEXT NULL DEFAULT NULL"\)/,
		'the ADD COLUMN IF NOT EXISTS loop must carry the column too');
});

test('the documentation copy of the schema carries the column', () => {
	// The vendored .sql must agree with cmds.rs; it had silently drifted to v4
	// while cmds.rs reached v6, which is how a "documented" column goes missing.
	assert.match(read(SQL), /`skill_preset`\s+TEXT\s+NULL DEFAULT NULL/,
		'the vendored schema doc must list skill_preset');
});

test('the SQL statement buffers have room for the grown statements', () => {
	const e = read(ENGINE);

	// snprintf truncates SILENTLY: a recall SELECT that outgrows its char q[N]
	// breaks with "Unknown column" mid-WHERE and disables recall entirely, which is
	// how companions once vanished on every restart. v7 added a column to that
	// statement, so the buffer must still have headroom.
	const selectQ = e.match(/char q\[(\d+)\];\s*\/\/ must fit the full v4 recall SELECT/);
	assert.ok(selectQ, 'the recall buffer must still carry its sizing comment');
	assert.ok(Number(selectQ[1]) >= 1024,
		`the recall statement buffer must stay generous (found ${selectQ && selectQ[1]})`);

	// The selection UPDATE has its own buffer, and it must hold a full list of skill
	// ids with their separators. Assert on the buffer belonging to THAT statement —
	// the function also has a small lookup buffer, and measuring that one would
	// pass while the statement that actually grows is undersized.
	const updIdx = e.indexOf('SET skill_preset=');
	assert.ok(updIdx > 0, 'the selection UPDATE must exist');
	const beforeUpd = e.slice(0, updIdx);
	const lastQ = [...beforeUpd.matchAll(/char q\[(\d+)\];/g)].pop();
	assert.ok(lastQ, 'the UPDATE must declare a statement buffer');
	// 60 skills at 5 chars ("12345,") is 300 bytes; 512 is the documented floor.
	assert.ok(Number(lastQ[1]) >= 512,
		`the selection UPDATE buffer must hold a long skill list (found ${lastQ && lastQ[1]})`);
});
