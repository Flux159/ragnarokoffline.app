// windows-latest checks text files out with CRLF; normalise on read so assertions about file
// content do not depend on the checkout's newline convention.
// Guards for the companion skill picker (phase 3: the in-game tick-box UI).
//
// The feature's risk is wiring, not logic, and two of these assertions exist because
// the wiring was actually wrong while everything compiled:
//
//   * the overlay was built by _skillPickerOverlay() and never appended anywhere, so
//     pressing Choose skills looked like a dead button. The panel is a single
//     component with no build step, so nothing but a test like this can catch it.
//   * the toggle started from an EMPTY selection when the companion had never been
//     configured, so the first untick kept only the clicked skill and the row of
//     ticks appeared to invert. The rule is now: a NULL skill_preset means the
//     companion is casting the whole class list, so a flip seeds from that list.
//
// The UI also may not send a list: the atcommand's `param` is 23 bytes, so the client
// must use the per-skill verbs. That is asserted here because a "send the whole list"
// client would look correct, work for a 1st-job companion, and silently truncate for a
// 4th-job one.
//
// Calibration: every test below must fail on the commit before phase 3.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const JS = path.join(ROOT, 'patches', 'CompanionPanel.js');
const HTML = path.join(ROOT, 'patches', 'CompanionPanel.html');
const CSS = path.join(ROOT, 'patches', 'CompanionPanel.css');
const ENGINE = path.join(ROOT, 'third-party', 'population-engine', 'files', 'src', 'map', 'population_engine.cpp');
const PATCH = path.join(ROOT, 'third-party', 'population-engine', 'patches', '0009-companion-skill-selector.patch');

const js = fs.readFileSync(JS, 'utf8').replace(/\r\n/g, '\n');
const html = fs.readFileSync(HTML, 'utf8').replace(/\r\n/g, '\n');
const css = fs.readFileSync(CSS, 'utf8').replace(/\r\n/g, '\n');
const engine = fs.readFileSync(ENGINE, 'utf8').replace(/\r\n/g, '\n');

test('the Skills tab exists with a matching page, beside the other tabs', () => {
	assert.match(html, /data-tab="skills"/, 'the sidebar must offer a Skills tab');
	assert.match(html, /data-page="skills"/, 'and a page for it to show');
	// The tab switch toggles off data-tab/data-page, so a tab with no page is dead.
	const tabs = [...html.matchAll(/data-tab="([a-z]+)"/g)].map(m => m[1]);
	const pages = [...html.matchAll(/data-page="([a-z]+)"/g)].map(m => m[1]);
	for (const t of tabs) assert.ok(pages.includes(t), `tab '${t}' has no page`);
	// Same bitmaps as its siblings or it renders blank (a missing bitmap is silent).
	const tabBlocks = [...html.matchAll(/data-tab="(\w+)"[\s\S]{0,220}?data-active="([^"]+)"/g)];
	const skillsTab = tabBlocks.find(b => b[1] === 'skills');
	assert.ok(skillsTab, 'the Skills tab must set its bitmaps');
	assert.equal(skillsTab[2], tabBlocks.find(b => b[1] === 'party')[2],
		'the Skills tab must use the same bitmap family as the other tabs');
});

