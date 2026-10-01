// windows-latest checks text files out with CRLF; normalise on read so assertions about file
// content do not depend on the checkout's newline convention.
// Guards for the companion homunculus toggle (phase 3c) - the control the companion row shows.
//
// The pet is never summoned by a player: the engine attaches it by itself at spawn, gated on the
// class tree's own AM_CALLHOMUN. So this feature is a SWITCH, and both directions are the
// interesting part:
//
//   OFF must use stock's own put-away (`hom_vaporize`), which leaves the pet attached but
//   inactive - the server-side driver keys on `hom_is_active`, so it stops on its own.
//
//   ON must NOT use `hom_call()`. Its first line is `if (!sd->status.hom_id) return
//   hom_create_request(...)`, and a shell's hom_id is deliberately 0, so it would take the
//   CHAR-SERVER path this whole feature exists to avoid. Clearing the flag in place is what
//   `hom_call` does AFTER its guards, and that is the part to copy.
//
// The switch is per companion, so it has to work for a benched one as well: that is why it is an
// at-command rather than a party-chat order (orders need the companion in the party).
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const ENGINE = path.join(ROOT, 'third-party', 'population-engine', 'files', 'src', 'map', 'population_engine.cpp');
const HEADER = path.join(ROOT, 'third-party', 'population-engine', 'files', 'src', 'map', 'population_engine.hpp');
const PATCH = path.join(ROOT, 'third-party', 'population-engine', 'patches', '0011-companion-homunculus-toggle.patch');
const PANEL = path.join(ROOT, 'patches', 'CompanionPanel.js');

const engine = fs.readFileSync(ENGINE, 'utf8').replace(/\r\n/g, '\n');
const header = fs.readFileSync(HEADER, 'utf8').replace(/\r\n/g, '\n');
const patch = fs.readFileSync(PATCH, 'utf8').replace(/\r\n/g, '\n');
const panel = fs.readFileSync(PANEL, 'utf8').replace(/\r\n/g, '\n');

