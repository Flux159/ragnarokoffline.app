// Companions belong to a CHARACTER, not an account.
//
// Found while testing 1.4.0: companions recruited by character 1 appeared in character 2's list
// (same account), stayed in the world after character 1 logged out, and followed nobody. Every
// lookup keyed on owner_account_id, and map_id2sd(account) - "the owner" - returns whichever
// character of that account is logged in. These guards pin the invariants that fix it.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const PE = path.join(ROOT, 'third-party', 'population-engine');
const engine = fs.readFileSync(path.join(PE, 'files', 'src', 'map', 'population_engine.cpp'), 'utf8').replace(/\r\n/g, '\n');
const schema = fs.readFileSync(path.join(PE, 'files', 'sql-files', 'population_engine', 'cp_companion_persistence.sql'), 'utf8');
const patches = fs.readdirSync(path.join(PE, 'patches')).filter(f => f.endsWith('.patch')).sort()
	.map(f => fs.readFileSync(path.join(PE, 'patches', f), 'utf8').replace(/\r\n/g, '\n')).join('\n');

function functionBody(signature) {
	const i = engine.lastIndexOf(signature);
	assert.ok(i >= 0, `expected to find ${signature}`);
	const rest = engine.slice(i);
	return rest.slice(0, rest.indexOf('\n}\n') + 3);
}

test('the row records the owning character', () => {
	assert.match(schema, /`owner_char_id`\s+INT UNSIGNED\s+NOT NULL DEFAULT 0/);
	assert.match(schema, /KEY `idx_owner_char` \(`owner_account_id`, `owner_char_id`\)/);
});

test('every query on the companion table is keyed by character as well as account', () => {
	const uses = [...engine.matchAll(/owner_account_id=%u(.{0,24})/g)];
	assert.ok(uses.length >= 15, `expected the per-owner queries, found ${uses.length}`);
	for (const [whole, after] of uses)
		assert.ok(after.startsWith(' AND owner_char_id='), `account-only query: ...${whole}`);
	// The account itself is still written, as before.
	assert.match(functionBody('static void population_engine_persist_companion_sql('),
		/\(owner_account_id, owner_char_id, shell_index,/);
});

test('"the owner" of a companion is the owning character\'s session, never the account\'s', () => {
	const code = engine.replace(/^\s*\/\/.*$/gm, '').replace(/^\s*\/\/\/.*$/gm, '');
	const lookups = [...code.matchAll(/map_id2sd\([^)]*companion_owner_account\)/g)];
	assert.equal(lookups.length, 1, 'only pop_companion_owner_session may resolve an owner by account');
	assert.match(functionBody('static map_session_data *pop_companion_owner_session('),
		/sd->status\.char_id != shell->pop\.companion_owner_char/);
	const assigns = [...code.matchAll(/companion_owner_account\s*=[^=]/g)];
	assert.equal(assigns.length, 1, 'owner is set in one place, with the character');
	assert.ok(!/companion_owner_account\s*==\s*\w+->status\.account_id/.test(
		code.replace(functionBody('static bool pop_companion_owned_by('), '')),
		'ownership comparisons go through pop_companion_owned_by');
	// rAthena's trade hook, too.
	assert.ok(!/^\+.*companion_owner_account\s*==/m.test(patches), 'patches compare ownership with the helper');
});

test('a re-invite keeps the player\'s choices only for the same character', () => {
	const body = functionBody('static void population_engine_persist_companion_sql(');
	const update = body.slice(body.indexOf('ON DUPLICATE KEY UPDATE'));
	assert.match(update, /skill_preset=IF\(owner_account_id=VALUES\(owner_account_id\) AND owner_char_id IN \(0, VALUES\(owner_char_id\)\), skill_preset,/);
	assert.ok(update.indexOf('given_mask=IF(') < update.indexOf(' owner_char_id=VALUES(owner_char_id)'),
		'the comparisons must run before owner_char_id is overwritten');
});

test('rows saved before this are claimed by the first character of the account to log in', () => {
	const claim = functionBody('static void pop_claim_unowned_companions(');
	assert.match(claim, /SET owner_char_id=%u"\s*\n\s*" WHERE owner_account_id=%u AND owner_char_id=0"/,
		'only unclaimed rows of this account, and all of them');
	const recall = functionBody('int population_engine_recall_companions(');
	assert.ok(recall.indexOf('pop_claim_unowned_companions(owner)') > 0
		&& recall.indexOf('pop_claim_unowned_companions(owner)') < recall.indexOf('SELECT shell_index'),
		'the claim runs at login, before the recall reads its rows');
});

test('a character\'s companions leave with it, whoever logs in next', () => {
	assert.match(patches, /^\+\s*if \(!IS_POPULATION_ENGINE_ACCOUNT_ID\(sd->status\.account_id\) && global_core->is_running\(\)\)\n\+\s*population_engine_on_owner_quit\(sd\);/m,
		'map_quit (logout and character select) must hand the leaving character to the engine');
	const quit = functionBody('void population_engine_on_owner_quit(');
	assert.match(quit, /pop_companion_owned_by\(shell, owner\)/, 'exactly this character\'s companions');
	assert.ok(quit.indexOf('population_engine_persist_companion_gear(shell)') < quit.indexOf('population_engine_shell_release(shell)'),
		'saved before they are despawned');
});

test('the population master switch turns companions off without touching their rows', () => {
	// Off: nothing recalled at login, no row claimed or read...
	const recall = functionBody('int population_engine_recall_companions(');
	const gate = recall.indexOf('if (!battle_config.population_engine_enable) return 0;');
	assert.ok(gate > 0 && gate < recall.indexOf('pop_claim_unowned_companions(owner)'),
		'recall must stop before it claims or reads anything');
	// ...and every @companion subcommand refused up front, as @populate is (patch 0002).
	const acmd = patches.slice(patches.lastIndexOf(' ACMD_FUNC(companion)\n'));
	assert.match(acmd.slice(0, 600),
		/^ \tnullpo_retr\(-1, sd\);\n(?:\+.*\n)*?\+\tif \(!battle_config\.population_engine_enable\) \{\n\+\t\tclif_displaymessage\(fd, "The population engine is disabled\. Turn it on in the app's settings\."\);\n\+\t\treturn -1;/m,
		'@companion must answer like @populate before any subcommand runs');
});
