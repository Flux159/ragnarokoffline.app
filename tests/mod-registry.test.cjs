'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const registry = require('../electron/mod-registry');

const INDEX = 'https://raw.githubusercontent.com/example/mods/main/index.json';
const sha = text => crypto.createHash('sha256').update(text).digest('hex');

function catalogue(files) {
  return JSON.stringify({ version: 1, mods: [{ name: 'tidy-mod', version: '1.0.0',
    author: 'someone', description: 'A mod.', files }] });
}

/** A registry that answers from memory, so the tests never touch the network. */
function fakeRegistry(contents, indexBody) {
  const files = new Map(Object.entries(contents));
  return async (url, limit) => {
    if (url === INDEX) return Buffer.from(indexBody);
    const prefix = 'https://raw.githubusercontent.com/example/mods/main/mods/tidy-mod/';
    if (!url.startsWith(prefix)) throw new Error(`unexpected fetch of ${url}`);
    const name = url.slice(prefix.length);
    if (!files.has(name)) throw new Error(`missing ${name}`);
    const bytes = Buffer.from(files.get(name));
    if (bytes.length > limit) throw new Error('too large');
    return bytes;
  };
}

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ro-registry-'));

test('a reviewed mod installs with every file verified', async () => {
  const contents = { 'mod.json': '{"name":"tidy-mod"}', 'db/item_db.yml': 'Header:\n' };
  const files = Object.entries(contents).map(([p, body]) => ({ path: p, sha256: sha(body) }));
  const modsDir = tempDir();
  const result = await registry.install('tidy-mod',
    { url: INDEX, fetch: fakeRegistry(contents, catalogue(files)), modsDir });
  assert.strictEqual(result.files, 2);
  assert.strictEqual(fs.readFileSync(path.join(modsDir, 'tidy-mod/mod.json'), 'utf8'), contents['mod.json']);
  assert.strictEqual(fs.readFileSync(path.join(modsDir, 'tidy-mod/db/item_db.yml'), 'utf8'), contents['db/item_db.yml']);
  fs.rmSync(modsDir, { recursive: true, force: true });
});

test('bytes that do not match the reviewed copy install nothing at all', async () => {
  const contents = { 'mod.json': '{"name":"tidy-mod"}', 'db/item_db.yml': 'tampered' };
  const files = [{ path: 'mod.json', sha256: sha(contents['mod.json']) },
                 { path: 'db/item_db.yml', sha256: sha('Header:\n') }];
  const modsDir = tempDir();
  await assert.rejects(
    registry.install('tidy-mod', { url: INDEX, fetch: fakeRegistry(contents, catalogue(files)), modsDir }),
    /does not match the reviewed copy/);
  // Not a partial folder the supervisor would find and half-apply.
  assert.deepStrictEqual(fs.readdirSync(modsDir), []);
  fs.rmSync(modsDir, { recursive: true, force: true });
});

test('an install replaces the previous copy rather than merging into it', async () => {
  const modsDir = tempDir();
  fs.mkdirSync(path.join(modsDir, 'tidy-mod'), { recursive: true });
  fs.writeFileSync(path.join(modsDir, 'tidy-mod/leftover.txt'), 'from an older version');
  const contents = { 'mod.json': '{"name":"tidy-mod"}' };
  const files = [{ path: 'mod.json', sha256: sha(contents['mod.json']) }];
  await registry.install('tidy-mod', { url: INDEX, fetch: fakeRegistry(contents, catalogue(files)), modsDir });
  assert.deepStrictEqual(fs.readdirSync(path.join(modsDir, 'tidy-mod')), ['mod.json']);
  fs.rmSync(modsDir, { recursive: true, force: true });
});

test('a file path cannot climb out of the mod folder', () => {
  for (const bad of ['../escape', '/etc/passwd', 'a/../../b', 'db\\item.yml', 'a/./b',
                     '', 'trailing ', 'trailing.', 'CON', 'nul.txt', 'a\0b']) {
    assert.strictEqual(registry.safeRelative(bad), null, `${JSON.stringify(bad)} must be refused`);
  }
  assert.strictEqual(registry.safeRelative('db/item_db.yml'), 'db/item_db.yml');
});

test('a mod entry cannot name where its bytes come from', () => {
  // Derived from the index location, so a reviewed entry cannot send the
  // download to a host nobody reviewed.
  assert.strictEqual(registry.fileUrl(INDEX, 'tidy-mod', 'mod.json'),
    'https://raw.githubusercontent.com/example/mods/main/mods/tidy-mod/mod.json');
  assert.throws(() => registry.fileUrl(INDEX, '../..', 'mod.json'), /does not resolve inside the registry/);
});

test('an index that is not the shape we understand is refused whole', () => {
  assert.throws(() => registry.readIndex('not json'), /not valid JSON/);
  assert.throws(() => registry.readIndex('{"version":2,"mods":[]}'), /format this version understands/);
  assert.throws(() => registry.readIndex('{"version":1}'), /format this version understands/);
});

