// Guards for an ambient shell's level on a map whose monsters outlevel its band.
//
// population_engine_level_from_map sets a shell's level to the map's median monster level + 8, but
// clamped that to the profile's BaseLevel band. The tier table gives a map one band for both eras,
// and in Renewal many maps sit far above it: Payon Cave 4 (median 66) holds the [10, 26] band, Glast
// Heim's churches (115) hold [70, 99]. Held to the band, those shells were level 26 and 99 among the
// monsters they were there to fight.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'third-party', 'population-engine', 'files', 'src', 'map', 'population_engine.cpp');
const src = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

const fromMap = () => {
	const block = /if \(battle_config\.population_engine_level_from_map\) \{\n([\s\S]*?)\n\t\t\}/.exec(src);
	assert.ok(block, 'the level-from-map branch must exist');
	return block[1].replace(/\/\/[^\n]*/g, '');
};

test("the map's monsters can lift a shell past its band, up to its class's cap", () => {
	assert.match(fromMap(), /std::max\(static_cast<int>\(hi\), static_cast<int>\(pc_maxbaselv\(sd\)\)\)/);
});

// Gear sets are per profile and pc_equipitem enforces each item's equip level: below the band a
// shell would equip nothing.
test("the band's minimum stays a floor", () => {
	assert.match(fromMap(), /cap_value\(mobs \+ 8,\s*static_cast<int>\(pop_cfg->base_level_min\),/);
});

// pc_maxbaselv reads sd->status.class_, so the class has to be in place before the level roll.
test('the class is set before the level is rolled', () => {
	const cls = src.indexOf('sd->status.class_ = job_id;');
	const roll = src.indexOf('if (battle_config.population_engine_level_from_map)');
	assert.ok(cls > 0 && roll > cls);
});

// The live-monster sample misled: dynamic_mobs removes monsters from an empty map, and it stopped at
// the first 64 in block order, one corner of the map. Renewal's Payon Cave 2 (34 by its spawn lines)
// got level 13 shells.
test("a map's level comes from its spawn lines, weighted by count", () => {
	const at = src.indexOf('static int pop_map_mob_level(int16_t m) {');
	const fn = src.slice(at, src.indexOf('\n}\n', at));
	assert.match(fn, /for \(const struct spawn_data \*spawn : mapdata->moblist\)/);
	assert.match(fn, /levels\.emplace_back\(lv, spawn->num\);/);
	assert.ok(fn.indexOf('mapdata->moblist') < fn.indexOf('map_foreachinmap('), 'live monsters only as the fallback');
	assert.match(fn, /if \(from_spawns \|\| out > 0\)\n\t\tg_pop_map_mob_level\[m\] = out;/, 'an empty live sample is not cached');
	assert.doesNotMatch(src, /out->size\(\) >= 64/, 'no 64-monster cap');
});

// The roll read sd->m, which is still 0 there: pc_setpos puts the shell on its map further down. Map 0
// has no monsters, so every shell took the uniform roll across its band.
test("the level is read from the map the shell is spawning on, not sd->m", () => {
	assert.match(fromMap(), /const int mobs = pop_map_mob_level\(map_id\);/);
});
