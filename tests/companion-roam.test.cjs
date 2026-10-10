// windows-latest checks text files out with CRLF; normalise on read so assertions about file
// content do not depend on the checkout's newline convention.
// Guards for roaming: a companion its owner sets to roam (Companions window, @companion roam)
// walks the map on its own like a field shell instead of following, and every companion says
// "I'm down!" in party chat when it dies, with its row in the window marked until revived.
// The feature lives in runtime/population_companion_roam.cpp; the engine reaches it from lines
// marked RAGNAROKMAC (roam), and a companion that follows behaves as it did before.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8').replace(/\r\n/g, '\n');
const MAP = ['third-party', 'population-engine', 'files', 'src', 'map'];
const src = read(...MAP, 'population_engine.cpp');
const hpp = read(...MAP, 'population_engine.hpp');
const combat = read(...MAP, 'population_engine', 'runtime', 'population_engine_combat.cpp');
const roam = read(...MAP, 'population_engine', 'runtime', 'population_companion_roam.cpp');
const state = read(...MAP, 'population_engine', 'core', 'population_shell_state.hpp');
const schema = read('third-party', 'population-engine', 'files', 'sql-files', 'population_engine', 'cp_companion_persistence.sql');
const cmds = read('stack', 'src', 'cmds.rs');
const patch = read('third-party', 'population-engine', 'patches', '0034-companion-roam-command.patch');
const panel = read('patches', 'CompanionPanel.js');
const main = read('electron', 'main.js');
const settings = read('src', 'settings.html');
const { lines, companionRoam } = require('../electron/population-conf');

function body(text, signature) {
	const i = text.indexOf(signature);
	assert.ok(i >= 0, `${signature} not found`);
	return text.slice(i, text.indexOf('\n}\n', i));
}

