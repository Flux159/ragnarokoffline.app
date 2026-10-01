'use strict';
// Registry entries that point at a mod's own GitHub repository.
//
// Everything here runs against a fake GitHub on 127.0.0.1: the API's
// releases/latest, a download that redirects to a storage host, a rate limit,
// and releases built to be refused. CI never talks to github.com.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const source = require('../electron/mod-source');
const modZip = require('../electron/mod-zip');
const registry = require('../electron/mod-registry');

// ---------------------------------------------------------------------------
// A zip writer, small enough to read: stored entries, real CRCs, and the
// ability to write the things a hostile zip contains.

const CRC = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return bytes => {
    let c = 0xffffffff;
    for (const b of bytes) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();

/** entries: { name: string | { data, symlink, size } } */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const spec = typeof value === 'string' || Buffer.isBuffer(value) ? { data: value } : value;
    const data = Buffer.from(spec.data || '');
    const nameBytes = Buffer.from(name);
    const crc = CRC(data);
    const size = spec.size ?? data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by Unix
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    const mode = spec.symlink ? 0o120777 : name.endsWith('/') ? 0o040755 : 0o100644;
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const manifest = (version, extra = {}) => JSON.stringify({ name: 'npc-pack', version, ...extra });

// ---------------------------------------------------------------------------
// The fake GitHub.

function release(tag, assets, extra = {}) {
  return { tag_name: tag, name: tag, draft: false, prerelease: false, body: `Notes for ${tag}`,
    html_url: `https://github.com/someone/npc-pack/releases/tag/${tag}`, published_at: '2026-10-01T00:00:00Z',
    assets, zipball_url: '', ...extra };
}

async function fakeGitHub() {
  const files = new Map();      // path -> Buffer
  const releases = new Map();   // repo -> release JSON (or a function of the request)
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    const latest = /^\/repos\/([^/]+\/[^/]+)\/releases\/latest$/.exec(req.url);
    if (latest) {
      const answer = releases.get(latest[1]);
      if (typeof answer === 'function') return answer(req, res);
      if (!answer) { res.writeHead(404); return res.end('{"message":"Not Found"}'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(answer));
    }
    // GitHub's own shape: the release download redirects to a storage host.
    if (req.url.startsWith('/download/')) {
      res.writeHead(302, { location: req.url.replace('/download/', '/storage/') });
      return res.end();
    }
    if (req.url.startsWith('/huge/')) {
      res.writeHead(200, { 'content-length': String(source.ASSET_LIMIT + 1) });
      return res.end();
    }
    if (req.url.startsWith('/storage/') && files.has(req.url)) {
      res.writeHead(200, { 'content-type': 'application/zip' });
      return res.end(files.get(req.url));
    }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, files, releases, hits,
    // Publish a release whose asset is `zip`.
    publish(repo, tag, zip, assetName = `npc-pack-${tag.replace(/^v/, '')}.zip`, extra = {}) {
      files.set(`/storage/${repo}/${tag}/${assetName}`, zip);
      releases.set(repo, release(tag, [{ name: assetName, size: zip.length,
        browser_download_url: `${base}/download/${repo}/${tag}/${assetName}` }], extra));
    },
    options: extra => ({ api: base, allow: () => true, cache: new Map(), ...extra }),
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

const tempDir = tag => fs.mkdtempSync(path.join(os.tmpdir(), `ro-source-${tag}-`));
const listing = repo => [{ name: 'npc-pack', source: { github: repo, asset: 'npc-pack-*.zip' } }];

/** The whole install path main.js runs, minus the dialog. */
async function installLatest(gh, repo, modsDir, { appVersion = '1.4.0', validate } = {}) {
  const options = gh.options();
  const latest = await source.latestRelease(repo, options);
  const asset = source.pickAsset(latest, 'npc-pack-*.zip');
  const bytes = await source.download(asset, options);
  const staged = await source.stage('npc-pack', bytes, { modsDir, appVersion, validate });
  source.commit(staged, { modsDir, record: { repo, tag: latest.tag, asset: asset.name,
    sha256: source.sha256(bytes), version: staged.version, installedAt: '2026-10-01T00:00:00Z', releaseUrl: latest.url } });
  return { latest, asset, bytes, staged };
}

// ---------------------------------------------------------------------------

test('a source entry in the index is read, and a malformed one is dropped', () => {
  const body = JSON.stringify({ version: 1, mods: [
    { name: 'npc-pack', source: { github: 'someone/npc-pack', asset: 'npc-pack-*.zip' }, files: [] },
    { name: 'no-asset', source: { github: 'someone/no-asset' } },
    { name: 'bad-repo', source: { github: 'https://github.com/x/y' }, files: [] },
    { name: 'dot-repo', source: { github: 'someone/..' }, files: [] },
    { name: 'bad-asset', source: { github: 'a/b', asset: '../x.zip' }, files: [] },
    { name: 'not-zip', source: { github: 'a/b', asset: 'thing.exe' }, files: [] },
  ] });
  const mods = registry.readIndex(body);
  assert.deepStrictEqual(mods.map(m => m.name), ['npc-pack', 'no-asset']);
  assert.deepStrictEqual(mods[0].source, { github: 'someone/npc-pack', asset: 'npc-pack-*.zip' });
  assert.deepStrictEqual(mods[1].source, { github: 'someone/no-asset' });
});

test('the committed index gives an app without source support nothing to install', () => {
  // An app that predates `source` keeps only entries whose files include a
  // mod.json; a source entry must never look like one.
  const index = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'registry', 'index.json'), 'utf8'));
  for (const entry of index.mods.filter(m => m.source)) {
    assert.ok(!entry.files.some(f => f.path === 'mod.json'), `${entry.name} must not list a mod.json`);
  }
  assert.ok(index.mods.some(m => m.name === 'standart-npc' && m.source.github === 'MondoTruth/standart-npc'));
});

