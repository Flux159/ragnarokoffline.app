// windows-latest checks text files out with CRLF; normalise on read so assertions about file
// content do not depend on the checkout's newline convention.
// Guards for companion homunculus persistence (phase 3b).
//
// The pet's own level and exp cannot live in the char server: `hom_id` stays 0, so nothing stock
// can load or save this pet (see tests/companion-homunculus.test.cjs). They live in
// `cp_companion_persistence` instead, which means the schema has to say so in TWO places - the
// CREATE TABLE literal a fresh install runs and the ALTER list an upgrade runs - and the two must
// agree, or a fresh install and an upgraded install end up with different tables.
//
// The other trap here is destructive: the recurring gear snapshot runs for every companion,
// including one whose pet is switched off or who is not an alchemist. If it wrote the pet columns
// unconditionally it would write level 0 over a level 40 pet, and the player would come back to a
// newborn with no way to tell why.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const CMDS = path.join(ROOT, 'stack', 'src', 'cmds.rs');
const ENGINE = path.join(ROOT, 'third-party', 'population-engine', 'files', 'src', 'map', 'population_engine.cpp');
const cmds = fs.readFileSync(CMDS, 'utf8').replace(/\r\n/g, '\n');
// The CREATE lives in the one schema file cmds.rs includes; the upgrade list stays in cmds.rs.
const schema = fs.readFileSync(path.join(ROOT, 'third-party', 'population-engine', 'files', 'sql-files', 'population_engine', 'cp_companion_persistence.sql'), 'utf8').replace(/\r\n/g, '\n');
const engine = fs.readFileSync(ENGINE, 'utf8').replace(/\r\n/g, '\n');

const COLUMNS = {
	hom_enabled: 'TINYINT NULL DEFAULT NULL',
	hom_class: 'INT NOT NULL DEFAULT 0',
	hom_level: 'SMALLINT NOT NULL DEFAULT 0',
	hom_exp: 'BIGINT NOT NULL DEFAULT 0',
};

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

function gearSnapshotBody() {
	return functionBody(engine, 'void population_engine_persist_companion_gear(map_session_data *sd)');
}

test('the v8 columns exist in the CREATE TABLE literal and in the ALTER list', () => {
	for (const [name, definition] of Object.entries(COLUMNS)) {
		// fresh installs
		assert.match(schema, new RegExp('`' + name + '`\\s+' + definition.replace(/ /g, '\\s+')),
			`${name} must appear in the CREATE TABLE a fresh install runs`);
		// upgrades
		assert.ok(cmds.includes(`("${name}", "${definition}")`),
			`${name} must appear in the ALTER list an upgrade runs, with the same definition`);
	}
});

test('hom_enabled is nullable, and the comments say why', () => {
	// NULL has to mean "never chosen": that is what keeps an upgrade from re-enabling a pet the
	// player switched off, and what lets the alchemist default stay on.
	assert.match(schema, /`hom_enabled`\s+TINYINT\s+NULL DEFAULT NULL/,
		'hom_enabled must be NULLable');
	assert.match(schema, /\(v8\)[\s\S]{0,700}?never chosen/,
		'the schema must record what NULL means, or the next reader will "simplify" it away');
});

