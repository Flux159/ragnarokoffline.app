// windows-latest checks text files out with CRLF; normalise on read so assertions about file
// content do not depend on the checkout's newline convention.
// Verify every client bitmap the CompanionPanel references actually exists.
//
// This is the check that was missing when the panel's tabs disappeared: the HTML
// named btn_tab_off.bmp / btn_tab_over.bmp, which do not exist in the client, and
// ui-button with a missing bg renders nothing at all. A build cannot catch that -
// the path is a string - so it is checked here against the running asset server,
// which serves the same GRFs the client reads.
//
// Usage:
//   node tests/companion-panel-assets.test.cjs [http://127.0.0.1:3338]
//
// The server address is discovered from the app's own state when not given. If no
// asset server is running the test SKIPS rather than fails, so it never blocks a
// build in an environment without a client installed.
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const HTML = path.join(ROOT, 'patches', 'CompanionPanel.html');

// The interface folder is CP949-encoded in the GRF; the asset server exposes it
// under its percent-encoded name. Observed from the client's own requests.
const UI_DIR = '/data/texture/%C0%AF%C0%FA%C0%CE%C5%CD%C6%E4%C0%CC%BD%BA/';

function discoverPort() {
	// The app writes its http port into the asset log line "Server ready on http://...".
	const state = path.join(os.homedir(), 'AppData', 'Roaming', 'Ragnarok Offline', 'state');
	for (const file of ['assets.log', 'app.log']) {
		const p = path.join(state, file);
		if (!fs.existsSync(p)) continue;
		const m = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n').match(/http:\/\/localhost:(\d+)/);
		if (m) return Number(m[1]);
	}
	return null;
}

function head(port, urlPath) {
	return new Promise(resolve => {
		const req = http.get({ host: '127.0.0.1', port, path: urlPath, timeout: 15000 }, res => {
			res.resume();
			resolve(res.statusCode);
		});
		req.on('error', () => resolve(0));
		req.on('timeout', () => { req.destroy(); resolve(0); });
	});
}

/** Every bitmap path the panel references, from both attributes and ui-image src. */
function referencedBitmaps(html) {
	const found = new Set();
	for (const m of html.matchAll(/(?:src|data-background|data-hover|data-down|data-active|bg|hover)="([^"$]+\.(?:bmp|tga|png))"/gi)) {
		found.add(m[1]);
	}
	return [...found];
}

const html = fs.readFileSync(HTML, 'utf8').replace(/\r\n/g, '\n');
const bitmaps = referencedBitmaps(html);
const port = Number(process.argv[2]) || discoverPort();

test('the panel references at least one bitmap', () => {
	assert.ok(bitmaps.length > 0, 'expected the HTML to reference bitmaps');
});

test('every referenced bitmap exists in the client', async (t) => {
	// The port may be stale in the log from a previous run, so probe first: if the
	// asset server is not up, skip. A closed game is not a failure.
	if (!port || (await head(port, UI_DIR + bitmaps[0])) === 0) {
		t.skip('no asset server running (start the game to check bitmaps)');
		return;
	}
	const missing = [];
	for (const rel of bitmaps) {
		const code = await head(port, UI_DIR + rel);
		// A 0 means the server went away mid-run; only a definite 4xx/5xx is a
		// missing file.
		if (code !== 0 && code !== 200) missing.push(`${rel} (HTTP ${code})`);
	}
	assert.deepStrictEqual(
		missing,
		[],
		'these bitmap paths do not exist in the client: a ui-button/ui-image with a missing source renders nothing, which is how the panel tabs vanished'
	);
});

test('no invented bitmap families', () => {
	// btn_tab_*.bmp does not exist in the client and was added by mistake once.
	const invented = bitmaps.filter(b => /(^|\/)btn_tab_/.test(b));
	assert.deepStrictEqual(invented, [], 'btn_tab_* bitmaps do not exist in this client');
});

test('the HTML wraps its content in the component-named root div', () => {
	// The component's CSS is injected into this component's SHADOW ROOT, while the
	// host element carries the id. A "#CompanionPanel ..." rule therefore cannot
	// match the host - it matches this wrapper. Without it every rule in the
	// stylesheet is dead and the window renders unstyled and unsized, which is
	// exactly how it shipped once. CheckAttendance.html and Bank.html wrap the same.
	const css = fs.readFileSync(path.join(ROOT, 'patches', 'CompanionPanel.css'), 'utf8').replace(/\r\n/g, '\n');
	const usesId = /#CompanionPanel\b/.test(css);
	assert.ok(usesId, 'the stylesheet is expected to root its rules at #CompanionPanel');
	assert.match(html, /<div id="CompanionPanel">/, 'the HTML must wrap its content in <div id="CompanionPanel">');
});

test('the window is sized by its content, not a fixed pixel width', () => {
	// A fixed width is what cropped the right-hand side when a tab's content was
	// wider than the panel.
	const css = fs.readFileSync(path.join(ROOT, 'patches', 'CompanionPanel.css'), 'utf8').replace(/\r\n/g, '\n');
	const panel = css.slice(css.indexOf('#CompanionPanel .panel'));
	assert.match(panel.slice(0, 400), /width:\s*max-content/, 'the panel should follow its content width');
});

test('a resize grip exists in both the markup and its stylesheet', () => {
	assert.match(html, /class="resize-grip"/, 'the markup needs the grip element');
	const css = fs.readFileSync(path.join(ROOT, 'patches', 'CompanionPanel.css'), 'utf8').replace(/\r\n/g, '\n');
	assert.match(css, /#CompanionPanel .resize-grip/, 'the grip needs styling to be visible and grabbable');
	const js = fs.readFileSync(path.join(ROOT, 'patches', 'CompanionPanel.js'), 'utf8').replace(/\r\n/g, '\n');
	assert.match(js, /resize-grip/, 'the grip needs pointer handling');
});
