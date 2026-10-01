// windows-latest checks text files out with CRLF; normalise on read so assertions about file
// content do not depend on the checkout's newline convention.
// Guards for the second round of companion growth work:
//   * the 3rd-job gate on the extra point grant (and that it is tunable, not
//     hard-coded, so the number can be changed without a rebuild)
//   * the ownership-based recovery that stops a companion being silently
//     expelled when the char server replays the party without it
//   * the local party-window level broadcast (the stock path is a char-server
//     round trip that drops shells, so levels only ever updated on a map change)
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const ENGINE = path.join(ROOT, 'third-party', 'population-engine', 'files', 'src', 'map', 'population_engine.cpp');
const STATE = path.join(ROOT, 'third-party', 'population-engine', 'files', 'src', 'map', 'population_engine', 'core', 'population_shell_state.hpp');
const PATCH7 = path.join(ROOT, 'third-party', 'population-engine', 'patches', '0008-companion-growth.patch');

const src = fs.readFileSync(ENGINE, 'utf8').replace(/\r\n/g, '\n');
const state = fs.readFileSync(STATE, 'utf8').replace(/\r\n/g, '\n');
// Tolerate a missing file: run against an earlier commit (patch 0007 did not
// exist yet) the assertions below must fail on their own terms, not crash here.
const patch7 = fs.existsSync(PATCH7) ? fs.readFileSync(PATCH7, 'utf8').replace(/\r\n/g, '\n') : '';

test('the extra point grant is a battle config, not a hard-coded constant', () => {
	// A formula baked into the source means changing the companion economy costs
	// a full image rebuild; the grant must be readable from battle_conf.
	assert.match(patch7, /population_engine_companion_points_per_level/,
		'the grant must be a battle_config key so it can be tuned at runtime');
	assert.match(src, /battle_config\.population_engine_companion_points_per_level/,
		'and the engine must read that key when granting points');
	assert.match(patch7, /\{\s*"population_engine_companion_points_per_level"/,
		'the key needs an init-table row or it is never registered');
});

test('the grant only applies from 3rd job onward', () => {
	// The user's rule: 1st/2nd/trans keep the stock economy so the levelling ramp
	// is visible, and the surge lands when the job line reaches 3rd.
	const i = src.indexOf('population_engine_companion_points_per_level');
	assert.ok(i > 0, 'grant site not found');
	const around = src.slice(i - 1400, i + 700);
	assert.match(around, /pre_third/,
		'the gate must be expressed as an explicit pre-3rd exclusion set');
	assert.match(around, /jid >= 1 && jid <= 23/,
		'novice + 1st + 2nd jobs (0..23) must be excluded from the grant');
	assert.match(around, /jid >= 4001 && jid <= 4022/,
		'transcendent jobs (4001..4022) must be excluded - they advance to 3rd, not 4th');
	assert.match(around, /if \(!pre_third\)/,
		'and the grant must sit behind that exclusion');
});

test('a companion dropped by a party rebuild is healed by ownership, not released', () => {
	// party_recv_info() replays the char server's party, which has no row for a
	// shell, so pop_companion_owner() (party_id match) returns null and the dead
	// branch released the companion. Ownership is the durable identity.
	const i = src.indexOf('re-registered companion %s into');
	assert.ok(i > 0, 'the ownership recovery must exist');
	const around = src.slice(i - 1200, i + 600);
	assert.match(around, /sd->pop\.companion_owner_account != 0/,
		'it must key on the persisted owner account, not the party link');
	assert.match(around, /pop_companion_register_local_party\(sd, cand\)/,
		'and re-register the local party row so pop_is_companion() sees it again');
	assert.match(around, /owner = pop_companion_owner\(sd\)/,
		'then retry the owner lookup so the branch falls into the respawn path');
});

test('the party window level is re-broadcast locally on level-up', () => {
	// pc.cpp calls party_send_levelup(), which is intif_party_changemap() to the
	// char server: a shell has no char row, so the level never reached other
	// clients and only refreshed on a map change.
	assert.match(state, /last_party_level_broadcast/,
		'the shell must track the level it last pushed to the party window');
	const i = src.indexOf('last_party_level_broadcast');
	const around = src.slice(i - 200, i + 1200);
	assert.match(around, /pd->party\.member\[slot\]\.lv = sd->status\.base_level/,
		'the member row must be updated, not just a packet sent');
	assert.match(around, /clif_party_info\(\*pd, nullptr\)/,
		'and the party window re-broadcast from the map own data');
	assert.ok(!/party_request_info/.test(around),
		'must NOT ask the char server - it has no row for a shell');
});