test('the installer for reviewed folders refuses a source entry', async () => {
  const mods = registry.readIndex(JSON.stringify({ version: 1, mods: [{ name: 'npc-pack', source: { github: 'a/b' } }] }));
  await assert.rejects(registry.install('npc-pack', { mods, modsDir: tempDir('refuse') }), /install it from its releases/);
});

test('asset patterns match whole names only', () => {
  const re = source.globToRegExp('standart-npc-*.zip');
  assert.ok(re.test('standart-npc-4.8.0.zip'));
  assert.ok(re.test('standart-npc-4_6_1.zip'));
  assert.ok(!re.test('standart-npc_4.4.zip'));
  assert.ok(!re.test('evil-standart-npc-1.zip'));
  assert.ok(!re.test('standart-npc-1.zip.exe'));
});

test('a release installs through redirects, with its provenance recorded', async () => {
  const gh = await fakeGitHub();
  try {
    const zip = makeZip({ 'npc-pack/': '', 'npc-pack/mod.json': manifest('4.8.0'), 'npc-pack/npc/warper.txt': 'script' });
    gh.publish('someone/npc-pack', 'v4.8.0', zip);
    const modsDir = tempDir('install');
    const { latest, asset } = await installLatest(gh, 'someone/npc-pack', modsDir);
    assert.strictEqual(latest.tag, 'v4.8.0');
    assert.strictEqual(asset.name, 'npc-pack-4.8.0.zip');
    assert.ok(gh.hits.some(h => h.startsWith('/download/')) && gh.hits.some(h => h.startsWith('/storage/')), 'followed the redirect');
    assert.strictEqual(fs.readFileSync(path.join(modsDir, 'npc-pack/npc/warper.txt'), 'utf8'), 'script');
    const record = source.readRecord(path.join(modsDir, 'npc-pack'));
    assert.strictEqual(record.repo, 'someone/npc-pack');
    assert.strictEqual(record.tag, 'v4.8.0');
    assert.strictEqual(record.asset, 'npc-pack-4.8.0.zip');
    assert.strictEqual(record.sha256, source.sha256(zip));
    assert.strictEqual(record.version, '4.8.0');
    // Nothing staged is left lying around, and nothing the supervisor would scan.
    assert.deepStrictEqual(fs.readdirSync(modsDir), ['npc-pack']);
  } finally { await gh.close(); }
});

