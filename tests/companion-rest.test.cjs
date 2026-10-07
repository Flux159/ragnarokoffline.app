// windows-latest checks text files out with CRLF; normalise on read so assertions about file
// content do not depend on the checkout's newline convention.
// Guards for resting: once shells pay for their skills (patch 0031), one that ran dry stood
// about until natural regen refilled it. Shells now sit between fights, as a player rests,
// and get up the moment they are needed. Ambient shells rest at fixed marks; a companion's
// marks are its owner's choice, from the Companions window, saved with the companion.
// Each assertion fails against the commit before the one that added the behaviour.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8').replace(/\r\n/g, '\n');
const MAP = ['third-party', 'population-engine', 'files', 'src', 'map'];
const src = read(...MAP, 'population_engine.cpp');
const hpp = read(...MAP, 'population_engine.hpp');
const state = read(...MAP, 'population_engine', 'core', 'population_shell_state.hpp');
const schema = read('third-party', 'population-engine', 'files', 'sql-files', 'population_engine', 'cp_companion_persistence.sql');
const cmds = read('stack', 'src', 'cmds.rs');
const patch = read('third-party', 'population-engine', 'patches', '0032-companion-rest-command.patch');
const panel = read('patches', 'CompanionPanel.js');

function body(signature) {
	const i = src.indexOf(signature);
	assert.ok(i > 0, `${signature} not found`);
	return src.slice(i, src.indexOf('\n}\n', i));
}
const rest = () => body('static bool pop_shell_rest(');

