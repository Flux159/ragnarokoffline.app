// windows-latest checks text files out with CRLF; normalise on read so assertions about file
// content do not depend on the checkout's newline convention.
// Guard the companion party-membership invariant.
//
// The bug this exists for: companions were registered through the char server,
// which persists membership as "UPDATE char SET party_id=N WHERE account_id=? AND
// char_id=?" - and population shells have no row in the char table, so the UPDATE
// matched nothing. The shell was left with status.party_id = 0, which made
// pop_is_companion() false. Everything downstream then saw no companions at all:
// the stance buttons reported "0 shells", summoned companions stood inert, and the
// self-heal sweep (which filtered on that same predicate) could never see the thing
// it existed to repair. One wrong membership path, four unrelated-looking symptoms.
//
// These are structural checks on the engine source: they assert the membership
// path is the map-local one, and that nothing filters on pop_is_companion() when
// repairing the very field that predicate requires.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const ENGINE = path.join(ROOT, 'third-party', 'population-engine', 'files', 'src', 'map', 'population_engine.cpp');

const src = fs.readFileSync(ENGINE, 'utf8').replace(/\r\n/g, '\n');

test('companion party membership is registered map-locally', () => {
	// The helper must exist and be the thing recall/draft call.
	assert.match(src, /static void pop_companion_register_local_party\(/, 'local registration helper is missing');
	assert.match(
		src,
		/static void pop_companion_register_local_party\(map_session_data \*sd, map_session_data \*owner\);/,
		'the helper needs a forward declaration: it is used above its definition'
	);
});

test('recall does not depend on a char-server round-trip for membership', () => {
	// party_reply_invite for a shell leads to an UPDATE that cannot match, leaving
	// party_id at 0. The recall path must not rely on it.
	const recallSection = src.slice(src.indexOf('static void population_engine_recall_one_companion'));
	assert.ok(recallSection.length > 0, 'recall_one_companion not found');
	const body = recallSection.slice(0, 12000);
	assert.ok(
		!/party_reply_invite\(\*shell/.test(body),
		'recall must not route a shell through party_reply_invite: the char server cannot persist a shell membership'
	);
	assert.ok(
		/pop_companion_register_local_party\(shell, owner\)/.test(body),
		'recall must register the companion locally'
	);
});

test('the self-heal timer repairs membership locally, not via the char server', () => {
	// The old timer matched on ownership too (so that assertion proved nothing), but
	// its only repair was another party_reply_invite - the round-trip that cannot
	// persist a shell. The active change is that it now calls the local register.
	const timer = src.slice(src.indexOf('static TIMER_FUNC(population_engine_recall_verify_timer)'));
	assert.ok(timer.length > 0, 'recall verify timer not found');
	const body = timer.slice(0, 2500);
	assert.ok(
		/pop_companion_register_local_party\(shell, owner\)/.test(body),
		'the self-heal must register the companion locally'
	);
	assert.ok(
		!/party_reply_invite\(\*shell/.test(body),
		'the self-heal must not retry the char-server join: it cannot persist a shell membership'
	);
});

test('drafting a companion also registers it as a party member', () => {
	const draft = src.slice(src.indexOf('uint32_t population_engine_companion_draft'));
	assert.ok(draft.length > 0, 'draft function not found');
	const body = draft.slice(0, 6000);
	assert.ok(
		/pop_companion_register_local_party\(shell, owner\)/.test(body),
		'a drafted companion must join the party the same way a recalled one does'
	);
});