test('the picker overlay is MOUNTED, not just constructed', () => {
	// The exact bug that made the button look dead: an overlay built and never appended.
	assert.match(js, /function _skillPickerOverlay\(/, 'the overlay must be built');
	assert.match(js, /function _mountSkillPicker\(/, 'and something must mount it');
	// Assert the append TARGET, not that an append exists. The first version of this test
	// matched /root\.append\(_skillPickerOverlay\(\)\)/ and therefore passed on the
	// broken code: getRoot() returns the SHADOW ROOT, so appending there put the overlay
	// outside the `#CompanionPanel` wrapper that every rule in the stylesheet is scoped to,
	// and the window rendered with no background at all.
	const mount = js.slice(js.indexOf('function _mountSkillPicker('));
	const mountBody = mount.slice(0, 600);
	assert.match(mountBody, /const wrap = _panelMount\(\);/,
		'_mountSkillPicker must mount via _panelMount (the #CompanionPanel wrapper)');
	assert.match(mountBody, /wrap\.append\(_skillPickerOverlay\(\)\)/,
		'the overlay must be appended to the WRAPPER, not the shadow root');
	assert.ok(!/root\.append\(_skillPickerOverlay\(\)\)/.test(mountBody),
		'the overlay must NOT be appended to getRoot() directly - that is the no-background bug');
	// _render is the single funnel every redraw goes through, so the call belongs there.
	const render = js.slice(js.indexOf('function _render()'), js.indexOf('function _page('));
	assert.match(render, /_mountSkillPicker\(\)/,
		'_render must mount the picker, or the overlay never appears');
	// A second overlay would swallow clicks meant for the first.
	assert.match(mount.slice(0, 600), /querySelectorAll\('\.skill-overlay'\)[\s\S]{0,40}remove\(\)/,
		'a previous overlay must be removed before mounting another');
});

test('the client drives the per-skill verbs, never a whole skill list', () => {
	// param is 23 bytes in the atcommand branch and the sscanf truncates, so a list
	// command works for a small 1st-job set and silently loses entries for a 4th job.
	assert.match(js, /toggle \$\{s\.id\}/,
		'a tick must send `toggle <id>`');
	assert.match(js, /'all'/, 'an All action must exist');
	assert.match(js, /'none'/, 'a None action must exist');
	assert.match(js, /'auto'/, 'an Auto action must exist');
	// And no command that tries to send several skills at once.
	const senders = [...js.matchAll(/talk\(`@companion skills \$\{[^`]*`/g)].map(m => m[0]);
	assert.ok(senders.length >= 3, `expected the skills commands to be built dynamically, found ${senders.length}`);
	for (const s of senders) {
		assert.ok(!/\.join\(|\.map\(/.test(s), `a list-shaped skill command would be truncated: ${s}`);
	}
});

test('a tick mirrors the server instead of being set optimistically', () => {
	// The server is authoritative about the selection, so the client re-asks after a
	// change rather than leaving its own checkbox state as the truth.
	const cb = js.slice(js.indexOf("cb.addEventListener('change'"));
	assert.match(cb.slice(0, 900), /askSkills\(_skillTarget\)/,
		'a tick must re-ask the server after the change');
	assert.match(cb.slice(0, 900), /cb\.disabled = true/,
		'the box must be disabled while the round-trip is in flight');
});

test('the picker is reachable from the row AND the tab', () => {
	assert.match(js, /const skills = _button\('Skills', 'b'/,
		'a Skills button must sit on each saved row');
	assert.match(js, /_row\(id, lv, badge, duty, skills/,
		'and it must be placed beside Duty, which is what was asked for');
	assert.match(js, /_button\('Choose skills'/,
		'the Skills tab needs its own entry point for a fuller list');
});

test('Escape closes the picker only while it is open and the panel is visible', () => {
	const esc = js.slice(js.indexOf('function installSkillEscape('));
	assert.match(esc.slice(0, 900), /_skillTarget/,
		'Escape must only act when a picker is open');
	assert.match(esc.slice(0, 900), /__active|_host/,
		'and only while the panel is up, or it steals Escape from dialogues');
	assert.match(js, /installSkillEscape\(\);/,
		'the handler must be installed from init()');
});

test('the @CPSK wire format is parsed defensively', () => {
	assert.match(js, /function parseSkillLine\(/, 'a parser for the menu must exist');
	const p = js.slice(js.indexOf('function parseSkillLine('));
	const body = p.slice(0, 1800);
	assert.match(body, /'@CPSKEND'/, 'the sentinel must be handled');
	assert.match(body, /'@CPSKFAIL'/, 'the failure sentinel must be handled');
	// Positional reads with a length guard: an older server may send fewer fields.
	assert.match(body, /p\.length < 5/, 'the parser must tolerate a shorter line');
	assert.match(body, /parts\[3\] === '1'|p\[3\] === '1'/, 'the selected flag must be read');
	// The parser must be wired into the chat hook or nothing ever reaches it.
	const hook = js.slice(js.indexOf('function installChatHook()'));
	assert.match(hook, /parseSkillLine\(text\)/, 'the chat hook must route @CPSK lines');
});

test('a flip seeds from the full class list when the companion was never configured', () => {
	// THE semantic fix. skill_preset IS NULL means "auto" - the shell casts every
	// legal skill, and the UI draws them all ticked - so an untick must remove one.
	// Starting from empty kept only the clicked skill and looked like an inversion.
	assert.match(engine, /bool storage_never_set = true;/,
		'the toggle must track whether the column was NULL');
	assert.match(engine, /if \(storage_never_set\)\s*\n\s*picked = legal;/,
		'a flip on a never-configured companion must start from the full legal list');
	// An explicit empty selection is still a real choice, so it must NOT be expanded.
	assert.match(engine, /storage_never_set = false;/,
		'reading a non-NULL value must clear the flag');
});

test('the menu shows what is being cast (all legal ticked) while on auto', () => {
	// A blank list would imply the companion does nothing, which is wrong: on auto it
	// casts the whole class list.
	assert.match(engine, /bool never_chosen = true;/,
		'the list path must track the never-chosen state');
	assert.match(engine, /const bool selected = never_chosen\s*\n\s*\? true/,
		'on auto, every legal skill must report selected');
});

test('the toggle verbs ship in the patch that rathena applies', () => {
	// atcommand.inc is a rathena-side file, so the PATCH is the artifact - and it must
	// still carry the PHASE 1 hunks too. A rebuild once dropped them silently because
	// the diff base already contained them, and the test suite caught it.
	const p = fs.readFileSync(PATCH, 'utf8').replace(/\r\n/g, '\n');
	assert.match(p, /strcmpi\(verb, "toggle"\)/, 'the verb branch must ship');
	assert.match(p, /population_engine_companion_toggle_skill\(/, 'and call the engine helper');
	// phase 1 must still be present in the same patch file
	assert.match(p, /strcmpi\(cmd, "skills"\)/, 'the phase-1 subcommand must still ship');
	assert.match(p, /population_engine_companion_set_skill_override\(/, 'phase-1 setter must still ship');
	assert.match(p, /companion_resolve_name_and_tail\(/, 'phase-1 name resolution must still ship');
});

test('the wrapper helper exists, is defined before use, and is the only mount target', () => {
	// The helper states the rule once. Two separate call sites (the picker and the delete
	// confirmation) both had the bug, so pinning the helper is what keeps them consistent.
	assert.match(js, /function _panelMount\(\) \{/,
		'a single documented mount helper must exist');
	assert.match(js, /root\.querySelector\('#CompanionPanel'\) \|\| root/,
		'the helper must actually look the wrapper up and fall back to the root');

	// Definition must precede every use. A count cannot show ordering, and a helper defined
	// after its first use throws ReferenceError on that path only.
	const lines = js.split('\n');
	const defn = lines.findIndex(l => l.startsWith('function _panelMount()'));
	assert.ok(defn >= 0, 'helper definition not found');
	const uses = lines
		.map((l, i) => ({ l, i }))
		.filter(({ l }) => l.includes('_panelMount()') && !l.startsWith('function'));
	assert.ok(uses.length >= 2, `expected both call sites, found ${uses.length}`);
	for (const { l, i } of uses) {
		assert.ok(i > defn, `_panelMount used at line ${i + 1}, before its definition at ${defn + 1}`);
	}

	// And nothing may mount an overlay onto the bare shadow root any more.
	assert.ok(!/root\.append\(overlay\)/.test(js),
		'confirmInWindow must not append to getRoot() either');
	assert.match(js, /_panelMount\(\)\.append\(overlay\);/,
		'the confirmation overlay must mount via the helper too');
});

test('the picker CSS is scoped, dense and backed by the real bitmaps', () => {
	// Everything lives under #CompanionPanel (the shadow-root wrapper), or it is inert.
	for (const sel of ['.skill-overlay', '.skill-box', '.skill-list', '.skill-row', '.skill-actions']) {
		assert.ok(css.includes(`#CompanionPanel ${sel}`),
			`${sel} must be scoped under #CompanionPanel or its rules match nothing`);
	}
	// RO metrics: no rounded corners or web-sized type in the new furniture.
	const block = css.slice(css.indexOf('#CompanionPanel .skill-overlay'));
	assert.ok(!/border-radius:\s*(?!0)[1-9]/.test(block), 'no rounded corners (not RO)');
	assert.ok(!/font-size:\s*1[4-9]px|font-size:\s*2\dpx/.test(block), 'keep RO type metrics');
	assert.ok(!/box-shadow:\s*0\s+\d+px\s+\d+px\s+rgba/.test(block), 'no soft web shadows');
});
