'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { settingsPageFile, fileFor, allowedRequest, pageUrl, mergedValues, CSP } = require('../electron/mod-settings-window');

function modDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-mod-page-'));
  fs.mkdirSync(path.join(dir, 'settings'));
  fs.writeFileSync(path.join(dir, 'settings', 'index.html'), '<p>hi</p>');
  fs.writeFileSync(path.join(dir, 'settings', 'look 0.css'), 'p{}');
  fs.writeFileSync(path.join(dir, 'mod.json'), '{}');
  return fs.realpathSync(dir);
}

test('the declared page resolves to a file inside the mod and a URL on the private scheme', () => {
  const dir = modDir();
  const { root, file } = settingsPageFile(dir, 'settings/index.html');
  assert.strictEqual(root, dir);
  assert.strictEqual(file, path.join(dir, 'settings', 'index.html'));
  assert.strictEqual(pageUrl(root, file), 'ragnarok-mod://mod/settings/index.html');
});

test('a page path that leaves the mod, is not html, or is missing is refused', () => {
  const dir = modDir();
  for (const page of ['', '../x.html', 'settings/../../x.html', '/x.html', 'C:/x.html', 'settings\\index.html', 'mod.json', './settings/index.html', 7]) {
    assert.throws(() => settingsPageFile(dir, page), /not a file inside its folder/, String(page));
  }
  assert.throws(() => settingsPageFile(dir, 'settings/gone.html'), /missing/);
  assert.throws(() => settingsPageFile('relative/dir', 'settings/index.html'), /no settings page/);
});

test('the protocol handler only serves real files inside the mod folder', () => {
  const dir = modDir();
  assert.strictEqual(fileFor(dir, 'ragnarok-mod://mod/settings/index.html'), path.join(dir, 'settings', 'index.html'));
  assert.strictEqual(fileFor(dir, 'ragnarok-mod://mod/settings/look%200.css'), path.join(dir, 'settings', 'look 0.css'));
  for (const url of [
    'ragnarok-mod://mod/settings/missing.html',
    'ragnarok-mod://mod/settings',
    'ragnarok-mod://mod/',
    'ragnarok-mod://mod/settings/%2e%2e/%2e%2e/secret.txt',
    'ragnarok-mod://mod/settings/..%2f..%2fsecret.txt',
    'ragnarok-mod://mod/C:%5Cwindows%5Cwin.ini',
    'ragnarok-mod://other/settings/index.html',
    'file:///etc/passwd',
    'not a url',
  ]) {
    assert.strictEqual(fileFor(dir, url), null, url);
  }
});

test('a link inside the mod folder cannot reach outside it', { skip: process.platform === 'win32' && 'links need privileges on Windows' }, () => {
  const dir = modDir();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-mod-outside-'));
  fs.writeFileSync(path.join(outside, 'page.html'), 'secret');
  fs.symlinkSync(outside, path.join(dir, 'escape'), 'dir');
  assert.strictEqual(fileFor(dir, 'ragnarok-mod://mod/escape/page.html'), null);
  assert.throws(() => settingsPageFile(dir, 'escape/page.html'), /not a file inside its folder/);
});

test('only the private scheme and page-made data may be requested', () => {
  for (const url of ['ragnarok-mod://mod/settings/index.html', 'data:image/png;base64,AA==', 'blob:ragnarok-mod://mod/1234']) {
    assert.ok(allowedRequest(url), url);
  }
  for (const url of ['https://example.com/', 'http://127.0.0.1:8080/', 'ws://localhost/', 'file:///C:/Windows/win.ini', 'ragnarok-mod://other/x.html', 'devtools://x', 'nope']) {
    assert.ok(!allowedRequest(url), url);
  }
  assert.match(CSP, /connect-src 'self'/);
  assert.doesNotMatch(CSP, /https?:|\*/);
});

test('set merges into the declared settings and checks keys and types', () => {
  const declared = [
    { key: 'bounties', type: 'boolean', value: true },
    { key: 'gramps', type: 'boolean', value: true },
    { key: 'scale', type: 'number', value: 3 },
    { key: 'title', type: 'string', value: 'hi' },
  ];
  assert.deepStrictEqual(mergedValues(declared, { gramps: false, scale: 4 }),
    { bounties: true, gramps: false, scale: 4, title: 'hi' });
  assert.throws(() => mergedValues(declared, { nope: true }), /no setting called "nope"/);
  assert.throws(() => mergedValues(declared, { gramps: 'false' }), /expects a boolean/);
  assert.throws(() => mergedValues(declared, { title: null }), /expects a string/);
  for (const bad of [null, 'x', [], 3]) assert.throws(() => mergedValues(declared, bad), /expects an object/);
});
