// The Basic Information menu (V4 and V5) is a 132px panel of five-wide rows. The
// Companions button the client patch adds is one more than it was drawn for, so
// Reputation Status wrapped onto a fourth row below the panel (#390), and every
// mod button would push it further. scripts/patch-basicinfo-menu.py makes the
// panel scroll and draws a button's name below the frame, where the scrolling
// panel cannot clip it. Both versions get the same, so they stay in parity.
//
// Run against copies of the stock blocks rather than the vendored checkout, so
// the test needs no fetch and cannot depend on whether the checkout is patched.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'patch-basicinfo-menu.py');

const V5_CSS = [
	'#BasicInfoV5 .buttons {',
	'\tposition: absolute;',
	'\tleft: 0px;',
	'\ttop: 9px;',
	'\twidth: 220px;',
	'\theight: 132px;',
	'\tbackground-repeat: no-repeat;',
	'\tbackground-position: bottom;',
	'}',
	''
];

const V4_CSS = [
	'#BasicInfoV4 .buttons {',
	'\tposition: absolute;',
	'\tleft: 0px;',
	'\ttop: 9px;',
	'\twidth: 220px;',
	'\tdisplay: grid;',
	'\tgrid-template-columns: auto auto auto auto auto;',
	'\tjustify-items: center;',
	'\tbackground-position: left bottom;',
	'}',
	''
];

const js = name => [
	"import { createBasicInfo } from '../BasicInfoCommon.js';",
	'',
	'export default createBasicInfo({',
	`\tname: '${name}'`,
	'});',
	''
];

// V4's markup has its Reputation Status button commented out.
const V4_HTML = [
	'<div class="buttons">',
	'\t\t<button',
	'\t\t\tid="agency"',
	'\t\t\tclass="event_add_cursor"',
	'\t\t>',
	'\t\t\t<span class="name">Adventurer\'s Agency (Ctrl + Z)</span>',
	'\t\t</button>',
	'\t\t<!--<button class="reputation" data-background="menu_icon/" data-hover="menu_icon/" data-down="menu_icon/"></button> -->',
	'</div>',
	''
];

const STOCK = {
	BasicInfoV5: { css: V5_CSS, js: js('BasicInfoV5') },
	BasicInfoV4: { css: V4_CSS, js: js('BasicInfoV4'), html: V4_HTML }
};
const NAMES = Object.keys(STOCK);

function checkout(eol, stock = STOCK) {
	const rb = fs.mkdtempSync(path.join(os.tmpdir(), 'basicinfo-menu-'));
	const files = {};
	for (const [name, { css, js: script, html }] of Object.entries(stock)) {
		const dir = path.join(rb, 'src/UI/Components/BasicInfo', name);
		fs.mkdirSync(dir, { recursive: true });
		files[name] = { css: path.join(dir, `${name}.css`), js: path.join(dir, `${name}.js`), html: path.join(dir, `${name}.html`) };
		fs.writeFileSync(files[name].css, css.join(eol));
		fs.writeFileSync(files[name].js, script.join(eol));
		if (html) {
			fs.writeFileSync(files[name].html, html.join(eol));
		}
	}
	return { rb, files };
}

function run(rb) {
	return spawnSync('python3', [SCRIPT, rb], { encoding: 'utf8' });
}

test('the panel keeps its size and scrolls, in both versions', () => {
	const { rb, files } = checkout('\r\n');
	const out = run(rb);
	assert.strictEqual(out.status, 0, out.stderr);
	for (const name of NAMES) {
		const text = fs.readFileSync(files[name].css, 'utf8');
		assert.match(text, /^\theight: 132px;/m, `${name}: the panel must have the height its frame art has`);
		assert.match(text, /^\toverflow-y: auto;/m, `${name}: the client attaches its scrollbar to overflow-y:auto`);
		assert.match(text, /^\toverflow-x: hidden;/m, name);
	}
});

test('the grid of V4 keeps its rows at their natural height while it scrolls', () => {
	const { rb, files } = checkout('\r\n');
	run(rb);
	assert.match(fs.readFileSync(files.BasicInfoV4.css, 'utf8'), /^\talign-content: start;/m);
});

