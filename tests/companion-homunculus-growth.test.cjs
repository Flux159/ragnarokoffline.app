// windows-latest checks text files out with CRLF; normalise on read so assertions about file
// content do not depend on the checkout's newline convention.
// Guards for companion homunculus growth (phase 3a).
//
// Growth is deliberately NOT implemented in our code: mob.cpp pays
// `hom_gainexp(tmpsd[i]->hd, base_exp * battle_config.homunculus_exp_gain / 100)` to every exp
// receiver that owns a homunculus, so a shell's in-memory pet is paid on its own kills exactly as
// a player's is. What our code must do is leave the machinery hom_gainexp/hom_levelup depend on
// intact - `hd->homunculusDB` and `hd->exp_next` are set by hom_alloc - and NOT add a second award
// path that would double-pay.
//
// Why this is worth a file: a second award path looks harmless and is invisible; and a pet whose
// exp_next was zeroed looks exactly like a pet that "isn't growing".
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const ENGINE = path.join(ROOT, 'third-party', 'population-engine', 'files', 'src', 'map', 'population_engine.cpp');
const engine = fs.readFileSync(ENGINE, 'utf8').replace(/\r\n/g, '\n');

const HELPER_SIG = 'static void population_engine_sync_shell_homunculus(map_session_data *sd)\n{';

// A negative assertion must not be satisfiable by prose - the attach's own comment names the
// char-server calls it avoids.
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

// attachBody asserts the function exists first, so the negative assertions below cannot pass
// vacuously against a tree where the attach does not exist at all.
function attachBody() {
	return functionBody(engine, HELPER_SIG);
}

test('the dump carries the pet\'s own level and exp, so growth is readable', () => {
	assert.match(engine, /@SHELLHOMAI\|%u\|%u\|%d\|%d\|%d\|%d\|%lld\|%lld\|%d/,
		'the dump line must carry level, exp, exp_next and skill points');
	assert.match(engine, /static_cast<long long>\(sd->hd->homunculus\.exp\)/,
		'exp must be read from the pet\'s s_homunculus');
	assert.match(engine, /static_cast<long long>\(sd->hd->exp_next\)/,
		'exp_next is the threshold a level-up compares against - without it a stalled pet is undiagnosable');
	assert.match(engine, /\(int\)sd->hd->homunculus\.skillpts/,
		'a level grants a skill point every 3 levels, so it belongs in the same reading');
	assert.match(engine, /\(int\)sd->hd->homunculus\.level/,
		'the level must come from the pet');
});

test('the engine never awards homunculus exp itself', () => {
	// mob.cpp already pays the pet; a second award here would double-pay silently.
	assert.ok(!/hom_gainexp\s*\(/.test(codeOnly(engine)),
		'exp must come from the stock kill path, not from us');
});

test('the attach goes through hom_alloc, which is what initialises growth', () => {
	const body = attachBody();
	assert.match(body, /hom_alloc\(sd, &homun\);/,
		'hom_alloc sets homunculusDB and exp_next; assigning sd->hd directly would produce a pet that cannot level');
	assert.ok(!/sd->hd\s*=/.test(codeOnly(body)),
		'never allocate the pet by hand - that skips the growth state');
	// and do not set the fields hom_alloc owns
	assert.ok(!/exp_next\s*=/.test(codeOnly(body)),
		'exp_next is hom_alloc\'s to set from the exp table');
	assert.ok(!/homunculusDB\s*=/.test(codeOnly(body)),
		'homunculusDB is hom_alloc\'s to set');
});

test('a new pet starts at the bottom, and only a remembered one resumes higher', () => {
	const body = attachBody();
	// Superseded by phase 3b: the level used to be hardcoded to 1. It is now the stored level when
	// there is one, and 1 otherwise - the branch that matters is still the default, because a pet
	// that appeared pre-levelled would make growth meaningless.
	assert.match(body, /homun\.level = \(stored_level > 0\) \? static_cast<int32_t>\(stored_level\) : 1;/,
		'level is the stored value, or 1 for a pet that has never been out before');
	// Superseded too: exp is restored from the row. What must hold is that it comes from the row
	// and not from a literal, and that the loader defaults it to 0, so a new pet starts empty.
	assert.match(body, /homun\.exp = static_cast<t_exp>\(stored_exp\);/,
		'exp is restored from the persisted value');
	assert.match(functionBody(engine, 'static void population_engine_load_shell_homunculus'),
		/\*exp_ = 0;/,
		'the loader must default exp to 0, which is what makes a new pet start empty');
	assert.ok(!/homun\.skillpts\s*=/.test(codeOnly(body)),
		'skill points are granted by hom_levelup, not by the attach');
});

test('the class chosen is one the level-up path can resolve', () => {
	// hom_levelup calls hom_class2mapid(class_); the ids it accepts are 6001-6008 (plus evolved and
	// S blocks). HM_CLASS_BASE is 6001, so the modulo must be exactly 8 to stay inside that block.
	const body = attachBody();
	assert.match(body, /HM_CLASS_BASE \+ static_cast<int32_t>\(index % 8\)/,
		'a class outside 6001-6008 would make hom_class2mapid return -1 and silently stop all growth');
});

test('the attach does not save through the char server on a shell', () => {
	const body = codeOnly(attachBody());
	assert.ok(!/hom_save|intif_homunculus/.test(body),
		'a synthetic char_id means a save would target a row that does not exist');
});
