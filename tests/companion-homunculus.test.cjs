// windows-latest checks text files out with CRLF; normalise on read so assertions about file
// content do not depend on the checkout's newline convention.
// Guards for the companion homunculus (alchemist line): it must exist, be ours alone, and stay
// out of the char server.
//
// The stock path cannot serve a shell. `hom_create_request()` creates nothing in the map server -
// it fills a struct and asks the CHAR server (`intif_homunculus_create`), and a shell carries a
// synthetic identity (`POPULATION_ENGINE_CHAR_ID_BASE + index`) with no `char` row for a
// `homunculus` row to belong to. So the engine builds `s_homunculus` in memory and hands it to
// `hom_alloc()`, the map-side alloc/attach.
//
// `sd->status.hom_id` staying 0 is what keeps the char server out: every stock call is keyed on
// `hom_id`, so 0 makes them no-ops against real data - including the row delete in `unit_free`'s
// BL_HOM case. A compile check cannot cover any of that, so these assertions pin the
// relationships that make the behaviour correct.
//
// Every assertion here fails against the commit before the homunculus landed (the helper, the
// gate, the dump line and the hooks do not exist there).
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const ENGINE = path.join(ROOT, 'third-party', 'population-engine', 'files', 'src', 'map', 'population_engine.cpp');
const src = fs.readFileSync(ENGINE, 'utf8').replace(/\r\n/g, '\n');

const HELPER_SIG = 'static void population_engine_sync_shell_homunculus(map_session_data *sd)\n{';

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

function helperBody() {
	return functionBody(src, HELPER_SIG);
}