test('a release with mod.json at the zip root installs under the registry name', async () => {
  const gh = await fakeGitHub();
  try {
    gh.publish('someone/npc-pack', 'v1.0.0', makeZip({ 'mod.json': manifest('1.0.0'), 'db/x.yml': 'Header:\n' }));
    const modsDir = tempDir('root');
    await installLatest(gh, 'someone/npc-pack', modsDir);
    assert.ok(fs.existsSync(path.join(modsDir, 'npc-pack/db/x.yml')));
  } finally { await gh.close(); }
});

test('with no matching asset the tagged source zip is used, and labelled as such', () => {
  const latest = { repo: 'someone/npc-pack', tag: 'v4.5.0', assets: [{ name: 'other.zip', size: 1, url: 'x' }],
    zipball: 'https://api.github.com/repos/someone/npc-pack/zipball/v4.5.0' };
  const asset = source.pickAsset(latest, 'npc-pack-*.zip');
  assert.strictEqual(asset.kind, 'zipball');
  assert.match(asset.name, /source code/);
  assert.throws(() => source.pickAsset({ ...latest, zipball: '' }, 'npc-pack-*.zip'), /no file to install/);
});

test('a rate limit is reported as one, with when to try again', async () => {
  const gh = await fakeGitHub();
  try {
    gh.releases.set('someone/npc-pack', (req, res) => {
      res.writeHead(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600) });
      res.end('{"message":"API rate limit exceeded"}');
    });
    await assert.rejects(source.latestRelease('someone/npc-pack', gh.options()),
      err => err instanceof source.RateLimited && /limiting release lookups/.test(err.message) && /try again after/.test(err.message));
  } finally { await gh.close(); }
});

test('a repository with no published release says so', async () => {
  const gh = await fakeGitHub();
  try {
    await assert.rejects(source.latestRelease('someone/nothing', gh.options()), /no published release/);
  } finally { await gh.close(); }
});

test('a draft or pre-release is never offered', async () => {
  const gh = await fakeGitHub();
  try {
    gh.releases.set('someone/npc-pack', release('v9.0.0', [], { prerelease: true }));
    await assert.rejects(source.latestRelease('someone/npc-pack', gh.options()), /draft or pre-release/);
  } finally { await gh.close(); }
});

test('lookups are cached briefly, and a fresh check goes back to GitHub', async () => {
  const gh = await fakeGitHub();
  try {
    gh.publish('someone/npc-pack', 'v1.0.0', makeZip({ 'mod.json': manifest('1.0.0') }));
    const options = gh.options();
    await source.latestRelease('someone/npc-pack', options);
    await source.latestRelease('someone/npc-pack', options);
    assert.strictEqual(gh.hits.filter(h => h.endsWith('/releases/latest')).length, 1);
    await source.latestRelease('someone/npc-pack', { ...options, fresh: true });
    assert.strictEqual(gh.hits.filter(h => h.endsWith('/releases/latest')).length, 2);
    let clock = Date.now() + source.CACHE_MS + 1;
    await source.latestRelease('someone/npc-pack', { ...options, now: () => clock });
    assert.strictEqual(gh.hits.filter(h => h.endsWith('/releases/latest')).length, 3);
  } finally { await gh.close(); }
});

test('an oversized asset is refused before and while downloading', async () => {
  const gh = await fakeGitHub();
  try {
    await assert.rejects(source.download({ name: 'big.zip', size: source.ASSET_LIMIT + 1, url: `${gh.base}/huge/x` }, gh.options()),
      /larger than 50 MB/);
    // The release said it was small; the server's own length says otherwise.
    await assert.rejects(source.download({ name: 'liar.zip', size: 10, url: `${gh.base}/huge/x` }, gh.options()),
      /larger than 50 MB/);
  } finally { await gh.close(); }
});

