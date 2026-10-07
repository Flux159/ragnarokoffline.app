// windows-latest checks text files out with CRLF; normalise on read so assertions about file
// content do not depend on the checkout's newline convention.
// Guards for three bugs found from the live server log after the party-membership
// fix went in. Each was reproduced from log evidence first, and each assertion
// below fails against the commit that shipped it.
//
// 1. "@companion summon <name>" called the batch recall, so summoning one companion
//    re-placed and re-broadcast EVERY companion - which visibly undid a bench the
//    player had just made ("pressing summon removed every companion").
//    Log evidence: only index 352's active flag changed, then "recalled 8".
//
// 2. Companions stood still. The placement-recovery branch reset its throttle
//    before knowing the placement succeeded, so a failing shell re-warped every
//    tick. Log evidence: "recovered off-map companion Hanazia" thirteen times in a
//    row; a shell teleported that often cannot walk.
//
// 3. The party window stayed empty at boot and filled only on a later pass. The
//    post-recall resync asked the char server (party_request_info) for a party
//    whose companion rows it does not have, so nothing came back.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const ENGINE = path.join(ROOT, 'third-party', 'population-engine', 'files', 'src', 'map', 'population_engine.cpp');
const HPP = path.join(ROOT, 'third-party', 'population-engine', 'files', 'src', 'map', 'population_engine.hpp');
const STATE = path.join(ROOT, 'third-party', 'population-engine', 'files', 'src', 'map', 'population_engine', 'core', 'population_shell_state.hpp');
const PATCH6 = path.join(ROOT, 'third-party', 'population-engine', 'patches', '0007-companion-gear-return.patch');

const src = fs.readFileSync(ENGINE, 'utf8').replace(/\r\n/g, '\n');
const hpp = fs.readFileSync(HPP, 'utf8').replace(/\r\n/g, '\n');
const state = fs.readFileSync(STATE, 'utf8').replace(/\r\n/g, '\n');
const patch6 = fs.readFileSync(PATCH6, 'utf8').replace(/\r\n/g, '\n');

test('recall can target a single companion index', () => {
	assert.match(hpp, /population_engine_recall_companions\(map_session_data \*owner, uint32_t only_index = 0\)/,
		'recall needs an optional only_index so one companion can be recalled alone');
	assert.match(src, /WHERE owner_account_id=%u AND owner_char_id=%u AND active=1%s/, 'the recall query must be able to filter by shell_index');
	assert.match(src, /only_index != 0 \? " AND shell_index=" : ""/, 'the filter must be applied from only_index');
});

test('@companion summon recalls only the named companion', () => {
	// The patch ships the atcommand change, so assert on the added line there. The
	// removed line is still present in the diff as a '-' entry, which is why this
	// checks the '+' form rather than the absence of the old text.
	assert.match(patch6, /^\+\t\tconst int n = population_engine_recall_companions\(sd, index_\);/m,
		'summon must pass the resolved index, not call the batch');
	// And confirm the batch call for that site was actually replaced.
	const added = (patch6.match(/^\+\t\tconst int n = population_engine_recall_companions\(sd, index_\);/gm) || []).length;
	const removed = (patch6.match(/^-\t\tconst int n = population_engine_recall_companions\(sd\);/gm) || []).length;
	assert.strictEqual(added, 1, 'expected exactly one added summon call with the index');
	assert.strictEqual(removed, 1, 'expected the batch summon call to be removed');
});

