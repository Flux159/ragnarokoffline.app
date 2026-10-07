// windows-latest checks text files out with CRLF; normalise on read so assertions about file
// content do not depend on the checkout's newline convention.
// Guards for shells' stats matching their level. Upstream rolled each stat straight from the
// profile's range whatever the shell's level, and a profile with no ranges got 90-109 in all
// six, so a level 10 Acolyte had ~100 everywhere. The rolls are now only the shape of the
// build: a shell gets the points a character of its level has and spends them toward it.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'third-party', 'population-engine', 'files', 'src', 'map',
	'population_engine.cpp'), 'utf8').replace(/\r\n/g, '\n');

function body(signature) {
	const i = src.indexOf(signature);
	assert.ok(i > 0, `${signature} not found`);
	return src.slice(i, src.indexOf('\n}\n', i));
}

test('a shell gets the stat points a character of its level has', () => {
	const spend = body('static void pop_shell_spend_to_level(');
	assert.match(spend, /\*stat\[i\] = 1;/, 'every stat starts at 1, as after a stat reset');
	assert.match(spend, /statpoint_db\.get_table_point\(sd->status\.base_level\)/, 'the stock table, as pc_resetstate uses');
	assert.match(spend, /\(sd->class_ & JOBL_UPPER\) \|\| pc_is_primary_fourth\(sd->class_\)/);
	assert.match(spend, /battle_config\.transcendent_status_points/, 'and the transcendent bonus');
	assert.match(spend, /pc_need_status_point\(sd, SP_STR \+ pick, 1\)/, 'each point at the stock cost, within the job\'s cap');
	assert.match(spend, /sd->status\.status_point = static_cast<uint32>\(points\);/, 'what is left stays for a companion\'s growth');
});

test('points go to the stat furthest behind its share of the target', () => {
	const spend = body('static void pop_shell_spend_to_level(');
	assert.match(spend, /static_cast<int64>\(\*stat\[i\]\) \* target\[pick\] < static_cast<int64>\(\*stat\[pick\]\) \* target\[i\]/,
		'lowest cur/target first, so a build keeps its shape whatever the level');
});

test('the rolls are the shape of the build; a profile with no stats gets its job line\'s build', () => {
	const call = src.slice(src.indexOf('// RAGNAROKMAC: the rolls above are the shape of the build'));
	const block = call.slice(0, call.indexOf('pop_shell_spend_to_level(sd, target);') + 40);
	assert.match(block, /std::none_of\(std::begin\(declared\), std::end\(declared\)/);
	assert.match(block, /pop_shell_job_build\(sd->class_, target\);/, 'not upstream\'s 90-109 everywhere');
	assert.match(block, /target\[i\] = declared\[i\] \? static_cast<int16_t>\(rolled\[i\]\) : 1;/,
		'a stat the profile leaves out is not invested in');
	assert.ok(src.indexOf('pop_shell_spend_to_level(sd, target);') < src.indexOf('// RAGNAROKMAC: 4th-job trait stats'),
		'after the six rolls and the level, before the traits');
	const job = body('static void pop_shell_job_build(');
	for (const line of ['SWORDMAN', 'MAGE', 'ARCHER', 'ACOLYTE', 'MERCHANT', 'THIEF', 'TAEKWON', 'GUNSLINGER', 'NINJA'])
		assert.ok(job.includes(`case MAPID_${line}:`), `${line} has a build`);
});

test('trait stats are spent from the level\'s trait points too', () => {
	// The rolls gave a level 200 4th-job companion 91-210 trait points' worth, where a
	// character of that level has none; rAthena gives ~4 a level above 200.
	const spend = body('static void pop_shell_spend_traits_to_level(');
	assert.match(spend, /\*trait\[i\] = 0;/, 'traits start at 0');
	assert.match(spend, /statpoint_db\.get_trait_table_point\(sd->status\.base_level\)/, 'the stock trait table');
	assert.match(spend, /pc_need_trait_point\(sd, SP_POW \+ pick, 1\)/, 'the stock cost, within the trait cap');
	assert.match(spend, /sd->status\.trait_point = static_cast<uint32>\(points\);/);
	const call = src.slice(src.indexOf('// RAGNAROKMAC: as for the six stats above, the trait rolls'));
	assert.match(call.slice(0, 1200), /pop_cfg->pow_min >= 0\) \? static_cast<int16_t>\(sd->status\.pow\) : static_cast<int16_t>\(0\)/,
		'an undeclared trait stays 0');
	assert.match(call.slice(0, 1200), /pop_shell_spend_traits_to_level\(sd, target\);/);
});

test('a recalled companion keeps none of the spawn build\'s leftover points', () => {
	// A recall spawns at level 99 with no profile, so the spawn spends level 99's points on the job
	// build and leaves the rest in status_point. The saved stats then replace that build, and the
	// growth poll would spend the leftovers on top of it on every recall.
	const recall = src.slice(src.indexOf('// Restore the exact snapshot build the companion had when recruited.'));
	const block = recall.slice(0, recall.indexOf('population_engine_shell_equip_item(shell, armor'));
	const stats = block.indexOf('shell->status.dex = dex; shell->status.luk = luk;');
	assert.ok(stats > 0, 'the saved stats are restored here');
	assert.ok(block.indexOf('shell->status.status_point = 0;') > stats, 'status points cleared after the restore');
	assert.ok(block.indexOf('shell->status.trait_point  = 0;') > stats, 'trait points cleared after the restore');
});
