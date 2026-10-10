// windows-latest checks text files out with CRLF; normalise on read so assertions about file
// content do not depend on the checkout's newline convention.
// Guards for the saved-companion list showing the current job class and tier.
//
// The data was already on the wire - the engine emits
// @CP|name|job_name|base_level|active|fav|live_level and the panel parsed all
// seven fields - but the row only ever put the job into nm.title, i.e. a hover
// tooltip, so the visible list read "name ... Lv.N ... ON" with no class at all.
// The player asked for the class on the row ("i forgot to include current job
// class and level"), choosing a stacked layout (name over class+tier) and the
// live level whenever a shell is summoned.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const PANEL = path.join(ROOT, 'patches', 'CompanionPanel.js');
const CSS = path.join(ROOT, 'patches', 'CompanionPanel.css');

const js = fs.readFileSync(PANEL, 'utf8').replace(/\r\n/g, '\n');
const css = fs.readFileSync(CSS, 'utf8').replace(/\r\n/g, '\n');

test('the saved list renders the job class on the row, not just a tooltip', () => {
	const i = js.indexOf('const id = document.createElement');
	assert.ok(i > 0, 'the row identity column must be built');
	const row = js.slice(i, i + 1200);
	assert.match(row, /nm\.textContent = (\(m\.dead \? '✝ ' : ''\) \+ )?\(m\.favorite \? '★ ' : ''\) \+ m\.name/,
		'the first line stays the (favourite-marked) name');
	assert.match(row, /cls\.textContent/,
		'the second line must be the class - a title attribute alone is invisible');
	assert.match(row, /id\.append\(nm, cls\)/, 'both lines belong to the same column');
	assert.match(js, /_row\(id, lv, badge/, 'and that column must be placed in the row');
	// the regression: job text living only in a tooltip
	assert.ok(!/nm\.title = `\$\{m\.name\} — \$\{m\.job\}`/.test(js),
		'the job must no longer be tooltip-only');
});

test('the class line names the job tier', () => {
	// The tier is what explains the stat ceiling (99 for 1st/2nd/trans, 130 for
	// 3rd/4th), so a bare class name leaves the player guessing which era it is.
	assert.match(js, /function _tierOf\(job\)/, 'a tier lookup must exist');
	assert.match(js, /for \(const \[tier, jobs\] of JOB_TIERS\)/,
		'and it must read the same table the Summon tab offers');
	assert.match(js, /cls\.textContent = tier \? `\$\{job\} · \$\{tier\} job` : job/,
		'the class line must append the tier when it is known');
});

test('the level shown is always the live one', () => {
	assert.match(js, /lv\.textContent = `Lv\.\$\{m\.liveLevel \|\| m\.level\}`/,
		'the live shell level must win over the persisted recruit-time snapshot');
});

test('the identity column can shrink so it cannot push the controls off the row', () => {
	// Without min-width:0 a flex item refuses to go below its content width, so a
	// long class name would overflow instead of ellipsising.
	assert.match(css, /#CompanionPanel \.row \.id \{[^}]*min-width: 0/,
		'the identity column needs min-width: 0 for the ellipsis to engage');
	assert.match(css, /#CompanionPanel \.row \.id \.cls \{/, 'and the class line needs its own rule');
	assert.match(css, /#CompanionPanel \.row \.id \.cls \{[^}]*ellipsis/,
		'a long class name must be cropped, not wrapped');
});

test('the class shown prefers the live class over the persisted one', () => {
	// The persistence row is only refreshed by the gear-hash snapshot, so a
	// companion that just advanced (Acolyte -> Priest) would otherwise display the
	// class it was recruited as. The engine sends the live class as an 8th field.
	assert.match(js, /liveJob: \(parts\[7\] \|\| ''\)\.trim\(\)/,
		'the parse must read the 8th field, with a fallback for an older server');
	assert.match(js, /const job = m\.liveJob \|\| m\.job/,
		'and the class line must prefer the live value');
	assert.match(js, /m\.liveJob !== _roster\[i\]\.liveJob/,
		'the redraw comparison must include it, or a class change would not redraw');
});
