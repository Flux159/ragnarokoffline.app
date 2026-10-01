// Items a player hands a companion are still the player's. These guards pin the custody rules:
// an item that leaves a companion lands in the owner's bag or at the owner's feet, never nowhere.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const ENGINE = path.join(ROOT, 'third-party', 'population-engine', 'files', 'src', 'map', 'population_engine.cpp');
const engine = fs.readFileSync(ENGINE, 'utf8').replace(/\r\n/g, '\n');

function functionBody(signature) {
	const i = engine.lastIndexOf(signature); // the definition, after any forward declaration
	assert.ok(i >= 0, `expected to find ${signature}`);
	const rest = engine.slice(i);
	const end = rest.indexOf('\n}\n');
	return end > 0 ? rest.slice(0, end + 3) : rest;
}

const HAND_BACK = 'static bool pop_companion_hand_back(';

test('the one hand-back path deletes from the companion only after the item has landed', () => {
	const body = functionBody(HAND_BACK);
	const del = body.indexOf('pc_delitem(');
	assert.ok(del > 0, 'hand-back must remove the item from the companion');
	const add = body.indexOf('pc_additem(owner');
	const floor = body.indexOf('map_addflooritem(');
	assert.ok(add > 0 && floor > 0 && add < del && floor < del,
		'the owner\'s bag, then the owner\'s feet, must both be tried before the companion lets go');
	assert.match(body.slice(floor, del), /return false;/,
		'when neither works the item must stay on the companion, not be deleted');
});

test('the trade and gear-return paths go through hand-back instead of deleting themselves', () => {
	for (const sig of ['void population_engine_companion_equip_traded(', 'int population_engine_companion_return_gear(']) {
		const body = functionBody(sig);
		assert.ok(!/pc_delitem\(/.test(body), `${sig} must not delete items itself`);
		assert.ok(body.includes('pop_companion_hand_back('), `${sig} must return items through hand-back`);
	}
});

test('both halves of a move are saved straight away, not on the next poll', () => {
	const back = functionBody('int population_engine_companion_return_gear(');
	const save = back.indexOf('chrif_save(owner, CSAVE_INVENTORY)');
	const persist = back.indexOf('population_engine_persist_companion_gear(shell)');
	assert.ok(save > 0 && persist > 0, 'gear return must save the owner and the companion row');
	assert.ok(save < persist, 'owner first, so a crash in between duplicates rather than loses');
	// The trade path: stock trade_tradecommit saves the owner after this hook returns.
	assert.ok(functionBody('void population_engine_companion_equip_traded(').includes('population_engine_persist_companion_gear(shell)'),
		'a trade must write the companion row immediately');
});

test('recall reads all its rows before it spawns anyone', () => {
	// Spawning queries the same handle (the homunculus sync reads its row) and Sql_Query frees the
	// current result, so recalling while iterating stopped at the first alchemist-line companion.
	const body = functionBody('int population_engine_recall_companions(');
	const free = body.indexOf('Sql_FreeResult(mmysql_handle)');
	const spawn = body.indexOf('population_engine_recall_one_companion(');
	assert.ok(free > 0 && spawn > free, 'the result must be freed before the first recall');
	assert.ok(!/Sql_NextRow\([^)]*\)[\s\S]*population_engine_recall_one_companion\(/.test(body.slice(0, free)),
		'no recall may happen inside the row loop');
});

test('only gear the owner gave comes back, and the record of it survives a restart', () => {
	const back = functionBody('int population_engine_companion_return_gear(');
	assert.match(back, /if \(!\(slot\.equip & shell->pop\.companion_given_mask\)\)/,
		'gear return must skip what the companion was generated or drafted with');
	const traded = functionBody('void population_engine_companion_equip_traded(');
	assert.match(traded, /companion_given_mask \|= slot\.equip/, 'a traded piece must be recorded as given');
	// persisted, and read back on recall
	const sql = fs.readFileSync(path.join(ROOT, 'third-party', 'population-engine', 'files', 'sql-files',
		'population_engine', 'cp_companion_persistence.sql'), 'utf8');
	assert.match(sql, /`given_mask`\s+INT UNSIGNED\s+NOT NULL DEFAULT 0/);
	assert.match(functionBody('void population_engine_persist_companion_gear('), /given_mask=%u/);
	assert.match(functionBody('int population_engine_recall_companions('), /skill_preset, given_mask"/);
});

test('a job advance never strands player gear in the unpersisted inventory', () => {
	const adv = functionBody('static void pop_companion_try_job_advance(map_session_data *sd)\n{');
	assert.ok(adv.indexOf('given_before') < adv.indexOf('pc_jobchange('),
		'the given pieces must be noted before pc_jobchange unequips what the new class cannot wear');
	assert.match(adv, /pop_companion_hand_back\(owner, sd, i,/, 'what the new class cannot wear goes back to the owner');
	assert.match(adv, /if \(slot\.nameid && slot\.equip && !\(slot\.equip & keep\)\)\s*\n\s*pc_unequipitem/,
		'only the companion\'s own gear is stripped for the new set');
	assert.match(adv, /if \(pos & keep\)\s*\n\s*return;/, 'the new set must not displace kept player gear');
});

test('removing a companion deletes that one row and never strands gear the player gave it', () => {
	assert.ok(!/DELETE FROM `cp_companion_persistence`[^"]*name=/.test(engine),
		'names are not unique; a delete by name removes every companion sharing it');
	assert.match(functionBody('bool population_engine_companion_delete('), /AND shell_index=%u/);
	const patches = path.join(ROOT, 'third-party', 'population-engine', 'patches');
	const all = fs.readdirSync(patches).filter(f => f.endsWith('.patch')).sort()
		.map(f => fs.readFileSync(path.join(patches, f), 'utf8').replace(/\r\n/g, '\n')).join('\n');
	assert.match(all, /^\+\s*if \(population_engine_companion_delete\(sd->status\.account_id, index_\)\) \{/m,
		'remove must pass the resolved index');
	assert.match(all, /^\+\s*population_engine_companion_return_gear\(sd, live, 0\);/m,
		'a summoned companion hands player gear back before it is released');
	assert.match(all, /^\+\s*if \(live == nullptr && population_engine_companion_holds_given_gear\(/m,
		'one that is not summoned cannot be removed while it still holds player gear');
});

test('a trade with your own companion is auto-accepted only after every stock trade check', () => {
	const patch = fs.readFileSync(path.join(ROOT, 'third-party', 'population-engine', 'patches',
		'0006-population-companion-persistence.patch'), 'utf8').replace(/\r\n/g, '\n');
	const trade = patch.slice(patch.indexOf('+++ b/src/map/trade.cpp'));
	const hook = trade.indexOf('+\tif (population_engine_companion_can_trade_with(sd, target_sd)) {');
	assert.ok(hook > 0, 'the auto-accept hook must exist');
	// It sits right before the request would be sent, i.e. after the no-trade map, GM, busy and
	// distance checks - so its context is the end of trade_traderequest, not the start.
	assert.ok(!/\n \tif \(map_getmapflag\(sd->m, MF_NOTRADE\)\) \{/.test(trade.slice(0, hook)),
		'the hook must not run before the MF_NOTRADE check');
	assert.ok(trade.slice(0, hook).includes(' \tsd->trade_partner.lv = target_sd->status.base_level;'),
		'the hook must come after the stock checks, where the partners are set');
	assert.match(trade.slice(hook, hook + 1500), /state\.storage_flag/,
		'and it must refuse what trade_tradeack refuses (vending, storage open, ...)');
});
