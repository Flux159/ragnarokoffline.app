// windows-latest checks text files out with CRLF; normalise on read so assertions about file
// content do not depend on the checkout's newline convention.
// Guards for the companion/ambient index reservation.
//
// WHY this exists: a companion with every skill disabled kept casting, and three separate
// correct fixes (per-tick re-seed, buff-guard, sphere-chain gate) all looked ineffective.
// The cause was not any of them - it was that the player's selection was being attached to
// the WRONG SHELL.
//
// `population_engine_allocate_index()` handed out indices from a counter that resets to 1 on
// every engine start (`store(1)` at two sites) and never consulted `cp_companion_persistence`,
// while a recruited companion keeps its permanent index forever. So an ambient town shell
// could be issued an index a companion already owned; both then carried the same
// `char_id = CHAR_ID_BASE + index`. The selector resolves "the live shell" BY INDEX while the
// UI resolves BY NAME, so the panel correctly showed "0 of 19 selected" for a shell that was
// not the one casting.
//
// Measured evidence: five distinct names logged at idx=307 in one session, exactly one with
// `override=1`, and the allocator's wrap warning never fired - so the counter reset, not pool
// exhaustion.
//
// A compile test cannot catch this class: stripping the reservation guard still compiles with
// zero errors (verified). So these assertions pin the CODE RELATIONSHIPS that make the two
// index spaces disjoint, and one pins the runtime diagnostic that would otherwise be the only
// detector.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const ENGINE = path.join(ROOT, 'third-party', 'population-engine', 'files', 'src', 'map', 'population_engine.cpp');
const src = fs.readFileSync(ENGINE, 'utf8').replace(/\r\n/g, '\n');

test('the allocator has a reserved set sourced from the persistence table', () => {
	assert.match(src, /static std::unordered_set<uint32_t> g_reserved_companion_indices;/,
		'a reserved-index set must exist');
	// The set must be filled FROM the companions table - a set that nothing populates is
	// the same as no set at all, and would read as fixed while behaving identically.
	assert.match(src, /SELECT shell_index FROM `cp_companion_persistence`/,
		'the reserved set must be loaded from cp_companion_persistence');
	const loader = src.slice(src.indexOf('population_engine_load_reserved_indices()'));
	assert.match(loader.slice(0, 1200), /g_reserved_companion_indices\.insert\(idx\)/,
		'the loader must actually insert the rows it reads');
});

test('BOTH allocator paths refuse a reserved index', () => {
	// The fast path is the common one; the wrap scan is the rare one. Fixing only the fast
	// path would leave the collision reachable under counter exhaustion.
	assert.match(src, /if \(!population_engine_index_is_reserved\(index, "ambient spawn"\)\)/,
		'the fast atomic path must check the reservation');
	assert.match(src, /if \(population_engine_index_is_reserved\(i, "ambient spawn \(wrap scan\)"\)\)/,
		'the wrap-exhaustion scan must check it too');
	// And the check must be consulted before returning, not after.
	const alloc = src.slice(src.indexOf('static uint32_t population_engine_allocate_index()'));
	const checkAt = alloc.indexOf('population_engine_index_is_reserved');
	const retAt = alloc.indexOf('return index;');
	assert.ok(checkAt > 0 && retAt > checkAt,
		'the reservation check must run BEFORE the index is returned');
});

test('the loader is called from the allocator, so it cannot be skipped', () => {
	// Loading eagerly at engine start would race the supervisor that creates the table, so it
	// is lazy on first use - but it must then be guaranteed to run.
	const alloc = src.slice(src.indexOf('static uint32_t population_engine_allocate_index()'));
	assert.match(alloc.slice(0, 400), /population_engine_load_reserved_indices\(\);/,
		'the allocator must trigger the lazy load');
	assert.match(src, /g_reserved_companion_indices_loaded = true;/,
		'the load must be one-shot guarded');
	// A failure to read must WARN rather than silently yield an empty set: an empty set is
	// indistinguishable from "no companions", which is exactly how this would come back.
	assert.match(src, /could not read reserved companion indices/,
		'a failed load must be visible in the log');
});

test('a companion is resolved by IDENTITY, not by index alone', () => {
	// Three sites resolve "the live shell for this row". Each must require that the candidate
	// really is this owner's recruited companion, or a coincidental shell can receive the
	// selection - the failure this whole commit addresses.
	const ownerChecks = src.match(/if \(cand->pop\.companion_owner_account != owner_account\)/g) || [];
	assert.ok(ownerChecks.length >= 3,
		`all three live-shell lookups need the ownership check (found ${ownerChecks.length})`);
	const companionChecks = src.match(/if \(!pop_is_companion\(cand\)\)/g) || [];
	assert.ok(companionChecks.length >= 3,
		`all three need the recruited-companion check too (found ${companionChecks.length})`);
});

test('an index worn by a non-companion is logged, not silent', () => {
	// The detection that was missing for three builds: the selection is saved, the apply is
	// skipped, and nothing says why.
	assert.match(src, /is worn by a shell that is not/,
		'the collision must emit a warning naming the index');
	assert.match(src, /this is the index collision/,
		'and say what it means, so the next reader does not re-diagnose it');
});

test('the counter reset is documented where it happens', () => {
	// The reset is the other half of the root cause. A future reader seeing `store(1)` needs
	// to know persisted indices survive it.
	const resets = src.match(/g_next_population_engine_index\.store\(1\)/g) || [];
	assert.ok(resets.length >= 2, `expected the two known reset sites, found ${resets.length}`);
	assert.match(src, /resets to 1 on every engine start/,
		'the reason the reservation is needed must be stated at the declaration');
});