// A negative assertion must not be satisfiable by prose: a comment explaining why something is
// NOT done still names it. Strip comments before asserting that a call is absent.
function codeOnly(text) {
	return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

test('the homunculus helper exists, refuses players, and is gated on the alchemist skill', () => {
	const body = helperBody();
	assert.match(body, /if \(!population_engine_is_population_pc\(sd->id\)\)\s*\n\s*return;/,
		'the helper must refuse non-shells: a real player already has their own homunculus');
	assert.match(body, /pc_checkskill\(sd, AM_CALLHOMUN\) <= 0/,
		'the alchemist line must be gated on AM_CALLHOMUN (a skill gate needs no job whitelist)');
	assert.match(body, /if \(sd->hd != nullptr\)\s*\n\s*return;/,
		'the helper must be idempotent - it runs again on every recall');
});

test('it attaches in-map and never through the char server', () => {
	const body = helperBody();
	// the map-side alloc/attach
	assert.match(body, /hom_alloc\(sd, &homun\);/,
		'the attach must go through hom_alloc()');
	// NOT the char-server creation path
	assert.ok(!/hom_create_request\s*\(/.test(codeOnly(body)),
		'hom_create_request() only asks the char server to insert a row - unusable for a shell');
	// and nothing in this TU may reach the char server for a homunculus at all
	const calls = src.match(/intif_homunculus_[a-z_]+\s*\(/g) || [];
	assert.equal(calls.length, 0,
		`no intif_homunculus_*() call may exist in this TU (found ${calls.length})`);
});

test('sd->status.hom_id and hom_id are never assigned, which is what keeps the char server out', () => {
	const body = helperBody();
	assert.ok(!/homun\.hom_id\s*=/.test(codeOnly(body)),
		'the struct hom_id must stay 0, or unit_free would ask the char server to delete a row');
	assert.ok(!/sd->status\.hom_id\s*=/.test(codeOnly(body)),
		'setting status.hom_id would wake the stock load path at login');
	// the struct is zeroed first, which is where hom_id = 0 comes from
	assert.match(body, /memset\(&homun, 0, sizeof\(homun\)\)/,
		'the struct must be zeroed so every unset field (hom_id included) is 0');
});

test('the homunculus class is deterministic, not random', () => {
	// Stock uses `HM_CLASS_BASE + rnd_value(0, 7)`, which is right for a one-off creation but
	// wrong here: this runs again after every recall, so a random pick would swap the pet.
	const body = helperBody();
	assert.match(body, /HM_CLASS_BASE \+ static_cast<int32_t>\(index % 8\)/,
		'the class must be derived from the companion index so it is stable across recalls');
	assert.match(body, /sd->status\.char_id - POPULATION_ENGINE_CHAR_ID_BASE/,
		'the index must come from the shell identity constant this TU already uses');
	assert.ok(!/rnd_value/.test(codeOnly(body)),
		'a random class would change the pet on every recall');
});

test('the pet is summoned healthy, not as a newborn', () => {
	const body = helperBody();
	assert.match(body, /homun\.hp = homun\.max_hp;/,
		"stock's newborn `hp = 10` would put a companion's pet at death's door on arrival");
	assert.match(body, /homun\.max_hp = base\.HP;/,
		'the stats must come from homunculus_db, as hom_create_request reads them');
});

test('the helper is declared before its call sites', () => {
	const lines = src.split('\n');
	const decl = lines.findIndex((l) => l.startsWith('static void population_engine_sync_shell_homunculus(map_session_data *sd);'));
	assert.ok(decl >= 0, 'a forward declaration must exist (a call site precedes the definition)');
	const uses = lines
		.map((l, i) => ({ l, i }))
		.filter(({ l }) => l.includes('population_engine_sync_shell_homunculus(') && !l.trimStart().startsWith('static'));
	assert.ok(uses.length >= 5, `expected the spawn, advance, both resync and recall hooks (found ${uses.length})`);
	for (const { i } of uses) {
		assert.ok(i > decl, `call at line ${i + 1} precedes the declaration at ${decl + 1}`);
	}
});

test('it is applied at spawn, after a job change, and after the final placement', () => {
	// The same three moments the vehicle sync uses, for the same reasons: a companion must have
	// its pet when it appears, must gain it when it advances into the alchemist line, and must
	// keep it when a recall moves the shell after the first announcement.
	const idx = [];
	{
		const re = /population_engine_sync_shell_homunculus\((\w+)\);/g;
		let m;
		while ((m = re.exec(src)) !== null) idx.push(m.index);
	}
	const spawnGrant = src.indexOf('pc_calc_skilltree(sd);');
	assert.ok(spawnGrant > 0, 'the skill-tree grant anchor must exist');
	assert.ok(idx.some((i) => i > spawnGrant),
		'one hook must come after the skill-tree grant (the gate is pc_checkskill)');

	const jobchange = src.indexOf('if (!pc_jobchange(sd, next, upper))');
	assert.ok(jobchange > 0, 'the job-change anchor must exist');
	assert.ok(idx.some((i) => i > jobchange), 'one hook must come after pc_jobchange');

	const lastBroadcast = src.lastIndexOf('pop_shell_broadcast_map_placement(shell);');
	assert.ok(lastBroadcast > 0, 'the recall placement broadcast must exist');
	assert.ok(idx.some((i) => i > lastBroadcast),
		'one hook must come after the recall placement, so the pet survives bench+resummon');
});

test('@companion dump reports the pet, so it is read rather than judged', () => {
	// The vehicle lesson: a sprite is a visual claim, and the fact behind it is server state.
	assert.match(src, /@SHELLHOM\|%u\|1\|%d\|%d\|%d\|%d\|%d\|%d/,
		'the dump must emit the homunculus class, level, hp, max hp, hom_id and vaporize');
	assert.match(src, /@SHELLHOM\|%u\|0\|0\|0\|0\|0\|0/, 
		'and a absent-pet line, so "no pet" is also a readable fact');
	const dl = src.indexOf('population_engine_shell_dump');
	assert.ok(dl > 0, 'the dump function must exist');
	assert.ok(src.indexOf('@SHELLHOM') > dl, 'the pet line must live inside the dump function');
});

test('a shell\'s pet is never saved through the char server', () => {
	// hom_id 0 does not make hom_save a no-op: the char server's mapif_homunculus_save() treats
	// hom_id 0 as a new homunculus and INSERTs a row on every save (vaporize, call, unit_free).
	// The request has to be dropped on the map side, keyed on the shell's account range.
	const patches = path.join(ROOT, 'third-party', 'population-engine', 'patches');
	const all = fs.readdirSync(patches).filter(f => f.endsWith('.patch')).sort()
		.map(f => fs.readFileSync(path.join(patches, f), 'utf8').replace(/\r\n/g, '\n')).join('\n');
	const hunk = all.match(/int32 intif_homunculus_requestsave\( uint32 account_id, const s_homunculus\* sh \)\n \{\n([\s\S]*?)\n \s*if \(CheckForCharServer\(\)\)/);
	assert.ok(hunk, 'a patch must guard intif_homunculus_requestsave before it reaches the char server');
	assert.match(hunk[1], /^\+\s*if \(IS_POPULATION_ENGINE_ACCOUNT_ID\(account_id\)\)\n\+\s*return 0;/m,
		'the guard must drop the request for population accounts');
});