test('only GitHub over HTTPS is reachable outside tests', async () => {
  await assert.rejects(source.get('http://api.github.com/x', { limit: 10 }), /GitHub over HTTPS/);
  await assert.rejects(source.get('https://example.com/x', { limit: 10 }), /GitHub over HTTPS/);
  for (const ok of ['https://api.github.com/repos/a/b', 'https://github.com/a/b/releases/download/v1/x.zip',
                    'https://objects.githubusercontent.com/x', 'https://release-assets.githubusercontent.com/x',
                    'https://codeload.github.com/a/b/zip/v1']) {
    assert.ok(source.onlyGitHub(new URL(ok)), ok);
  }
  assert.ok(!source.onlyGitHub(new URL('https://github.com.evil.example/x')));
});

test('a zip-slip release installs nothing', async () => {
  const gh = await fakeGitHub();
  try {
    gh.publish('someone/npc-pack', 'v1.0.0', makeZip({ 'mod.json': manifest('1.0.0'), '../escaped.txt': 'gotcha' }));
    const modsDir = tempDir('slip');
    await assert.rejects(installLatest(gh, 'someone/npc-pack', modsDir), /unsafe path/);
    assert.deepStrictEqual(fs.readdirSync(modsDir), []);
    assert.ok(!fs.existsSync(path.join(path.dirname(modsDir), 'escaped.txt')));
  } finally { await gh.close(); }
});

test('a release carrying a link, or claiming to unpack huge, installs nothing', async () => {
  const modsDir = tempDir('hostile');
  const link = makeZip({ 'mod.json': manifest('1.0.0'), 'npc/x.txt': { data: '/etc/passwd', symlink: true } });
  await assert.rejects(source.stage('npc-pack', link, { modsDir, appVersion: '1.4.0' }), /contains a link/);
  const bomb = makeZip({ 'mod.json': manifest('1.0.0'), 'data/big.bin': { data: 'x', size: source.UNPACKED_LIMIT + 1 } });
  await assert.rejects(source.stage('npc-pack', bomb, { modsDir, appVersion: '1.4.0' }), /unpacks to more than/);
  assert.deepStrictEqual(fs.readdirSync(modsDir), []);
});

test('a release without a mod.json is not a mod', async () => {
  const modsDir = tempDir('nomanifest');
  await assert.rejects(source.stage('npc-pack', makeZip({ 'a/npc/x.txt': 's', 'b/npc/y.txt': 's' }), { modsDir, appVersion: '1.4.0' }),
    /no mod.json/);
  await assert.rejects(source.stage('npc-pack', makeZip({ 'mod.json': '{nope' }), { modsDir, appVersion: '1.4.0' }),
    /not valid JSON/);
});

test('an update that needs a newer app is refused and the old version stays', async () => {
  const gh = await fakeGitHub();
  try {
    const modsDir = tempDir('too-new');
    gh.publish('someone/npc-pack', 'v4.7.1', makeZip({ 'mod.json': manifest('4.7.1', { requires: { app: '>=1.3.4' } }) }));
    await installLatest(gh, 'someone/npc-pack', modsDir);
    gh.publish('someone/npc-pack', 'v4.8.0', makeZip({ 'mod.json': manifest('4.8.0', { requires: { app: '>=1.5.0' } }) }));
    await assert.rejects(installLatest(gh, 'someone/npc-pack', modsDir, { appVersion: '1.4.1' }),
      /needs app >=1\.5\.0, and this is 1\.4\.1\. Update the app first/);
    assert.strictEqual(source.readRecord(path.join(modsDir, 'npc-pack')).tag, 'v4.7.1');
    assert.deepStrictEqual(fs.readdirSync(modsDir), ['npc-pack']);
  } finally { await gh.close(); }
});

