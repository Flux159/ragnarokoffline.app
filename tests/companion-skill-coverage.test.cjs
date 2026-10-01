// Guards for the curated skill coverage (the companion rotation data).
//
// Two things this pins, both learned from what the gap audit could NOT see:
//
// 1. PRESENCE IS NOT COMPLETENESS. A block carrying 2 of AL_CURE's 4 statuses counts as "curated"
//    to any presence-based check, while the companion silently cannot cure the other two. The
//    expected status set per cure comes from the skill's own impl (`status_change_end` calls), so
//    it can be asserted exactly.
// 2. A GENERIC SHAPE IS WRONG FOR SOME SKILLS. The generator's Support-without-Status branch gates
//    on "ally is hurt", which is right for a heal and wrong for a cure (gate on the ally HAVING the
//    status), a revive (target must be dead) and a non-restorative utility. Those are named in the
//    generator's HAND_WRITTEN set so a future run does not quietly emit the wrong row.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const YAML = path.join(ROOT, 'third-party', 'population-engine', 'files', 'db', 'population_skill_db.yml');
const GEN = path.join(ROOT, 'scripts', 'gen-population-skill-presets.py');

const yaml = fs.readFileSync(YAML, 'utf8').replace(/\r\n/g, '\n');
const gen = fs.readFileSync(GEN, 'utf8').replace(/\r\n/g, '\n');

// status lists are from the impls: acolyte/cure.cpp, thief/detoxify.cpp, guillotinecross/antidote.cpp
const CURES = {
	AL_CURE: {
		statuses: ['SC_SILENCE', 'SC_BLIND', 'SC_CONFUSION', 'SC_BITESCAR'],
		jobs: [8, 4009, 4057, 15, 4016, 4070, 14, 4015, 4066, 4, 4256, 4258, 4262, 4307],
	},
	TF_DETOXIFY: {
		statuses: ['SC_POISON', 'SC_DPOISON'],
		jobs: [12, 4013, 4059, 17, 4072, 4018, 6, 4254, 4260, 4307],
	},
	GC_ANTIDOTE: {
		statuses: ['SC_PARALYSE', 'SC_PYREXIA', 'SC_DEATHHURT', 'SC_LEECHESEND', 'SC_VENOMBLEED',
			'SC_MAGICMUSHROOM', 'SC_TOXIN', 'SC_OBLIVIONCURSE'],
		jobs: [4059, 4254],
	},
};

function block(jobId) {
	const m = new RegExp(`\\n  - JobId: ${jobId}\\n    Skills:\\n`).exec(yaml);
	assert.ok(m, `job ${jobId} must have a curated block`);
	const start = m.index + m[0].length;
	const next = yaml.indexOf('\n  - JobId: ', start);
	return yaml.slice(start, next < 0 ? yaml.length : next);
}

function row(skill, status) {
	return `{ SkillId: ${skill}, Level: 1, Rate: 7000, Target: ally, Condition: ally_status, CondValue: ${status} }`;
}

test('every cure covers its full status set for every class that can cast it', () => {
	for (const [skill, spec] of Object.entries(CURES)) {
		for (const jobId of spec.jobs) {
			const body = block(jobId);
			for (const status of spec.statuses) {
				assert.ok(body.includes(row(skill, status)),
					`job ${jobId} must carry ${skill} for ${status} - a partial set means the companion ` +
					`silently cannot cure it`);
			}
		}
	}
});

test('a cure aimed at an ally is gated on the ally HAVING the status, never on low HP', () => {
	// Scoped to ally-targeted rows on purpose: the Acolyte block carries a hand-tuned SELF cure
	// (blind/confusion on the caster), which is a different and legitimate intent.
	for (const [skill, spec] of Object.entries(CURES)) {
		for (const jobId of spec.jobs) {
			const body = block(jobId);
			const lines = body.split('\n').filter(l => l.includes(`SkillId: ${skill}`) && /Target: ally/.test(l));
			assert.ok(lines.length > 0, `${skill} ally rows expected in job ${jobId}`);
			for (const line of lines) {
				assert.match(line, /Condition: ally_status/,
					`${skill} in job ${jobId} must use ally_status: the cure fires when the ally HAS it`);
				assert.ok(!/ally_hp_below/.test(line),
					`${skill} must not be gated on ally_hp_below - that spams the cure on wounded allies`);
			}
		}
	}
});

test('the monk line can heal, gated on an ally actually being hurt', () => {
	for (const jobId of [15, 4016, 4070]) {
		const body = block(jobId);
		assert.ok(/SkillId: AL_HEAL,.*Condition: ally_hp_below/.test(body),
			`job ${jobId} is a healing-capable class and must carry AL_HEAL gated on allied HP`);
	}
});

test('the cures are hand-written in the generator, not emitted by a generic shape', () => {
	// The Support-without-Status branch gates on "ally below 70% HP". For a cure that fires on a
	// healthy ally and wastes the cast, so cures must stay hand-written (one row per status, from
	// the skill's impl). The other skills in that branch keep the branch's shape - which is what the
	// 4th-job classes have shipped all along (Biolo carries AM_BERSERKPITCHER, Troubadour/Trouvere
	// carry WM_DEADHILLHERE), so excluding them for 2nd/3rd jobs would be inconsistent with it.
	for (const skill of ['AL_CURE', 'TF_DETOXIFY', 'GC_ANTIDOTE']) {
		assert.ok(gen.includes(`"${skill}"`),
			`${skill} must be in the generator's hand-written exclusion set`);
	}
	assert.ok(!/SkillId: (AL_CURE|TF_DETOXIFY|GC_ANTIDOTE),.*ally_hp_below/.test(yaml),
		'no cure may be gated on ally_hp_below: that is the spam shape this test exists to prevent');
});
