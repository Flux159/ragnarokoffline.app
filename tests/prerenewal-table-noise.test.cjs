// Pre-renewal start-up logged about 500 population-engine table errors (v1.5.0 known issue). Pre-renewal
// has no 3rd or 4th classes, and the tables carry their skills (renewal-only for the 4th jobs), their
// companion profiles and their gear (renewal-only items): every row was logged as unknown. Those
// entries are now passed over there with one summary line per table; renewal still warns as before.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const CONFIG = path.join(ROOT, 'third-party', 'population-engine', 'files', 'src', 'map', 'population_engine', 'config');
const read = p => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const skillDb = read(path.join(CONFIG, 'population_skill_db.cpp'));
const config = read(path.join(CONFIG, 'population_config.cpp'));
const gear = read(path.join(ROOT, 'third-party', 'population-engine', 'files', 'db', 'population_gear_sets.yml'));

test('pre-renewal passes over skill blocks for classes it does not have', () => {
	assert.match(skillDb, /#ifndef RENEWAL\n[^#]*if \(!job_db\.exists\(job_id\)\) \{\n\t\t\+\+this->era_skipped_;\n\t\treturn 0;\n\t\}\n#endif/);
	assert.match(skillDb, /ShowInfo\("population_skill_db: skipped %u job entries/, 'one summary line instead');
});

test('and profile jobs for them, while renewal still warns', () => {
	assert.match(config, /if \(!job_db\.exists\(job_id\)\) \{\n#ifndef RENEWAL\n[^\n]*\n\t+\+\+this->m_era_skipped;\n#else\n\t+this->invalidWarning\(jn, "Profile '%s' Jobs: job ID %hu not in job_db/);
});

test('every 3rd and 4th class gear set is RenewalOnly, and pre-renewal skips those sets unread', () => {
	const sets = [...gear.matchAll(/^  - GearSetName: (\w+)[^\n]*\n((?:    .*\n)*)/gm)];
	const flagged = sets.filter(([, , body]) => /^    RenewalOnly: true$/m.test(body)).map(([, name]) => name);
	const classSets = sets.map(([, name]) => name).filter(n => /^(third|fourth)_/.test(n));
	assert.deepEqual(flagged.sort(), classSets.sort());
	assert.ok(flagged.length >= 27);
	assert.match(config, /this->asBool\(node, "RenewalOnly", renewal_only\) && renewal_only\) \{\n\t\t\t\+\+this->m_era_skipped;\n\t\t\treturn 1;/);
});