test('an update the supervisor would refuse leaves the working copy in place', async () => {
  const gh = await fakeGitHub();
  try {
    const modsDir = tempDir('refused');
    gh.publish('someone/npc-pack', 'v1.0.0', makeZip({ 'mod.json': manifest('1.0.0') }));
    await installLatest(gh, 'someone/npc-pack', modsDir);
    gh.publish('someone/npc-pack', 'v1.1.0', makeZip({ 'mod.json': manifest('1.1.0') }));
    await assert.rejects(installLatest(gh, 'someone/npc-pack', modsDir, {
      validate: async () => { throw new Error('mod.json: "requires" has no setting called "appp"'); },
    }), /would not load: .*appp.*Nothing was changed/);
    assert.strictEqual(source.readRecord(path.join(modsDir, 'npc-pack')).tag, 'v1.0.0');
    assert.deepStrictEqual(fs.readdirSync(modsDir), ['npc-pack']);
  } finally { await gh.close(); }
});

test('an update replaces the files and keeps the settings, which live outside them', async () => {
  const gh = await fakeGitHub();
  try {
    const state = tempDir('update');
    const modsDir = path.join(state, 'mods');
    gh.publish('someone/npc-pack', 'v4.7.1', makeZip({ 'standart/mod.json': manifest('4.7.1'), 'standart/npc/old.txt': 'old' }));
    await installLatest(gh, 'someone/npc-pack', modsDir);
    // What the supervisor keeps about the mod: options and the on/off choice.
    fs.writeFileSync(path.join(state, 'mod-settings.json'), '{\n  "npc-pack": { "enable_buffer": false }\n}\n');
    fs.writeFileSync(path.join(modsDir, 'disabled.txt'), 'npc-pack\n');

    gh.publish('someone/npc-pack', 'v4.8.0', makeZip({ 'standart/mod.json': manifest('4.8.0'), 'standart/npc/new.txt': 'new' }));
    const [check] = await source.checkUpdates([{ name: 'npc-pack', dir: path.join(modsDir, 'npc-pack') }],
      listing('someone/npc-pack'), gh.options());
    assert.deepStrictEqual([check.installed, check.latest, check.update], ['v4.7.1', 'v4.8.0', true]);
    assert.match(check.notes, /Notes for v4.8.0/);

    await installLatest(gh, 'someone/npc-pack', modsDir);
    assert.deepStrictEqual(fs.readdirSync(path.join(modsDir, 'npc-pack', 'npc')), ['new.txt']);
    assert.strictEqual(source.readRecord(path.join(modsDir, 'npc-pack')).tag, 'v4.8.0');
    assert.match(fs.readFileSync(path.join(state, 'mod-settings.json'), 'utf8'), /"enable_buffer": false/);
    assert.strictEqual(fs.readFileSync(path.join(modsDir, 'disabled.txt'), 'utf8'), 'npc-pack\n');
    // No staging or old copy left beside it.
    assert.deepStrictEqual(fs.readdirSync(modsDir).sort(), ['disabled.txt', 'npc-pack']);
  } finally { await gh.close(); }
});

test('a release cannot forge its own provenance', async () => {
  const modsDir = tempDir('forge');
  const forged = JSON.stringify({ repo: 'evil/elsewhere', tag: 'v99' });
  const staged = await source.stage('npc-pack', makeZip({ 'mod.json': manifest('1.0.0'), '.source.json': forged }),
    { modsDir, appVersion: '1.4.0' });
  assert.ok(!fs.existsSync(path.join(staged.staging, '.source.json')));
  source.discard(staged);
  assert.deepStrictEqual(fs.readdirSync(modsDir), []);
});

