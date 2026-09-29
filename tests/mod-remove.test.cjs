'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { modFolder } = require('../electron/mod-remove');

function modsDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-mod-remove-'));
  fs.mkdirSync(path.join(dir, 'tidy-mod'));
  fs.writeFileSync(path.join(dir, 'tidy-mod', 'mod.json'), '{}');
  return dir;
}

test('a mod folder directly in the mods directory is the one removed', () => {
  const dir = modsDir();
  assert.strictEqual(modFolder(dir, 'tidy-mod'), path.join(path.resolve(dir), 'tidy-mod'));
});

test('names that reach outside the mods directory are refused', () => {
  const dir = modsDir();
  for (const name of ['', '.', '..', '../tidy-mod', 'a/b', 'a\\b', 'C:evil', '/etc', 'x\0y', null, 7]) {
    assert.throws(() => modFolder(dir, name), /not a mod name/, String(name));
  }
});

test('a mod that is not there says so', () => {
  assert.throws(() => modFolder(modsDir(), 'missing-mod'), /not in the mods folder/);
});

test('a file or a link in the mods directory is left alone', { skip: process.platform === 'win32' && 'links need privileges on Windows' }, () => {
  const dir = modsDir();
  fs.writeFileSync(path.join(dir, 'enabled.txt'), '');
  assert.throws(() => modFolder(dir, 'enabled.txt'), /not a plain folder/);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-mod-outside-'));
  fs.symlinkSync(outside, path.join(dir, 'linked-mod'), 'dir');
  assert.throws(() => modFolder(dir, 'linked-mod'), /not a plain folder/);
  assert.ok(fs.existsSync(outside));
});
