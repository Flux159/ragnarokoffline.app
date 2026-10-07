// Shell looting: ambient shells pick up the drops of their own kills.
//
// Shells never picked anything up, so every kill left its drops lying until they
// expired. With population_engine_loot_enable a shell walks over and takes them,
// with a player's priorities: a rare drop (any card, or a low base drop rate) even
// mid-fight unless its HP is low, an ordinary one only once nothing is attacking
// it, and now and then an ordinary one is left behind or forgotten.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const engine = path.join(__dirname, '..', 'third-party', 'population-engine');
const read = (...p) => fs.readFileSync(path.join(engine, ...p), 'utf8').replace(/\r\n/g, '\n');
const loot = read('files', 'src', 'map', 'population_engine', 'runtime', 'population_shell_loot.cpp');
const combat = read('files', 'src', 'map', 'population_engine', 'runtime', 'population_engine_combat.cpp');
const wander = read('files', 'src', 'map', 'population_engine', 'runtime', 'population_engine_path.cpp');
const factory = read('files', 'src', 'map', 'population_engine', 'population_engine_factory.cpp');
const patch = read('patches', '0026-shell-looting.patch');
const settings = fs.readFileSync(path.join(__dirname, '..', 'src', 'settings.html'), 'utf8').replace(/\r\n/g, '\n');

test('the loot module is part of the engine unity build', () => {
	assert.match(factory, /#include "runtime\/population_shell_loot\.cpp"/);
});

test('every setting is registered, and looting is off by default', () => {
	for (const k of ['enable', 'rare_rate', 'rare_pickup_pct', 'common_pickup_pct', 'forget_pct', 'timeout_ms', 'radius', 'hp_abort_pct']) {
		assert.match(patch, new RegExp(`^\\+int32 population_engine_loot_${k};$`, 'm'), `struct: ${k}`);
		assert.match(patch, new RegExp(`^\\+\\{ "population_engine_loot_${k}",`, 'm'), `init: ${k}`);
	}
	assert.match(patch, /"population_engine_loot_enable",&battle_config\.population_engine_loot_enable,0,0,1,/);
});

test('a shell only takes monster drops it has first priority on, through pc_takeitem', () => {
	assert.match(loot, /fitem->mob_id == 0 \|\| static_cast<uint32>\(fitem->first_get_charid\) != sd->status\.char_id/);
	assert.match(loot, /pc_takeitem\(sd, pick_item\)/);
	assert.match(loot, /population_engine_is_recruited_companion\(sd\)/, 'companions keep their owner-loot rules');
});

test('each drop is decided once: rare ones very likely, common ones at the base rate', () => {
	assert.match(loot, /id->type == IT_CARD/);
	assert.match(loot, /if \(!pe\.loot_seen\.emplace\(fitem->id, now \+ remember_ms\)\.second\)\s*continue;/);
	assert.match(loot, /if \(!rnd_chance\(rare \? rare_pct : common_pct, 100\)\)\s*continue;/);
	assert.match(loot, /e\.give_up_at = now \+ \(rare \? timeout \* 2 : timeout\);/);
});

test('a shell stops looting at the first overweight step, as the ammo stock does', () => {
	assert.match(loot, /max_weight \* battle_config\.natural_heal_weight_rate \/ 100 - 1 - sd->weight/);
	assert.match(loot, /if \(!loot_fits\(sd, fitem\)\)\s*\{\s*pe\.loot_bag_blocked = true;\s*continue;/, 'a drop that does not fit is not queued');
	assert.match(loot, /if \(loot_fits\(sd, pick_item\)\)\s*\{\s*pc_takeitem\(sd, pick_item\);/, 'checked again at pickup');
});

test('rare drops are fetched mid-fight, others wait and may be forgotten after the fight', () => {
	assert.match(loot, /const bool eligible = e\.rare \? !hp_low : !being_attacked;/);
	assert.match(loot, /e\.interrupted = true; \/\/ a fight is holding it back/);
	assert.match(loot, /if \(e\.interrupted\) \{\s*e\.interrupted = false;\s*if \(forget_pct > 0 && rnd_chance\(forget_pct, 100\)\)/);
});

test('looting runs before target selection, and wander leaves a looting shell alone', () => {
	const tick = combat.slice(combat.indexOf('int population_engine_combat_per_tick('));
	const lootAt = tick.indexOf('population_shell_loot_tick(sd, current_tick)');
	const targetAt = tick.indexOf('population_shell_check_target_alive(sd)');
	assert.ok(lootAt > 0 && lootAt < targetAt, 'loot step precedes target acquisition');
	assert.match(tick, /if \(!hired_companion && population_shell_loot_tick\(sd, current_tick\)\)/);
	assert.match(wander, /if \(population_shell_loot_busy\(sd\)\)\s*continue;/);
});

test('Settings has its own Loot section, saved with the rest of Population', () => {
	assert.match(settings, /<h2[^>]*>Loot<\/h2>\s*<div class="panel" id="loot-panel">/);
	for (const id of ['population_loot_enable', 'population_loot_common_pickup_pct', 'population_loot_rare_pct',
		'population_loot_rare_pickup_pct', 'population_loot_forget_pct', 'population_loot_hp_abort_pct',
		'population_loot_timeout_s', 'population_loot_radius'])
		assert.match(settings, new RegExp(`id="${id}"`), id);
	assert.match(settings, /settings\.population_loot_enable = \$\('population_loot_enable'\)\.checked;/);
	assert.match(settings, /for \(const id of LOOT_FIELDS\) settings\[id\] = Number\(\$\(id\)\.value\);/);
	assert.match(settings, /\$\('save-population-loot'\)\.onclick = \(\) => \$\('save-population'\)\.onclick\(\);/);
});