test('the feature is its own file, reached from marked lines', () => {
	assert.match(src, /#include "population_engine\/runtime\/population_companion_roam\.hpp"/);
	assert.match(src, /#include "population_engine\/runtime\/population_companion_roam\.cpp"/,
		'included at the end, like population_shell_control.cpp, so it reaches the engine\'s helpers');
	assert.ok((src.match(/RAGNAROKMAC \(roam\)/g) || []).length >= 10, 'every engine hook is marked');
	assert.match(state, /bool companion_roam = false;/, 'a companion follows unless its owner says otherwise');
	assert.match(roam, /return battle_config\.population_engine_companion_roam && sd != nullptr && sd->pop\.companion_roam\s*&& pop_is_companion\(sd\);/,
		'and only while the server allows roaming');
});

test('roaming is a setting in the app, off by default', () => {
	assert.match(patch, /^\+\{ "population_engine_companion_roam",&battle_config\.population_engine_companion_roam,0,0,1,\},$/m);
	assert.match(patch, /^\+int32 population_engine_companion_roam;$/m);
	assert.match(main, /population_companion_roam: false,/);
	assert.match(settings, /id="population_companion_roam"/);
	assert.match(settings, /settings\.population_companion_roam = \$\('population_companion_roam'\)\.checked;/);
	assert.match(settings, /\$\('population_companion_roam'\)\.checked = s\.population_companion_roam === true;/);
	assert.equal(companionRoam({}), 0);
	assert.equal(companionRoam({ population_companion_roam: true }), 1);
	const base = { population_enable: true, population_max: 100 };
	assert.match(lines(base), /^population_engine_companion_roam: 0$/m);
	assert.match(lines({ ...base, population_companion_roam: true }), /^population_engine_companion_roam: 1$/m);
});

test('while it is off, nothing in game mentions roaming', () => {
	assert.match(patch, /if \(strcmpi\(cmd, "roam"\) == 0 && battle_config\.population_engine_companion_roam\) \{/,
		'an unknown subcommand while off');
	assert.ok(!/^\+.*Usage: @companion list[^\n]*roam/m.test(patch), 'and not in the usage line');
	assert.match(src, /if \(!battle_config\.population_engine_companion_roam\) \/\/ RAGNAROKMAC \(roam\)\n\t\t\troam = -1;/,
		'the roster tells the window there is no control to draw');
	assert.match(panel, /canRoam: parts\[15\] === '0' \|\| parts\[15\] === '1',/);
	assert.match(panel, /const roam = !m\.canRoam \? null : _button\(/);
	assert.match(panel, /if \(_roster\.some\(m => m\.canRoam\)\) \{/, 'no Movement row on the Battle tab either');
	assert.ok(!/roam/i.test(/_button\('Recall'[^\n]*/.exec(panel)[0]), 'nor in the Recall tooltip');
	assert.match(roam, /void population_companion_roam_recalled[\s\S]*?if \(!population_companion_roams\(sd\)\)\s*return;/,
		'and Recall keeps a saved choice while it is off');
});

test('a roaming companion is off the leash but still changes maps with its owner', () => {
	const follow = body(src, 'static bool pop_companion_follow_owner(');
	const roams = follow.indexOf('if (population_companion_roams(sd)) // RAGNAROKMAC (roam)\n\t\treturn true;');
	assert.ok(roams > 0, 'it returns before the walk-back and the in-sight warp');
	assert.ok(follow.indexOf('if (sd->m != owner->m) {') < roams, 'but after the map-change follow');
	assert.match(follow, /if \(population_companion_roams\(sd\)\) \/\/ RAGNAROKMAC \(roam\)[^\n]*\n\t\tleash = INT16_MAX;/);
});

test('it walks on when it has nothing to fight, with the field shells\' own steps', () => {
	assert.match(combat, /if \(hired_companion && tid == 0\) \{\s*population_companion_roam_step\(sd, current_tick\);[^\n]*\n\s*return;/);
	const step = body(roam, 'void population_companion_roam_step(');
	assert.match(step, /if \(!population_companion_roams\(sd\)/, 'a following companion stays calm, as before');
	assert.match(step, /population_shell_movetype3_get_target\(/);
	assert.match(step, /population_shell_try_roam_step\(sd\);/);
	assert.match(src, /&& !population_companion_roams\(sd\)\) \/\/ RAGNAROKMAC \(roam\): nor its own walk/,
		'the companion loop must not stop its walk');
	assert.match(src, /&& !population_companion_roams\(sd\)\) \/\/ RAGNAROKMAC \(roam\)\n\t\t\tpop_companion_update_formation/,
		'nor walk it into formation');
});

test('it fights near itself, and a rest is not cut short by a monster walking past', () => {
	assert.match(src, /population_companion_roam_target\(sd, pop_companion_combat_target\(sd, owner, now\)\)/);
	const target = body(roam, 'uint32 population_companion_roam_target(');
	assert.match(target, /check_distance_bl\(sd, bl, AREA_SIZE\)/, 'the owner\'s fight across the map is not its fight');
	assert.match(target, /!resting \|\| desired == sd->pop\.last_attacker_id \|\| desired == pop_companion_party_threat\(sd\)/,
		'while resting only an attack on it or on a party member near it gets it up');
	assert.match(target, /companion_mode != PopulationCompanionMode::Attack \|\| resting\)\s*return 0;/,
		'it hunts only in Attack mode, and not while resting');
	assert.match(target, /population_shell_check_target_alive\(sd\)/, 'around itself, not its owner');
	assert.match(src, /\|\| \(unit_is_walking\(owner\) && !population_companion_roams\(sd\)\)/,
		'its owner walking elsewhere is no reason to stand up');
});

test('the setting is saved per companion, restored on recall, and Recall ends it', () => {
	assert.match(schema, /`roam`\s+TINYINT\s+NOT NULL DEFAULT 0,/);
	assert.match(cmds, /\("roam", "TINYINT NOT NULL DEFAULT 0"\)/, 'an existing table gets the column too');
	assert.match(roam, /UPDATE `cp_companion_persistence` SET roam=%d/);
	assert.match(src, /population_companion_roam_restore\(owner\); \/\/ RAGNAROKMAC \(roam\)/);
	assert.match(src, /roam=IF\(owner_account_id=VALUES\(owner_account_id\)[^"]*, roam, 0\),/,
		'a row re-recruited by someone else starts following');
	assert.match(src, /population_companion_roam_recalled\(bot\);/);
});

test('@companion roam sets one companion or all of them', () => {
	assert.match(patch, /population_engine_companion_set_roam\(sd->status\.account_id, param, on, reply, sizeof\(reply\)\);/);
	assert.match(patch, /\+\tchar cmd\[32\], param\[128\] = "";/, 'a bare subcommand reads an empty parameter');
	assert.ok(!/^@@ .*@@ ./m.test(patch),
		'no function names in the hunk headers: the master-switch test finds ACMD_FUNC(companion) by text');
	assert.match(hpp, /int population_engine_companion_set_roam\(uint32_t owner_account, const char \*name, bool roam,/);
});

test('a companion that dies says so, and its row shows it until it is revived', () => {
	const death = body(src, 'void population_engine_on_shell_death(');
	assert.match(death, /population_companion_on_down\(sd\);/);
	const down = body(roam, 'void population_companion_on_down(');
	assert.match(down, /"%s : I'm down! \(%s %d, %d\)"/, 'with where it fell');
	assert.match(down, /party_send_message\(sd, msg, strlen\(msg\) \+ 1\);/);
	assert.match(down, /population_engine_push_companion_list_for_shell\(sd\);/);
	assert.match(src, /population_companion_watch_life\(sd\);[^\n]*\n(?:\t+\/\/[^\n]*\n)*\t+if \(pc_isdead\(sd\)\)/,
		'the life watch runs before dead companions are skipped');
	assert.match(src, /"@CP\|%s\|%s\|%d\|%d\|%d\|%d\|%s\|%d\|%d\|%d\|%d\|%d\|%d\|%d\|%d\|%d",[\s\S]*?rest_until, roam, dead\);/);
	assert.match(src, /dead = pc_isdead\(sd\) \? 1 : 0;/);
});

test('the Companions window switches it, without typing', () => {
	assert.match(panel, /roam: parts\[15\] === '1',\s*dead: parts\[16\] === '1'/);
	assert.match(panel, /m\.roam !== _roster\[i\]\.roam \|\| m\.dead !== _roster\[i\]\.dead/, 'a change redraws the window');
	assert.match(panel, /talk\(`@companion roam \$\{m\.name\} \$\{m\.roam \? 'off' : 'on'\}`, false\)/);
	assert.match(panel, /talk\('@companion roam off', false\)/);
	assert.match(panel, /talk\('@companion roam on', false\)/);
	assert.match(panel, /'Movement \(whole party\)'/);
	assert.match(panel, /\(m\.dead \? '✝ ' : ''\)/);
});