test('the placement recovery backs off instead of re-warping every tick', () => {
	const branch = src.slice(src.indexOf('if (sd->prev == nullptr) {', src.indexOf('static bool pop_companion_follow_owner')));
	assert.ok(branch.length > 0, 'recovery branch not found');
	const head = branch.slice(0, 1800);
	// The throttle must be set inside the success path, not before the attempt.
	assert.match(head, /if \(warp_near_owner\(\)\) \{[\s\S]{0,200}?companion_follow_next = now \+ 400/,
		'the throttle must only reset when the placement succeeded');
	assert.match(head, /placement_fail_streak/, 'a failure must be counted for backoff');
	assert.match(state, /placement_fail_streak/, 'the streak needs storage on the shell');
});

test('the post-recall resync registers locally instead of asking the char server', () => {
	const recall = src.slice(src.indexOf('int population_engine_recall_companions'));
	const body = recall.slice(0, 10000);
	assert.match(body, /pop_companion_register_local_party\(shell, owner\)/,
		'the resync must register companions locally');
	assert.ok(!/party_request_info\(owner->status\.party_id/.test(body),
		'the resync must not ask the char server: companion rows do not exist there');
});

// ── The next two, from the log after the previous round. ─────────────────────
//
// A drafted companion stood frozen and was absent from the companion window,
// because the draft path never added the shell to g_population_engine_pcs - the
// vector every driver walks (follow/combat tick, stale sweep, gear poll, and the
// live-level lookup behind @companion list raw). Its party row existed, which is
// why it showed in the party window but nowhere else.
//
// The party list "refreshed" on relogin because party_recv_info() (party.cpp)
// memcpy's the char server's party over the map's own, then clears data[]: the
// char server has no companion rows (a shell has no `char` row), so every rebuild
// dropped them. The companions now have to be re-asserted after each rebuild.
const PATCH5 = path.join(ROOT, 'third-party', 'population-engine', 'patches', '0006-population-companion-persistence.patch');
const patch5 = fs.readFileSync(PATCH5, 'utf8').replace(/\r\n/g, '\n');

test('a drafted companion is added to the shell registry', () => {
	const draft = src.slice(src.indexOf('uint32_t population_engine_companion_draft'));
	assert.ok(draft.length > 0, 'draft function not found');
	const body = draft.slice(0, 6000);
	assert.match(body, /g_population_engine_pcs\.push_back\(shell\)/,
		'a drafted shell must enter g_population_engine_pcs or nothing will ever drive it');
	assert.match(body, /g_population_engine_count\+\+/, 'the live count must include drafted companions');
});

test('companion party rows are re-asserted after a party rebuild', () => {
	// The function exists...
	assert.match(src, /void population_engine_reassert_companions\(int32_t party_id\)/,
		'the reassert helper is missing');
	assert.match(hpp, /void population_engine_reassert_companions\(int32_t party_id\);/, 'it needs a declaration');
	// ...and party_recv_info, the rebuild site, calls it.
	// One tab of indentation in the source; assert on the statement, not the indent.
	assert.match(patch5, /^\+\s*population_engine_reassert_companions\(sp->party_id\);/m,
		'party_recv_info must re-assert companions after rebuilding from the char server');
});

test('the reassert helper restores both the member row and the data pointer', () => {
	const fn = src.slice(src.indexOf('void population_engine_reassert_companions'));
	assert.ok(fn.length > 0, 'helper not found');
	const body = fn.slice(0, 3500);
	assert.match(body, /p->data\[i\]\.sd = sd;/, 'the live session pointer must be restored, not just the row');
	assert.match(body, /p->party\.count\+\+/, 'the member count must be adjusted');
	assert.match(body, /clif_party_info/, 'the window must be told');
});

test('roster changes are pushed to the client, not polled', () => {
	// Polling via the atcommand would write one atcommandlog row per tick (1,200 an
	// hour with the window open). The roster instead pushes the same @CP lines the
	// panel already parses, from the paths that actually change it.
	assert.match(src, /void population_engine_push_companion_list\(map_session_data \*owner\)/,
		'the push helper is missing');
	assert.match(hpp, /void population_engine_push_companion_list\(map_session_data \*owner\);/, 'it needs a declaration');
	// Every roster-changing path must call it.
	const sites = [
		['draft', /drafted companion/, 6000],
		['recruit', /population_engine_persist_recruited_companion/, 4000],
	];
	for (const [label, anchor] of sites) {
		const i = src.search(anchor);
		assert.ok(i > 0, `${label} path not found`);
		const body = src.slice(i, i + 5000);
		assert.match(body, /population_engine_push_companion_list/, `${label} must push the roster`);
	}
});

test('the panel replaces the list from a batch and redraws only on change', () => {
	const js = fs.readFileSync(path.join(ROOT, 'patches', 'CompanionPanel.js'), 'utf8').replace(/\r\n/g, '\n');
	// Rows accumulate into a pending batch, swapped in at the sentinel, so a
	// half-arrived list is never shown.
	assert.match(js, /_pending\.push\(\{/, 'rows must collect into the pending batch');
	assert.match(js, /_roster = fresh;/, 'the batch must replace the list at the sentinel');
	// A manual refresh must be visible even when nothing changed.
	assert.match(js, /_forceRedraw = true;/, 'a manual refresh needs a forced redraw');
});

test('the draft path CREATES the persistence row, not just updates it', () => {
	// persist_companion_gear() is the recurring UPDATE. Called for a shell with no
	// row it affects zero rows and reports no error, so the companion exists in the
	// world and in the party but not in cp_companion_persistence - and
	// @companion list raw reads that table, so the panel stays empty however often
	// Refresh is pressed. A row can only come from persist_companion_sql (a REPLACE).
	const draft = src.slice(src.indexOf('uint32_t population_engine_companion_draft'));
	assert.ok(draft.length > 0, 'draft function not found');
	const body = draft.slice(0, 6500);
	assert.match(body, /population_engine_persist_companion_row\(/, 'the draft must create the row');
	assert.ok(!/population_engine_persist_companion_gear\(shell\)/.test(body),
		'the draft must not rely on the UPDATE-only snapshot: it cannot create a row');
});

test('both spawn paths share one row-creating function', () => {
	// Recruit and draft must not be able to drift again - this is the third
	// omission of the same class on this project (registry push, then party
	// registration, now the insert).
	assert.match(src, /bool population_engine_persist_companion_row\(map_session_data \*sd, const map_session_data \*owner\)/,
		'the shared row insert is missing');
	const calls = (src.match(/population_engine_persist_companion_row\(/g) || []).length;
	assert.ok(calls >= 3, `expected the helper to be declared and called from both paths, saw ${calls} mentions`);
	const recruit = src.slice(src.indexOf('void population_engine_persist_recruited_companion'));
	assert.match(recruit.slice(0, 7000), /population_engine_persist_companion_row\(sd, owner\)/,
		'the recruit path must use the shared insert too');
});

test('the gear command resolves a name of any word count before the slot list', () => {
	// The atcommand header splits once: cmd = first word, param = the whole remainder.
	// Treating that remainder as the name made `@companion gear Talivis armor` look up
	// "Talivis armor" and report it as not in the saved list, while the slot parser
	// separately assumed exactly two leading tokens. Longest-prefix resolution is what
	// makes a name and a trailing argument list coexist.
	assert.ok(patch6.includes('companion_resolve_name_and_tail'),
		'patch 0006 must carry the name+tail resolver');
	assert.ok(patch6.includes('for (size_t cut = len; cut > 0; --cut)'),
		'the resolver must scan cut points from the end so the longest name wins');
	assert.ok(patch6.includes('safestrncpy(slots, gear_tail'),
		'the slot parser must read the resolved tail, not re-split the raw message');
	assert.ok(!patch6.includes('sscanf(message, "%*31s %*23s'),
		'the old two-token assumption must be gone');
});

test('removing a companion pushes the updated roster', () => {
	assert.ok(patch6.includes('population_engine_push_companion_list(sd);'),
		'remove must push so an open panel drops the row');
});

test('the panel offers a delete button with an in-window confirmation', () => {
	const js = fs.readFileSync(path.join(ROOT, 'patches', 'CompanionPanel.js'), 'utf8').replace(/\r\n/g, '\n');
	const css = fs.readFileSync(path.join(ROOT, 'patches', 'CompanionPanel.css'), 'utf8').replace(/\r\n/g, '\n');
	assert.ok(js.includes('confirmInWindow'), 'the panel needs a confirmation path');
	// Check for a CALL, not the string: the file explains in a comment why the blocking
	// dialog is not used, and a naive substring test trips on its own explanation.
	// Strip both comment forms before looking: this file explains in prose why the
	// blocking dialog is not used, and a naive substring test trips on its own
	// explanation (it did, twice - first on the // form, then on the * form).
	const code = js
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.split('\n')
		.map(l => l.replace(/\/\/.*$/, ''))
		.join('\n');
	const blocking = [/window\.confirm\s*\(/, /window\.alert\s*\(/, /window\.prompt\s*\(/]
		.filter(re => re.test(code));
	assert.deepStrictEqual(blocking, [],
		'a blocking browser dialog freezes the game loop; the confirmation must be drawn in-window');
	assert.ok(js.includes('@companion remove '), 'the confirmed action must be the remove command');
	assert.ok(css.includes('.confirm-overlay'), 'the overlay needs styling');
	assert.ok(css.includes('button.danger'), 'the destructive button needs its own look');
});

test('releasing a shell clears the party slot that pointed at it', () => {
	// The crash: SIGSEGV (signal 0xb) in party_send_xy_timer+0x8c immediately
	// after @companion remove. That timer is periodic and does
	//
	//     map_session_data* sd = p->data[i].sd;
	//     if (!sd) continue;                  // guards null, NOT dangling
	//     if (p->data[i].x != sd->x || ...)   // dereferences it
	//
	// reassert put a shell pointer in data[].sd; party_member_withdraw clears the
	// member row but not that pointer, so freeing the shell left the party holding
	// freed memory. The release path must clear every slot that points at it.
	const rel = src.slice(src.indexOf('void population_engine_shell_release'));
	assert.ok(rel.length > 0, 'shell_release not found');
	const body = rel.slice(0, 4000);
	assert.match(body, /pd->data\[slot\]\.sd == sd/,
		'release must find the party slot holding this shell');
	assert.match(body, /pd->data\[slot\]\.sd = nullptr;/, 'and null it before the shell is freed');
});

test('the re-assert matches the owner character, not just the account', () => {
	// One account, two characters, two parties: map_id2sd() resolves by account
	// and may return the sibling, which registered a companion into the wrong
	// character's party (the crash report shows 're-asserted ... party 2' while
	// the owner was in party 7).
	const fn = src.slice(src.indexOf('void population_engine_reassert_companions'));
	const body = fn.slice(0, 3500);
	assert.match(body, /owner->status\.party_id != party_id/,
		'the account-resolved session must be rejected when it is in another party');
	assert.match(body, /pop_companion_owned_by\(sd, cand\)/,
		'and the party must be scanned for the right real member');
});