test('updates stop when the registry no longer lists the repository', async () => {
  const modsDir = tempDir('unlisted');
  fs.mkdirSync(path.join(modsDir, 'npc-pack'), { recursive: true });
  fs.writeFileSync(path.join(modsDir, 'npc-pack', '.source.json'), JSON.stringify({ repo: 'someone/npc-pack', tag: 'v1.0.0' }));
  const mods = [{ name: 'npc-pack', dir: path.join(modsDir, 'npc-pack') }];
  // Not asked of GitHub at all: there is no server here to answer.
  const options = { api: 'http://127.0.0.1:9', allow: () => true, cache: new Map() };
  assert.deepStrictEqual((await source.checkUpdates(mods, [], options))[0].listed, false);
  assert.deepStrictEqual((await source.checkUpdates(mods, listing('someone-else/npc-pack'), options))[0].listed, false);
  // A mod installed any other way has no record and is not looked up.
  fs.rmSync(path.join(modsDir, 'npc-pack', '.source.json'));
  assert.deepStrictEqual(await source.checkUpdates(mods, listing('someone/npc-pack'), options), []);
});

test('the content of a release is described for the confirmation', async () => {
  const modsDir = tempDir('contents');
  const staged = await source.stage('npc-pack', makeZip({ 'mod.json': manifest('1.0.0'), 'npc/a.txt': 's',
    'client/index.js': 'x', 'conf/when/enable_gm/groups.yml': 'x' }), { modsDir, appVersion: '1.4.0' });
  assert.deepStrictEqual(staged.contents, { serverScripts: true, clientCode: true, commands: true, tables: false });
  source.discard(staged);
});

test('versions and app requirements follow the supervisor\'s rules', () => {
  assert.ok(source.isNewer('v4.8.0', 'v4.7.1'));
  assert.ok(source.isNewer('v4.10.0', 'v4.9.0'));
  assert.ok(!source.isNewer('v4.7.1', 'v4.7.1'));
  assert.ok(!source.isNewer('v4.7.0', 'v4.7.1'));
  assert.ok(source.isNewer('nightly-2', 'nightly-1'));
  assert.strictEqual(source.appRequirement('>=1.3.4', '1.4.1'), null);
  assert.strictEqual(source.appRequirement('1.3.4', '1.4.1'), null);
  assert.strictEqual(source.appRequirement('>1.4.1', '1.4.1'), 'needs app >1.4.1, and this is 1.4.1');
  assert.strictEqual(source.appRequirement('=1.4.0', '1.4.1'), 'needs app =1.4.0, and this is 1.4.1');
  assert.match(source.appRequirement('latest', '1.4.1'), /not a version rule/);
  assert.strictEqual(source.appRequirement(undefined, '1.4.1'), null);
});

test('the zip reader sees what the unpacker would write', () => {
  const dir = tempDir('reader');
  const file = path.join(dir, 'x.zip');
  fs.writeFileSync(file, makeZip({ 'a/': '', 'a/b.txt': 'hi', 'a/link': { data: 'b.txt', symlink: true } }));
  assert.deepStrictEqual(modZip.zipEntries(file).map(e => [e.name, e.symlink, e.directory]),
    [['a/', false, true], ['a/b.txt', false, false], ['a/link', true, false]]);
  fs.writeFileSync(file, zlib.gzipSync('not a zip'));
  assert.throws(() => modZip.zipEntries(file), /not a zip/);
});

test('a player-picked zip goes through the same checks', () => {
  const dir = tempDir('picked');
  const file = path.join(dir, 'mod.zip');
  fs.writeFileSync(file, makeZip({ 'my-mod/mod.json': '{}', 'my-mod/npc/x.txt': 's', '__MACOSX/._x': 'litter' }));
  const { dir: out, files } = modZip.unpack(file);
  try {
    assert.deepStrictEqual(files.sort(), ['my-mod/mod.json', 'my-mod/npc/x.txt']);
    assert.strictEqual(modZip.singleTopLevel(files), 'my-mod');
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
  fs.writeFileSync(file, makeZip({ 'my-mod/../../x': 's' }));
  assert.throws(() => modZip.unpack(file), /unsafe path/);
  fs.writeFileSync(file, makeZip({ 'a.txt': '1', 'b.txt': '2', 'c.txt': '3' }));
  assert.throws(() => modZip.unpack(file, { maxFiles: 2 }), /more than 2 files/);
});