test('five buttons still fit while the scrollbar is showing', () => {
	const { rb, files } = checkout('\r\n');
	run(rb);
	// 220px panel, 13px scrollbar: 207px for five buttons of 32px + 2 x 4px.
	const v5 = fs.readFileSync(files.BasicInfoV5.css, 'utf8');
	const v4 = fs.readFileSync(files.BasicInfoV4.css, 'utf8');
	assert.match(v5, /padding-right: 13px'\] > div\[id\] \{\s*margin: 6px 4px;/);
	assert.match(v4, /padding-right: 13px'\] > button\[id\] \{\s*margin: 6px 4px;/);
});

test('names are drawn below the frame, centred, and not inside the buttons', () => {
	const { rb, files } = checkout('\r\n');
	run(rb);
	const v5 = fs.readFileSync(files.BasicInfoV5.css, 'utf8');
	const v4 = fs.readFileSync(files.BasicInfoV4.css, 'utf8');
	assert.match(v5, /div:hover \.name \{\s*display: none;/);
	assert.match(v4, /button:hover \.name \{\s*display: none;/);
	// Each version's panel position + 132px + a 4px gap.
	assert.match(v5, /#BasicInfoV5\.large \.menu_tip \{\s*top: 296px;/);
	assert.match(v5, /#BasicInfoV5\.small \.menu_tip \{\s*top: 216px;/);
	assert.match(v4, /#BasicInfoV4\.large \.menu_tip \{\s*top: 280px;/);
	assert.match(v4, /#BasicInfoV4\.small \.menu_tip \{\s*top: 198px;/);
	for (const text of [v5, v4]) {
		assert.match(text, /left: 110px;\s*transform: translateX\(-50%\);/, 'centred on the 220px frame');
	}
});

test("V5's new-item mark sits over the button it marks, where V4's does", () => {
	const { rb, files } = checkout('\r\n');
	run(rb);
	const v5 = fs.readFileSync(files.BasicInfoV5.css, 'utf8');
	const v4 = fs.readFileSync(files.BasicInfoV4.css, 'utf8');
	// The picture's tile starts 6px below its top and flush left: V4 places it at -6px / 0, and
	// V5 had it 13px up and 7px left, hanging off its button and past the panel's top edge.
	assert.match(v5, /#BasicInfoV5 \.buttons \.btn_overlay \{\s*top: -6px;\s*left: 0;\s*\}/);
	// The panel itself is not resized for it.
	assert.doesNotMatch(v5, /padding: 7px 0 0 1px/);
	assert.doesNotMatch(v4, /new-item mark/);
});

test('the files keep their own line endings', () => {
	for (const eol of ['\r\n', '\n']) {
		const { rb, files } = checkout(eol);
		assert.strictEqual(run(rb).status, 0);
		const other = eol === '\r\n' ? /(?<!\r)\n/ : /\r\n/;
		for (const name of NAMES) {
			for (const file of [files[name].css, files[name].js, files[name].html]) {
				if (!fs.existsSync(file)) continue;
				assert.doesNotMatch(fs.readFileSync(file, 'utf8'), other, `mixed endings in ${path.basename(file)}`);
			}
		}
	}
});

test('applying it twice changes nothing the second time', () => {
	const { rb, files } = checkout('\r\n');
	run(rb);
	const all = () =>
		NAMES.flatMap(n => [files[n].css, files[n].js, files[n].html])
			.filter(f => fs.existsSync(f))
			.map(f => fs.readFileSync(f, 'utf8'));
	const once = all();
	const again = run(rb);
	assert.strictEqual(again.status, 0, again.stderr);
	assert.deepStrictEqual(all(), once);
});

test('it stops when upstream changes a block it edits, in either version', () => {
	for (const name of NAMES) {
		const drifted = {
			...STOCK,
			[name]: { css: STOCK[name].css.map(l => l.replace('top: 9px', 'top: 10px')), js: STOCK[name].js }
		};
		const css = run(checkout('\r\n', drifted).rb);
		assert.notStrictEqual(css.status, 0, `${name}: a block that no longer matches must not be edited blind`);
		assert.match(css.stderr, /no longer matches/);

		const driftedJs = {
			...STOCK,
			[name]: { css: STOCK[name].css, js: STOCK[name].js.map(l => l.replace('export default createBasicInfo', 'const Window = createBasicInfo')) }
		};
		const js = run(checkout('\r\n', driftedJs).rb);
		assert.notStrictEqual(js.status, 0, name);
		assert.match(js.stderr, /no longer matches/);
	}
});

test('a checkout without a version of that window skips it', () => {
	const rb = fs.mkdtempSync(path.join(os.tmpdir(), 'basicinfo-menu-'));
	assert.strictEqual(run(rb).status, 0);
	const { rb: v5Only, files } = checkout('\r\n', { BasicInfoV5: STOCK.BasicInfoV5 });
	const out = run(v5Only);
	assert.strictEqual(out.status, 0, out.stderr);
	assert.match(fs.readFileSync(files.BasicInfoV5.css, 'utf8'), /the menu scrolls/);
});

test('V4 gets the Reputation Status button V5 has, in the same place', () => {
	const { rb, files } = checkout('\r\n');
	assert.strictEqual(run(rb).status, 0);
	const html = fs.readFileSync(files.BasicInfoV4.html, 'utf8');
	assert.doesNotMatch(html, /<!--<button class="reputation"/, 'the commented-out button is replaced');
	assert.match(html, /<button\r\n\t\t\tid="repute"\r\n\t\t\tclass="event_add_cursor"/, 'keeps the indent and line endings of its neighbours');
	assert.match(html, /data-background="menu_icon\/bt_repute\.bmp"/);
	assert.match(html, /data-down="menu_icon\/bt_repute_press\.bmp"/);
	assert.match(html, /<span class="name">Reputation Status<\/span>/);
	assert.strictEqual((html.match(/id="repute"/g) || []).length, 1);
});

test('it stops when the commented-out reputation button is not there to replace', () => {
	const drifted = { ...STOCK, BasicInfoV4: { ...STOCK.BasicInfoV4, html: STOCK.BasicInfoV4.html.map(l => l.replace('class="reputation"', 'class="repute"')) } };
	const out = run(checkout('\r\n', drifted).rb);
	assert.notStrictEqual(out.status, 0);
	assert.match(out.stderr, /no longer matches/);
});

// The tooltip itself, run against a stand-in for the window and its DOM.
function tooltip(name = 'BasicInfoV5') {
	const { rb, files } = checkout('\n');
	run(rb);
	const src = fs.readFileSync(files[name].js, 'utf8');
	const snippet = src.slice(src.indexOf('// Ragnarok Offline: the menu scrolls')).replace(`export default ${name};`, '');

	const handlers = {};
	const tip = { style: {}, className: '', textContent: '' };
	const inner = { children: [], appendChild(child) { this.children.push(child); } };
	const buttons = { addEventListener: (type, fn) => { handlers[type] = fn; } };
	const root = { querySelector: sel => (sel === `#${name}` ? inner : sel === '.buttons' ? buttons : null) };
	let initialised = 0;
	const window_ = { init() { initialised += 1; }, getRoot: () => root };
	const document_ = { createElement: () => tip };

	new Function(name, 'document', `${snippet}; return ${name};`)(window_, document_);
	window_.init();
	return { handlers, tip, inner, initialised: () => initialised };
}

const over = name => ({
	target: { closest: () => (name === null ? null : { querySelector: () => ({ textContent: name }) }) }
});

test('hovering a button shows its name in a tip below the frame, in both versions', () => {
	for (const name of NAMES) {
		const { handlers, tip, inner, initialised } = tooltip(name);
		assert.strictEqual(initialised(), 1, `${name}: the window's own init must still run`);
		assert.deepStrictEqual(inner.children, [tip]);
		assert.strictEqual(tip.className, 'menu_tip');

		handlers.mouseover(over('Reputation Status'));
		assert.strictEqual(tip.textContent, 'Reputation Status');
		assert.strictEqual(tip.style.display, 'block');

		handlers.mouseover(over('Companions'));
		assert.strictEqual(tip.textContent, 'Companions', 'moving to the next button replaces the name');
	}
});

test('the tip goes away off a button, off the panel and while scrolling', () => {
	for (const name of NAMES) {
		const { handlers, tip } = tooltip(name);
		for (const leave of [() => handlers.mouseover(over(null)), () => handlers.mouseleave(), () => handlers.scroll()]) {
			handlers.mouseover(over('Mail'));
			assert.strictEqual(tip.style.display, 'block');
			leave();
			assert.strictEqual(tip.style.display, 'none');
		}
	}
});

test('a button with no name shows no tip', () => {
	for (const name of NAMES) {
		const { handlers, tip } = tooltip(name);
		handlers.mouseover(over('   '));
		assert.strictEqual(tip.style.display, 'none');
	}
});