test('a shell low on SP or HP sits, and gets up once both recover', () => {
	assert.match(state, /bool\s+resting\s*=\s*false;/, 'each shell must remember that it is resting');
	assert.match(rest(), /sp >= below && hp >= below/, 'it sits when either is low');
	assert.match(rest(), /sp >= until && hp >= until/, 'and stands when both are back');
	assert.match(rest(), /std::max\(below \+ 1,/, 'it never stands up below the mark it sat down at');
	assert.match(rest(), /if \(below <= 0 \|\| needed/, 'with the lower mark at 0 it never sits');
	assert.match(rest(), /pc_setsit\(sd\);\s*skill_sit\(sd, true\);\s*clif_sitting\(\*sd\);/,
		'it sits the way a player\'s client does');
});

test('ambient shells rest at fixed marks; a companion at its own', () => {
	assert.match(src, /static constexpr int16_t POP_REST_BELOW_PCT = 30;/);
	assert.match(src, /static constexpr int16_t POP_REST_UNTIL_PCT = 95;/);
	assert.match(rest(), /owner != nullptr \? sd->pop\.companion_rest_below : POP_REST_BELOW_PCT/);
	assert.match(rest(), /owner != nullptr \? sd->pop\.companion_rest_until : POP_REST_UNTIL_PCT/);
	assert.match(state, /int16_t\s+companion_rest_below\s*=\s*30;/, 'a companion starts where ambient shells are');
	assert.match(state, /int16_t\s+companion_rest_until\s*=\s*95;/);
	const ambient = body('static int32 pop_combat_tick_bot_in_range(');
	assert.match(ambient, /if \(!pop_is_companion\(sd\) && pop_shell_rest\(sd, nullptr, static_cast<uint32>\(sd->pop\.target_id\), gettick\(\)\)\)\s*return 1;\s*population_engine_combat_per_tick\(sd, true\);/,
		'an ambient shell rests before its combat tick and skips it while it does');
});

test('it gets up the moment it is needed', () => {
	for (const [re, what] of [
		[/target != 0/, 'a target'],
		[/last_attacked_tick/, 'a hit on itself'],
		[/unit_is_walking\(owner\)/, 'a companion\'s owner moving off'],
		[/pop_companion_party_threat\(sd\) != 0/, 'a threat to the party'],
		[/pc_checkskill\(sd, AL_HEAL\) > 0/, 'a hurt owner, for a healer'],
		[/population_shell_loot_busy\(sd\)/, 'an ambient shell\'s drop to pick up'],
	])
		assert.match(rest(), re, `resting must give way to ${what}`);
});

test('it never sits where a player could not', () => {
	assert.match(rest(), /sd->ud\.skilltimer != INVALID_TIMER/, 'not mid-cast');
	assert.match(rest(), /SC_DANCING/, 'not while dancing');
	assert.match(rest(), /PCBLOCK_SITSTAND/, 'not while sitting is blocked');
});

test('the follow leaves a resting companion down, and stands it before it moves', () => {
	const follow = body('static bool pop_companion_follow_owner(');
	assert.match(follow, /pc_issit\(sd\) && !\(sd->pop\.resting && !unit_is_walking\(owner\)\)/,
		'the follow stood every companion up on every tick, which would undo the rest at once');
	assert.match(follow, /warp_near_owner = \[&\]\(\) -> bool \{\s*pop_shell_stand\(sd\);/,
		'a sitting shell cannot be placed and walk on; stand it before a warp');
	assert.match(follow, /if \(owner_distance > leash\) \{\s*pop_shell_stand\(sd\);/,
		'and before it walks back to its owner');
	assert.match(src, /if \(pop_shell_rest\(sd, owner, desired_target, now\)\)\s*continue;\s*if \(sd->state\.population_combat\)\s*population_engine_combat_per_tick\(sd, true\);/,
		'a companion rests before its combat tick and skips it while it does');
});

test('a companion\'s marks are saved and come back with it', () => {
	assert.match(schema, /`rest_below`\s+TINYINT\s+NOT NULL DEFAULT 30,/);
	assert.match(schema, /`rest_until`\s+TINYINT\s+NOT NULL DEFAULT 95,/);
	assert.match(cmds, /\("rest_below", "TINYINT NOT NULL DEFAULT 30"\)/, 'an existing table gains the columns');
	assert.match(cmds, /\("rest_until", "TINYINT NOT NULL DEFAULT 95"\)/);
	assert.match(src, /rest_below=%d, rest_until=%d,/, 'every save writes them');
	assert.match(src, /\(int\)sd->pop\.companion_rest_below, \(int\)sd->pop\.companion_rest_until,/);
	assert.match(src, /" rest_below=IF\(owner_account_id=VALUES\(owner_account_id\)[^"]*rest_below, 30\),"/,
		'drafting over an existing row keeps the owner\'s choice');
	assert.match(src, /rest_below, rest_until, gear_detail FROM `cp_companion_persistence`/, 'the recall reads them');
	assert.match(src, /const int rest_below_ = data != nullptr \? atoi\(data\) : -1;/,
		'0 is a choice (never rest), so a missing column must read differently');
	assert.match(src, /shell->pop\.companion_rest_below = static_cast<int16_t>\(rest_below_\);/);
});

test('@companion rest sets them for the whole party, and the Battle tab sends it', () => {
	assert.match(hpp, /int population_engine_companion_set_rest_thresholds\(uint32_t owner_account, int16_t below, int16_t until\);/);
	const setter = body('int population_engine_companion_set_rest_thresholds(');
	assert.match(setter, /below < 0 \|\| below > 90 \|\| until < below \+ 5 \|\| until > 100/);
	assert.match(setter, /population_engine_persist_companion_gear\(sd\);/);
	assert.match(patch, /\+\tif \(strcmpi\(cmd, "rest"\) == 0\) \{/);
	assert.match(patch, /population_engine_companion_set_rest_thresholds\(/);
	assert.match(patch, /\| rest <a%> <b%> \|/, 'the usage line names it');
	assert.match(panel, /h5\.textContent = 'Resting';/);
	assert.match(panel, /talk\(`@companion rest \$\{a\} \$\{b\}`, false\);/);
	assert.match(panel, /Math\.max\(a \+ 5,/, 'the panel keeps until above below, as the server does');
});

test('the Battle tab opens on the saved thresholds, not its defaults', () => {
	// The tab is rebuilt on every redraw, and it set its boxes to 75/35/30/95 each time, so a
	// change seemed forgotten the next time the window opened (and after any roster push).
	const list = body('void population_engine_companion_list_raw(');
	assert.match(list, /heal_at, emergency_at, rest_below, rest_until FROM `cp_companion_persistence`/);
	assert.match(list, /"@CP\|%s\|%s\|%d\|%d\|%d\|%d\|%s\|%d\|%d\|%d\|%d\|%d\|%d\|%d"/,
		'appended after rebirth, so every earlier field keeps its position');
	assert.match(list, /rest_below = sd->pop\.companion_rest_below;/, 'a summoned companion\'s live values win');
	for (const setter of ['int population_engine_companion_set_rest_thresholds(', 'int population_engine_companion_set_heal_thresholds('])
		assert.match(body(setter), /population_engine_push_companion_list\(owner_sd\);/, `${setter} must re-send the roster`);
	assert.match(panel, /restBelow: _field\(parts, 13\),/);
	assert.match(panel, /restUntil: _field\(parts, 14\)/);
	assert.match(panel, /m\.restBelow !== _roster\[i\]\.restBelow/, 'a changed threshold redraws the window');
	assert.match(panel, /restBelow\.value = String\(saved\.restBelow\);/);
	assert.match(panel, /restUntil\.value = String\(saved\.restUntil\);/);
	assert.match(panel, /normal\.value = String\(saved\.healAt\);/);
	assert.match(panel, /emergency\.value = String\(saved\.emergencyAt\);/);
});

test('a dead shell is never sat down, and companions rest only at their own marks', () => {
	// pc_setsit writes state.dead_sit = 2 over the 1 pc_isdead reads: the ambient combat tick, which
	// also runs for companions and does not skip the dead, sat a companion down as it died, and it
	// stood back up alive at 0 HP.
	const rest = body('static bool pop_shell_rest(');
	const guard = rest.indexOf('if (pc_isdead(sd) || status_isdead(*sd)) {');
	assert.ok(guard > 0 && guard < rest.indexOf('pc_setsit(sd);'), 'checked before anything sits it down');
	assert.match(src, /if \(!pop_is_companion\(sd\) && pop_shell_rest\(sd, nullptr, /);
});
