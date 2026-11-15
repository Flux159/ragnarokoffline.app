// windows-latest checks text files out with CRLF; normalise on read so assertions about file
// content do not depend on the checkout's newline convention.
// Guards for temporary recruits: with Settings -> Population -> Recruits are temporary on, a
// character recruited from the world goes back to the world when it leaves the party, its owner
// logs out, or at the owner's next login after a shutdown. Hired and drafted companions are saved
// as before, and so is a recruit holding gear its owner gave it. The feature lives in
// runtime/population_companion_temporary.cpp; the engine reaches it from lines marked
// RAGNAROKMAC (temporary recruits).
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8').replace(/\r\n/g, '\n');
const MAP = ['third-party', 'population-engine', 'files', 'src', 'map'];
const src = read(...MAP, 'population_engine.cpp');
const temp = read(...MAP, 'population_engine', 'runtime', 'population_companion_temporary.cpp');
const schema = read('third-party', 'population-engine', 'files', 'sql-files', 'population_engine', 'cp_companion_persistence.sql');
const cmds = read('stack', 'src', 'cmds.rs');
const patch = read('third-party', 'population-engine', 'patches', '0040-companion-recruit-temporary.patch');
const main = read('electron', 'main.js');
const settings = read('src', 'settings.html');
const { lines, companionRecruitTemporary } = require('../electron/population-conf');

function body(text, signature) {
	const i = text.indexOf(signature);
	assert.ok(i >= 0, `${signature} not found`);
	return text.slice(i, text.indexOf('\n}\n', i));
}

test('the feature is its own file, reached from marked lines', () => {
	assert.match(src, /#include "population_engine\/runtime\/population_companion_temporary\.hpp"/);
	assert.match(src, /#include "population_engine\/runtime\/population_companion_temporary\.cpp"/,
		'included at the end like the roam file, so it reaches the engine helpers');
});

test('the setting runs from Settings to battle_conf, off by default', () => {
	assert.match(patch, /^\+\{ "population_engine_companion_recruit_temporary",&battle_config\.population_engine_companion_recruit_temporary,0,0,1,\},$/m);
	assert.match(patch, /^\+int32 population_engine_companion_recruit_temporary;$/m);
	assert.match(main, /population_companion_recruit_temporary: false,/);
	assert.match(settings, /id="population_companion_recruit_temporary"/);
	assert.match(settings, /settings\.population_companion_recruit_temporary = \$\('population_companion_recruit_temporary'\)\.checked;/);
	assert.match(settings, /\$\('population_companion_recruit_temporary'\)\.checked = s\.population_companion_recruit_temporary === true;/);
	assert.equal(companionRecruitTemporary({}), 0);
	assert.equal(companionRecruitTemporary({ population_companion_recruit_temporary: true }), 1);
	assert.match(lines({}), /^population_engine_companion_recruit_temporary: 0$/m);
	assert.match(lines({ population_companion_recruit_temporary: true }), /^population_engine_companion_recruit_temporary: 1$/m);
});

test('the mark is a column of its own, added to an existing table too', () => {
	assert.match(schema, /`temporary`\s+TINYINT\s+NOT NULL DEFAULT 0,/);
	assert.match(cmds, /\("temporary", "TINYINT NOT NULL DEFAULT 0"\),/);
});

test('only a new row of a world recruit is marked, and only while the setting is on', () => {
	const recruit = body(src, 'void population_engine_persist_recruited_companion(');
	const kept = recruit.indexOf('population_companion_row_kept(');
	const persist = recruit.indexOf('population_engine_persist_companion_row(sd, owner);');
	const mark = recruit.indexOf('population_companion_temporary_mark(');
	assert.ok(kept >= 0 && persist > kept && mark > persist,
		'whether the row existed is asked before the row is written, and the mark comes after');
	const markBody = body(temp, 'void population_companion_temporary_mark(');
	assert.match(markBody, /if \(!battle_config\.population_engine_companion_recruit_temporary \|\| !fresh/);
	// The draft path (hire, Summon tab) never goes through the recruit hook.
	const draft = src.slice(src.indexOf('// Persist immediately: the row is the companion'), src.indexOf('population_shell_gear_drafted(shell);'));
	assert.ok(!draft.includes('temporary'), 'a hired or drafted companion is never temporary');
});

test('a temporary recruit is dropped when it leaves, unless it holds its owner\'s gear', () => {
	assert.match(body(src, 'void population_engine_set_companion_active('),
		/if \(!active\)\n\t\tpopulation_companion_temporary_drop\(index_\);/);
	assert.match(body(src, 'void population_engine_deactivate_expelled_companion('),
		/if \(population_companion_temporary_drop\(index_\)\)\n\t\tpopulation_companion_temporary_let_go\(index_\);/,
		'expelled from the party window, it stops being a companion, or the party rebuild puts it back');
	assert.match(body(temp, 'void population_companion_temporary_let_go('), /pop_companion_set_owner\(shell, nullptr\);/);
	assert.match(body(src, 'void population_engine_on_owner_quit('),
		/population_engine_shell_release\(shell\);\n\t\tpopulation_companion_temporary_drop\(index_\);/);
	assert.match(body(src, 'int population_engine_recall_companions('),
		/if \(only_index == 0\)\n\t\tpopulation_companion_temporary_drop_all\(owner\);/);
	const drop = body(temp, 'bool population_companion_temporary_drop(');
	const persist = drop.indexOf('population_engine_persist_companion_gear(live);');
	const guard = drop.indexOf('population_engine_companion_holds_given_gear(owner_account, index_)');
	const mask = drop.indexOf('live->pop.companion_given_mask != 0');
	const del = drop.indexOf('DELETE FROM `cp_companion_persistence`');
	assert.ok(persist >= 0 && guard > persist && mask > guard && del > mask,
		'a live companion\'s gear is written first, then the shared gear check and its live mask decide, then the row goes');
	assert.match(drop, /if \(owner_char == 0 \|\| pop_online_char\(owner_account\) != owner_char\)\n\t\treturn false;/,
		'without the owning character online the recruit is kept, never deleted blind');
	assert.match(drop, /WHERE owner_account_id=%u AND owner_char_id=%u AND shell_index=%u AND temporary=1/);
	assert.match(body(temp, 'void population_companion_temporary_mark('),
		/SET temporary=1"\n\t\t" WHERE owner_account_id=%u AND owner_char_id=%u AND shell_index=%u"/);
	assert.match(drop, /if \(!temporary\)\n\t\treturn false;/, 'a saved companion is never deleted');
});

test('the login sweep leaves a live companion alone', () => {
	const all = body(temp, 'void population_companion_temporary_drop_all(');
	assert.match(all, /if \(pop_temporary_live_shell\(index_\) == nullptr\)\n\t\t\tpopulation_companion_temporary_drop\(index_\);/);
});