test('a malformed entry is dropped without taking the rest of the list with it', () => {
  const body = JSON.stringify({ version: 1, mods: [
    { name: 'bad name!', files: [{ path: 'mod.json', sha256: sha('x') }] },
    { name: 'no-digest', files: [{ path: 'mod.json', sha256: 'nope' }] },
    { name: 'no-manifest', files: [{ path: 'readme.md', sha256: sha('x') }] },
    { name: 'traversal', files: [{ path: '../x', sha256: sha('x') }] },
    { name: 'good-mod', version: '2.0.0', files: [{ path: 'mod.json', sha256: sha('x') }] },
  ] });
  const mods = registry.readIndex(body);
  assert.deepStrictEqual(mods.map(m => m.name), ['good-mod']);
  assert.strictEqual(mods[0].version, '2.0.0');
});

test('a homepage is only carried through when it is https', () => {
  const entry = files => JSON.stringify({ version: 1, mods: [{ name: 'a-mod', homepage: files,
    files: [{ path: 'mod.json', sha256: sha('x') }] }] });
  assert.strictEqual(registry.readIndex(entry('https://example.com/m')).at(0).homepage, 'https://example.com/m');
  assert.strictEqual(registry.readIndex(entry('javascript:alert(1)')).at(0).homepage, '');
  assert.strictEqual(registry.readIndex(entry('http://example.com')).at(0).homepage, '');
});

test('tags, pictures and dependencies come through the index', () => {
  const body = JSON.stringify({ version: 1, mods: [{
    name: 'shiny', tags: ['ui', 'Quality-Of-Life', 'ok-tag', 'x'.repeat(30)],
    icon: 'images/icon.png', screenshots: ['a.png', 'b.jpg', 'c.gif', 'd.webp', 'e.png'],
    requires: { mods: ['base'], era: 'renewal', app: '>=1.2.0' },
    files: ['mod.json', 'images/icon.png', 'a.png', 'b.jpg', 'c.gif', 'd.webp', 'e.png']
      .map(p => ({ path: p, sha256: sha(p) })),
  }] });
  const mod = registry.readIndex(body)[0];
  // Uppercase and over-long tags are dropped rather than cleaned up silently.
  assert.deepStrictEqual(mod.tags, ['ui', 'ok-tag']);
  assert.strictEqual(mod.icon, 'images/icon.png');
  // Capped at four, in the order given.
  assert.deepStrictEqual(mod.screenshots, ['a.png', 'b.jpg', 'c.gif', 'd.webp']);
  assert.deepStrictEqual(mod.requires, { mods: ['base'], era: 'renewal', app: '>=1.2.0' });
});

test('a picture the mod does not ship is not shown', () => {
  const body = JSON.stringify({ version: 1, mods: [{
    name: 'sneaky', icon: 'https://elsewhere.example/pixel.png',
    screenshots: ['../outside.png', 'notes.txt', 'real.png'],
    files: [{ path: 'mod.json', sha256: sha('m') }, { path: 'notes.txt', sha256: sha('n') },
            { path: 'real.png', sha256: sha('r') }],
  }] });
  const mod = registry.readIndex(body)[0];
  // A URL is not one of its files, and a text file is not a picture.
  assert.strictEqual(mod.icon, '');
  assert.deepStrictEqual(mod.screenshots, ['real.png']);
});

test('a picture is fetched only when the entry declared it, and verified', async () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const body = JSON.stringify({ version: 1, mods: [{
    name: 'tidy-mod', icon: 'icon.png', screenshots: [],
    files: [{ path: 'mod.json', sha256: sha('m') }, { path: 'icon.png', sha256: sha(png) },
            { path: 'secret.yml', sha256: sha('s') }],
  }] });
  const fetch = fakeRegistry({ 'icon.png': png, 'secret.yml': 's' }, body);
  const url = INDEX;
  const data = await registry.image('tidy-mod', 'icon.png', { url, fetch });
  assert.match(data, /^data:image\/png;base64,/);
  assert.strictEqual(Buffer.from(data.split(',')[1], 'base64').toString('hex'), png.toString('hex'));
  // A file the mod ships but never offered as a picture is not reachable.
  await assert.rejects(registry.image('tidy-mod', 'secret.yml', { url, fetch }), /not one of its pictures/);
});

test('a picture whose bytes were swapped is refused', async () => {
  const body = JSON.stringify({ version: 1, mods: [{
    name: 'tidy-mod', icon: 'icon.png', screenshots: [],
    files: [{ path: 'mod.json', sha256: sha('m') }, { path: 'icon.png', sha256: sha('expected') }],
  }] });
  await assert.rejects(
    registry.image('tidy-mod', 'icon.png', { url: INDEX, fetch: fakeRegistry({ 'icon.png': 'swapped' }, body) }),
    /does not match the reviewed copy/);
});
