'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parse, list } = require('../electron/packetvers');
const store = require('../electron/settings-store');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('config/PACKETVERS parses, default first, and agrees with scripts/packetvers.sh', () => {
	const vers = list(root);
	assert.ok(vers.length >= 1);
	assert.equal(vers.filter(v => v.isDefault).length, 1);
	assert.ok(vers[0].isDefault);
	const { execFileSync } = require('node:child_process');
	if (process.platform !== 'win32') {
		const sh = execFileSync(path.join(root, 'scripts/packetvers.sh'), ['all'], { encoding: 'utf8' });
		assert.deepEqual(sh.trim().split('\n'), vers.map(v => v.version));
	}
});

test('a malformed line is refused rather than offered', () => {
	assert.throws(() => parse('2022-10-05\n'), /not a packet version/);
	assert.deepEqual(parse('# comment\n\n20221005   default  # trailing\n20200401\n').map(v => [v.version, v.tag]),
		[['20221005', 'default'], ['20200401', '']]);
});

// The client template, the image tag and the list must name the same default:
// the supervisor starts the unsuffixed build for it, and the template is what
// an install that never touches the setting is served.
test('the client template carries the default packet version', () => {
	const def = list(root)[0].version;
	assert.match(read('config/Config.local.js'), new RegExp(`packetver: ${def},`));
});

test('settings.json accepts null or an 8-digit version, and nothing else', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-packetver-'));
	const file = path.join(dir, 'settings.json');
	try {
		for (const packetver of [null, '20200401', 20200401]) {
			assert.equal(store.write(file, { packetver }, {}).packetver, packetver);
		}
		for (const packetver of ['2020', 'latest', true, {}, '20200401; rm -rf']) {
			assert.throws(() => store.write(file, { packetver }, {}), /client version/, String(packetver));
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// null follows the app's default. A saved number would pin today's default
// past the release that moves it.
test('the default is stored as null, and the Settings window offers the list', () => {
	const main = read('electron/main.js');
	assert.match(main, /\r?\n\tpacketver: null,\r?\n/);
	assert.match(main, /packetvers: \(\) => require\('\.\/packetvers'\)\.list\(projectRoot\(\)\)/);
	const html = read('src/settings.html');
	assert.match(html, /<select id="packetver">/);
	assert.match(html, /invoke\('packetvers'\)/);
	assert.match(html, /option\.value = p\.isDefault \? '' : p\.version/);
});