test('the engine reads the stored state with the house SQL idiom', () => {
	assert.match(engine, /static void population_engine_load_shell_homunculus\(map_session_data \*sd, int \*enabled,/,
		'the loader must exist');
	assert.match(engine,
		/SELECT hom_enabled, hom_class, hom_level, hom_exp FROM `cp_companion_persistence`"\s*\n?\s*" WHERE owner_account_id=%u AND owner_char_id=%u AND shell_index=%u/,
		'the row is keyed exactly like every other per-companion read');
	assert.match(engine, /if \(SQL_SUCCESS == Sql_NextRow\(mmysql_handle\)\)/,
		'use the same read pattern as the rest of the engine');
	assert.match(engine, /Sql_FreeResult\(mmysql_handle\);/,
		'the result set must be freed');
});

test('an absent row or column keeps the pre-v8 behaviour', () => {
	// An install whose table predates v8 must not lose its pets; the defaults are the old
	// behaviour, so a failed select is a warning, not an error path that skips the pet.
	const body = functionBody(engine, 'static void population_engine_load_shell_homunculus');
	assert.match(body, /\*enabled = -1;/, '-1 must mean "never chosen"');
	assert.match(body, /if \(data != nullptr && data\[0\] != '\\0'\)/,
		'a NULL column arrives empty and must stay "never chosen" rather than becoming 0 (off)');
	assert.match(body, /if \(sd == nullptr \|\| mmysql_handle == nullptr\)\s*\n\s*return;/,
		'no database means defaults, not a crash');
});

test('the toggle is honoured at attach, and only an explicit 0 means no', () => {
	assert.match(engine, /if \(wanted == 0\)\s*\n\s*return;/,
		'only an explicit 0 may suppress the pet');
});

test('a returning pet resumes its class and level, and a stale class is survivable', () => {
	assert.match(engine, /\? static_cast<int32_t>\(stored_class\)/,
		'a remembered class must win over the derived one');
	assert.match(engine, /hom_class = HM_CLASS_BASE \+ static_cast<int32_t>\(index % 8\);[\s\S]{0,220}?homun_db = homunculus_db\.homun_search\(hom_class\);/,
		'a class the data set no longer has must fall back instead of costing the pet');
	assert.match(engine, /homun\.level = \(stored_level > 0\) \? static_cast<int32_t>\(stored_level\) : 1;/,
		'level must be restored - hom_alloc derives exp_next from it, so a level-1 pet with a level-40 threshold would look stalled forever');
	assert.match(engine, /homun\.exp = static_cast<t_exp>\(stored_exp\);/,
		'exp must be restored with the engine\'s own type');
});

test('the recurring snapshot writes the pet state only when a pet exists', () => {
	const body = gearSnapshotBody();
	assert.match(body, /hom_frag\[0\] = '\\0';/,
		'the fragment must default to empty');
	assert.match(body, /if \(sd->hd != nullptr\) \{[\s\S]{0,400}?snprintf\(hom_frag/,
		'the write must be guarded by the pet existing, or a switched-off companion loses its level');
	assert.match(body, /", hom_class=%d, hom_level=%d, hom_exp=%lld"/,
		'the fragment must carry the pet\'s live state');
	assert.match(body, /\(int\)sd->hd->homunculus\.level/,
		'the level written must come from the live pet');
	assert.match(body, /" mode=%d, duty=%d, heal_at=%d, emergency_at=%d(, given_mask=%u)?%s"/,
		'the fragment must actually be interpolated into the statement');
	assert.match(body, /hom_frag,\s*\n\s*owner, sd->pop\.companion_owner_char, index_\);/,
		'and bound to the right placeholder');
});

test('persistence never reaches the char server and never invents a hom_id', () => {
	const body = codeOnly(engine);
	assert.ok(!/homun\.hom_id\s*=/.test(body) && !/sd->status\.hom_id\s*=/.test(body),
		'hom_id must stay 0 - it is what makes every char-server path a no-op');
	assert.ok(!/intif_homunculus_[a-z_]+\s*\(/.test(body.replace(/`intif_homunculus_create`/g, '')),
		'no char-server call may be introduced');
});

test('creating a row that already exists keeps the player\'s choices', () => {
	// REPLACE deletes and re-inserts, so re-inviting an expelled companion reset every column the
	// statement does not list: the skill selection, the pet switch and its level, favorite, stance,
	// duty and heal thresholds. The row write must be an upsert that leaves them alone.
	const body = functionBody(engine, 'static void population_engine_persist_companion_sql(');
	assert.ok(!/REPLACE INTO/.test(codeOnly(body)), 'the companion row must not be written with REPLACE');
	assert.match(body, /ON DUPLICATE KEY UPDATE/, 'the companion row must be an upsert');
	const update = body.slice(body.indexOf('ON DUPLICATE KEY UPDATE'));
	for (const kept of ['skill_preset', 'hom_enabled', 'hom_level', 'hom_exp', 'favorite', 'mode', 'duty', 'heal_at', 'emergency_at'])
		assert.match(update, new RegExp(` ${kept}=IF\\(owner_account_id=VALUES\\(owner_account_id\\) AND owner_char_id IN \\(0, VALUES\\(owner_char_id\\)\\), ${kept},`),
			`${kept} must survive a re-invite by the same owner`);
	assert.ok(update.indexOf('emergency_at=IF(') < update.indexOf(' owner_account_id=VALUES(owner_account_id)'),
		'the owner comparisons must run before owner_account_id is overwritten');
});
