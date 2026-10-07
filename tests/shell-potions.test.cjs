// Guards for shells' potions.
//
// Once shells pay for their skills (patch 0031) and rest between fights, one that ran low in a
// fight had nothing to fall back on until the fight ended. Shells now carry a few potions of their
// level's kind and drink one while they are needed, through the player's own pc_useitem.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'third-party', 'population-engine', 'files', 'src', 'map', 'population_engine.cpp');
const src = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');
const body = (head) => {
	const at = src.indexOf(head);
	assert.ok(at >= 0, `${head} must exist`);
	return src.slice(at, src.indexOf('\n}\n', at));
};

test("the stock is the level's Tool Dealer potions, and other tiers make way", () => {
	assert.match(body('static t_itemid pop_shell_hp_potion('), /lv >= 80 \? 504 : lv >= 55 \? 503 : lv >= 30 \? 502 : 501/);
	assert.match(body('static t_itemid pop_shell_sp_potion('), /base_level >= 55 \? 505 : 533/);
	const stock = body('static void pop_shell_stock_potions(');
	assert.match(stock, /pc_delitem\(sd, idx, sd->inventory\.u\.items_inventory\[idx\]\.amount/, 'an outgrown tier is dropped');
	assert.match(stock, /pc_additem\(sd, &it, want\.second - have,/, 'topped up, never past the stock');
});

test('a shell drinks through pc_useitem, one a second, HP before SP', () => {
	const drink = body('static void pop_shell_drink(');
	assert.match(drink, /pc_useitem\(sd, idx\)/);
	// clif_useitemack returns for a character without a session, so nobody saw a shell drink.
	assert.match(drink, /if \(!session_isActive\(sd->fd\)\) \{/);
	assert.match(drink, /clif_send\(&p, sizeof\(p\), sd, AREA_WOS\);/, 'the use animation for everyone around');
	assert.match(drink, /next_potion_tick = now \+ 1000/);
	assert.ok(drink.indexOf('POP_POTION_HP_PCT') < drink.indexOf('POP_POTION_SP_PCT'));
	assert.match(drink, /if \(idx < 0 && sp_pct < POP_POTION_SP_PCT\)/, 'out of HP potions, it still drinks for SP');
});

test('the rest decides: drink while needed, restock after a full rest, stock on the first tick', () => {
	const rest = body('static bool pop_shell_rest(');
	assert.match(rest, /if \(!sd->pop\.potions_stocked\)\n\t\tpop_shell_stock_potions\(sd\);/);
	assert.match(rest, /if \(!needed && sp >= until && hp >= until\)\n\t\t\t\tpop_shell_stock_potions\(sd\);/);
	assert.equal((rest.match(/if \(needed\)\n\t*pop_shell_drink\(sd, hp, sp, now\);/g) || []).length, 2,
		'drinks when needed, whether it was resting or not');
});

// A traded consumable goes back to the player. A potion of the kind the companion carries stacks
// onto its own, so the whole stack went back: one Red Potion traded, eleven returned.
test('a trade hands back only what it added to a stack', () => {
	const back = body('static bool pop_companion_hand_back(map_session_data *owner, map_session_data *shell, int16 i,\n\te_log_pick_type log_type, int32 amount)');
	assert.match(back, /amount = \(amount <= 0 \|\| amount > slot\.amount\) \? slot\.amount : amount;/);
	const traded = body('void population_engine_companion_equip_traded(');
	assert.match(traded, /grew \? slot\.amount - before\[i\]\.second : 0\);/);
});