function codeOnly(text) {
	return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

function functionBody(text, signature) {
	const i = text.indexOf(signature);
	assert.ok(i > 0, `expected to find ${signature}`);
	const rest = text.slice(i);
	const end = rest.indexOf('\n}\n');
	return end > 0 ? rest.slice(0, end + 3) : rest;
}

function setterBody() {
	return functionBody(engine, 'int population_engine_companion_set_homunculus(uint32_t owner_account');
}

test('the engine exposes the switch, in the header and the TU', () => {
	assert.match(header, /int population_engine_companion_set_homunculus\(uint32_t owner_account, const char\* name_, int want,/,
		'the switch must be declared in the header');
	assert.match(engine, /int population_engine_companion_set_homunculus\(uint32_t owner_account, const char \*name_, int want,/,
		'and defined in the engine TU');
});

test('the switch is stored as an explicit 0 or 1 on the companion row', () => {
	const body = setterBody();
	assert.match(body, /UPDATE `cp_companion_persistence` SET hom_enabled=%d"\s*\n?\s*" WHERE owner_account_id=%u AND owner_char_id=%u AND shell_index=%u/,
		'the switch must be written to the column, keyed like every other per-companion write');
	assert.match(body, /if \(want < 0\)\s*\n\s*want = \(enabled == 0\) \? 1 : 0;/,
		'a request without a state flips the current one');
	assert.match(body, /want = want \? 1 : 0;/,
		'and only 0 or 1 is ever stored, never a tri-state');
	// NULL means "never chosen" and has to stay reachable for an install that never toggles, so the
	// setter writes only the two chosen values.
	assert.ok(!/SET hom_enabled=NULL/.test(body),
		'the setter must not write NULL back - NULL is "never chosen", not "off"');
});

test('a benched companion is a supported case, not an error', () => {
	const body = setterBody();
	assert.match(body, /population_engine_companion_find\(owner_account, name_, &index_, &active\)/,
		'resolve the saved row, which exists whether or not the companion is summoned');
	assert.match(body, /applies when summoned/,
		'the reply must say when the change takes effect, or a player reads silence as failure');
});

test('OFF puts the pet away with stock\'s own call', () => {
	const body = setterBody();
	assert.match(body, /hom_vaporize\(live, HOM_ST_ACTIVE\)/,
		'use the same call pc.cpp makes on logout: the pet stays attached but inactive');
	assert.match(body, /live->hd->homunculus\.vaporize == HOM_ST_ACTIVE/,
		'only vaporize a pet that is currently active');
});

test('ON clears the flag in place and never reaches the char server', () => {
	const body = setterBody();
	assert.match(body, /hom_init_timers\(live->hd\)/,
		'restore the timers hom_vaporize deleted, exactly as hom_call does');
	assert.match(body, /live->hd->homunculus\.vaporize = HOM_ST_ACTIVE;/,
		'the flag is what hom_is_active reads');
	assert.match(body, /population_engine_sync_shell_homunculus\(live\)/,
		'with no pet at all, attach from the row so class, level and exp come back');
	// hom_call() would be the obvious call and is the wrong one: a shell's hom_id is 0, so its
	// first branch is hom_create_request -> intif_homunculus_create -> the char server.
	const code = codeOnly(body);
	assert.ok(!/hom_call\s*\(/.test(code),
		'hom_call must not be used: with hom_id 0 it takes the char-server path');
	assert.ok(!/intif_homunculus_/.test(code), 'no char-server call may be introduced');
});

test('applicability is asked of the class tree, so a benched companion can be answered', () => {
	assert.match(header, /bool population_engine_class_can_have_homunculus\(uint16_t class_\);/,
		'the panel needs this answer without a live shell');
	const body = functionBody(engine, 'bool population_engine_class_can_have_homunculus(uint16_t class_)');
	assert.match(body, /std::shared_ptr<s_skill_tree> tree = skill_tree_db\.find\(class_\);/,
		'ask the same place the attach grants skills from');
	assert.match(body, /entry\.first == AM_CALLHOMUN/,
		'and test the skill the attach gate tests');
	// The attach itself keeps its runtime gate: pc_checkskill needs a live shell.
	assert.match(engine, /if \(pc_checkskill\(sd, AM_CALLHOMUN\) <= 0\)\s*\n\s*return;/,
		'the attach gate must be left alone');
});

test('the roster carries the switch as a tri-state', () => {
	assert.match(engine, /SELECT name, job_id, active, favorite, base_level, hom_enabled FROM `cp_companion_persistence`/,
		'the raw list must read the column');
	assert.match(engine, /int hom = -1;/,
		'-1 means this job cannot have a pet, so the panel draws no control at all');
	assert.match(engine, /hom = \(hom_enabled == 0\) \? 0 : 1;/,
		'NULL (never chosen) must read as on, matching the attach');
	assert.match(engine, /"@CP\|%s\|%s\|%d\|%d\|%d\|%d\|%s\|%d"/,
		'the line gains the field');
	// The panel decides on the class the shell is RUNNING: a companion that just advanced would
	// otherwise be judged on the persisted job_id.
	assert.match(engine, /uint16_t live_class = 0;/,
		'the live class must be tracked, not just its name');
});

test('the panel reads the field, gates the control on it, and never invents the state', () => {
	assert.match(panel, /const raw = parts\.length > 8 \? parseInt\(parts\[8\], 10\) : NaN;/,
		'the field is read positionally with a fallback, so an older server hides the control');
	assert.match(panel, /hom: \(\(\) => \{/,
		'and stored on the roster row');
	assert.match(panel, /const pet = m\.hom < 0 \? null : _button\(/,
		'a companion whose class cannot have one gets no control');
	assert.match(panel, /talk\(`@companion homunculus \$\{m\.name\} \$\{m\.hom \? 'off' : 'on'\}`, false\)/,
		'the click sends the at-command a player would type');
	assert.match(panel, /m\.liveLevel !== _roster\[i\]\.liveLevel \|\| m\.hom !== _roster\[i\]\.hom\);/,
		'a switch from the server must redraw the row');
	// The panel must not optimistically set the state: it refreshes and lets the pushed roster
	// confirm, so it can never show a switch the server did not agree to.
	const code = codeOnly(panel);
	assert.ok(!/\bm\.hom\s*=[^=]/.test(code) && !/_roster\[[^\]]*\]\.hom\s*=[^=]/.test(code),
		'the client must not write the pet state itself');
});

test('the at-command verb is shipped by a patch, and it parses the trailing state', () => {
	assert.match(patch, /@companion homunculus <name> \[on\|off\]/, 'the usage string must name it');
	assert.match(patch, /strcmpi\(cmd, "homunculus"\) == 0 \|\| strcmpi\(cmd, "pet"\) == 0/,
		'accept the short alias too');
	assert.match(patch, /char \*last = strrchr\(param, ' '\);/,
		'the state is the LAST token, so a companion name may contain spaces');
	assert.match(patch, /population_engine_companion_set_homunculus\(/,
		'the verb must call the engine switch');
	assert.ok(!/-1 \{/.test(patch), 'a malformed hunk header would truncate the patch on a fresh apply');
});

test('the recurring snapshot does not write the switch', () => {
	// A snapshot runs for every companion; writing hom_enabled there would re-enable a pet the
	// player switched off, on the next tick.
	const body = functionBody(engine, 'void population_engine_persist_companion_gear(map_session_data *sd)');
	assert.ok(!/hom_enabled/.test(body),
		'only the switch writes the switch');
});

test('a 23-character name still leaves room for "on"/"off" after it', () => {
	const dir = path.join(__dirname, '..', 'third-party', 'population-engine', 'patches');
	const all = fs.readdirSync(dir).filter(f => f.endsWith('.patch')).sort()
		.map(f => fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n')).join('\n');
	// The last change to the argument buffer wins: it must hold a full name plus a trailing word.
	const reads = [...all.matchAll(/^\+\s*if \(!message \|\| !\*message \|\| sscanf\(message, "%31s %(\d+)\[\^\\n\]", cmd, param\) < 1\) \{/gm)];
	assert.ok(reads.length > 0, 'the @companion argument read must be found');
	const width = Number(reads[reads.length - 1][1]);
	assert.ok(width >= 23 + ' off'.length, `the argument must fit a 23-character name and " off" (reads ${width})`);
	// And a name longer than NAME_LENGTH can never overrun the escape buffer.
	const engine = fs.readFileSync(path.join(__dirname, '..', 'third-party', 'population-engine', 'files', 'src', 'map',
		'population_engine.cpp'), 'utf8');
	assert.equal((engine.match(/Sql_EscapeString\(/g) || []).length, 1, 'names are escaped in one bounded place');
	assert.match(engine, /safestrncpy\(bounded, name != nullptr \? name : "", sizeof\(bounded\)\);\s*\n\s*Sql_EscapeString\(mmysql_handle, out, bounded\);/);
});
