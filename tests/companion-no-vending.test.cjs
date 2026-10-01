// windows-latest checks text files out with CRLF; normalise on read so assertions about file
// content do not depend on the checkout's newline convention.
// Guards for item 9: a recruited or drafted companion must not stand in vending mode.
//
// The mechanism this pins, all of it read out of the code rather than inferred from the symptom:
//
//   * population_engine_spawn_shell() decides vending from the PROFILE. A merchant-line shell
//     resolves a vendor config (or the built-in default stock) and runs
//     `sd->state.prevend = 1; vending_openvending(...)`.
//   * vending_openvending consumes `prevend` and sets `state.vending = true`. That live flag is
//     what the engine's own shell drivers test, which is why a vending companion stops following.
//   * Nothing in that path asks whether the shell is a companion.
//   * The fix is NOT in that block, and cannot be: both companion paths call spawn_shell() and
//     assign companion_owner_account only AFTERWARDS (draft: spawn -> owner; recall: spawn ->
//     owner), so a companion test inside spawn would never fire.
//
// So the stall is closed where companion status IS known: the local-party funnel that every
// draft/recall/re-sync/repair passes through, and the recruit hook that adopts an ambient vendor.
//
// NOTE ON ANCHORS: three of these functions have forward declarations whose text is a PREFIX of
// the definition, so `indexOf(name)` finds the declaration and every assertion then reads the wrong
// region - silently, usually as a passing test. Every lookup below therefore anchors on the
// definition's own signature INCLUDING its opening brace, which the declaration does not have.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const ENGINE = path.join(ROOT, 'third-party', 'population-engine', 'files', 'src', 'map', 'population_engine.cpp');
const engine = fs.readFileSync(ENGINE, 'utf8').replace(/\r\n/g, '\n');

function definitionBody(signatureWithBrace) {
	const i = engine.indexOf(signatureWithBrace);
	assert.ok(i > 0, `expected to find the definition ${JSON.stringify(signatureWithBrace)}`);
	const rest = engine.slice(i);
	const end = rest.indexOf('\n}\n');
	assert.ok(end > 0, 'definition body must close');
	return rest.slice(0, end + 3);
}

const CLOSE_SIG = 'static void population_engine_shell_close_stall(map_session_data *sd)\n{';
const FUNNEL_SIG = 'static void pop_companion_register_local_party(map_session_data *sd, map_session_data *owner)\n{';
const RECRUIT_SIG = 'void population_engine_persist_recruited_companion(map_session_data *sd, map_session_data *peer)\n{';
const SPAWN_SIG = 'PopulationDbSource db_source)\n{';

test('the close helper is declared before it is used, and defined once', () => {
	const decl = engine.indexOf('static void population_engine_shell_close_stall(map_session_data *sd);');
	const defn = engine.indexOf(CLOSE_SIG);
	assert.ok(decl > 0, 'the forward declaration must exist: the recruit hook precedes the definition');
	assert.ok(defn > decl, 'the definition must be found AFTER the declaration, not the declaration again');
	// the declaration exists because the recruit hook (which is earlier in the file) calls it
	const recruit = engine.indexOf(RECRUIT_SIG);
	assert.ok(recruit > 0 && decl < recruit, 'the declaration must precede the recruit hook that uses it');
});

test('the engine closes a stall instead of letting a companion vend', () => {
	const body = definitionBody(CLOSE_SIG);
	assert.match(body, /if \(sd->state\.vending\)\s*\n\s*vending_closevending\(sd\);/,
		'state.vending is the LIVE flag (openvending consumes prevend and sets it), so the close must be vending_closevending');
	assert.match(body, /sd->state\.prevend = 0;/,
		'and the intent flag the spawn path sets must be cleared too');
	assert.ok(!/pc_cart_clear|pc_delitem|itemdb_remove/.test(body),
		'closing the stall must not touch inventory: the cart and its stock are not the player\'s goods');
});

test('every path that makes a shell a companion party member goes through the close', () => {
	const funnel = definitionBody(FUNNEL_SIG);
	assert.match(funnel, /population_engine_shell_close_stall\(sd\);/,
		'the local-party funnel covers the draft, the recall, the re-sync and the repair sweep');
	// before the PARTY-ID guard, so a companion whose owner has no usable party yet still loses the
	// stall (the helper does its own null check, so the null guard may precede it)
	const closeAt = funnel.indexOf('population_engine_shell_close_stall(sd)');
	const partyGuard = funnel.indexOf('party_id <= 0');
	assert.ok(closeAt > 0 && partyGuard > 0 && closeAt < partyGuard,
		'the close must run before the party-id guard, or an owner without a party yet skips it');
});

test('the recruit hook closes a stall on an adopted ambient vendor', () => {
	const recruit = definitionBody(RECRUIT_SIG);
	assert.match(recruit, /population_engine_shell_close_stall\(sd\);/,
		'an invited shell may have been a town vendor, vendored at its own spawn before any invite');
});

test('ambient town vendors still vendor — the fix must not blunt the vendor feature', () => {
	assert.match(engine, /pc_skill\(sd, MC_VENDING, 10, ADDSKILL_PERMANENT_GRANTED\);/,
		'the vendor block must still grant MC_VENDING');
	assert.match(engine, /vending_openvending\(\*sd, vend_title, vend_data, vend_count, nullptr\);/,
		'and must still open the stall for an ambient vendor');
	const spawnBody = definitionBody(SPAWN_SIG);
	assert.ok(spawnBody.includes('vending_openvending(*sd'),
		'the vendor block must still live in the spawn path');
	assert.ok(!/population_engine_shell_close_stall/.test(spawnBody),
		'the close does not belong in spawn_shell: companion_owner_account is assigned by the callers afterwards');
});
