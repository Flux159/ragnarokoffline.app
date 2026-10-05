// Guards for ally skills rAthena refuses on the chosen target (#385).
//
// rAthena checks the target when an ally skill lands: Providence fails on the Crusader line,
// an endow on bare fists, Alchemist chemical protection on a slot with nothing in it. The ally
// search only knew Devotion's rules, so a companion picked the same ally every turn and lost
// the cast every time; two Crusaders cast Providence at each other forever.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const COMBAT = path.join(ROOT, 'third-party', 'population-engine', 'files', 'src', 'map', 'population_engine',
	'runtime', 'population_engine_combat.cpp');
const combat = fs.readFileSync(COMBAT, 'utf8').replace(/\r\n/g, '\n');

function fn(signature) {
	const i = combat.lastIndexOf(signature);
	assert.ok(i >= 0, `expected to find ${signature}`);
	const rest = combat.slice(i);
	const end = rest.indexOf('\n}\n');
	return end > 0 ? rest.slice(0, end + 3) : rest;
}

test('every ally scan asks whether rAthena would refuse the skill on that ally', () => {
	for (const cb of ['pop_ally_hp_scan_cb', 'pop_ally_status_scan_cb', 'pop_ally_any_scan_cb'])
		assert.match(fn(`static int32 ${cb}(`), /if \(pop_ally_skill_refused\(ctx->shell, ally, ctx->skill_id\)\) return 0;/, cb);
	const find = fn('static map_session_data* population_shell_find_ally_target(');
	assert.match(find, /ctx\.skill_id\s+= skill_id;/);
});

test('Providence is not cast on the Crusader line', () => {
	const refused = fn('static bool pop_ally_skill_refused(');
	assert.match(refused, /case CR_PROVIDENCE:[^\n]*\n\t\treturn \(ally->class_ & MAPID_SECONDMASK\) == MAPID_CRUSADER;/);
});

test('the other target rules rAthena makes are mirrored', () => {
	const refused = fn('static bool pop_ally_skill_refused(');
	for (const skill of ['CR_DEVOTION', 'CG_MARIONETTE', 'AM_CP_WEAPON', 'AM_CP_SHIELD', 'AM_CP_ARMOR', 'AM_CP_HELM',
		'CR_FULLPROTECTION', 'BO_ADVANCE_PROTECTION', 'SA_FLAMELAUNCHER', 'SA_FROSTWEAPON', 'SA_LIGHTNINGLOADER',
		'SA_SEISMICWEAPON', 'SOA_TALISMAN_OF_MAGICIAN', 'SOA_TALISMAN_OF_FIVE_ELEMENTS', 'SP_KAUTE', 'SP_SOULREVOLVE',
		'AB_CLEARANCE', 'SO_STRIKING', 'WL_WHITEIMPRISON'])
		assert.ok(refused.includes(`case ${skill}:`), `${skill} has its target rule`);
	assert.match(refused, /shell->sc\.getSCE\(SC_MARIONETTE\) \|\| ally->sc\.getSCE\(SC_MARIONETTE2\)/,
		'a second Marionette on the same pair ends it');
	assert.match(refused, /default:\n\t\treturn false;/, 'any other skill is not refused');
});

const YAML = path.join(ROOT, 'third-party', 'population-engine', 'files', 'db', 'population_skill_db.yml');
const yaml = fs.readFileSync(YAML, 'utf8').replace(/\r\n/g, '\n');
const GEN = fs.readFileSync(path.join(ROOT, 'scripts', 'gen-population-skill-presets.py'), 'utf8');

test('no White Imprison row aims at an ally, and the generator does not bring one back', () => {
	assert.ok(!/SkillId: WL_WHITEIMPRISON,[^}]*Target: ally/.test(yaml), 'White Imprison lands only on the caster or an enemy');
	assert.match(GEN, /\|WL_WHITEIMPRISON"/, 'the generator skips it');
});

test('Marionette waits on the caster\'s own link, not the ally\'s', () => {
	const rows = yaml.match(/\{ SkillId: CG_MARIONETTE,[^}]*\}/g) || [];
	assert.ok(rows.length >= 6, 'every class rAthena teaches it to carries it');
	// Clown, Gypsy, Minstrel_T, Wanderer_T, Troubadour, Trouvere: the classes whose skill tree has it
	for (const job of [4020, 4021, 4075, 4076, 4263, 4264]) {
		const block = yaml.split(`\n  - JobId: ${job}\n`)[1];
		assert.ok(block, `job ${job} has a block`);
		assert.ok(block.split(/\n  - JobId: /)[0].includes('SkillId: CG_MARIONETTE,'), `job ${job} casts Marionette`);
	}
	for (const row of rows)
		assert.match(row, /Target: ally, Condition: not_self_status, CondValue: SC_MARIONETTE \}/,
			'SC_MARIONETTE is on the caster; the ally holds SC_MARIONETTE2');
	assert.match(GEN, /"CG_MARIONETTE":/, 'the generator leaves the hand-written rows alone');
});
