'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { VERSION, BUILDS, ensureHelper, helperDiagnostics } = require('../electron/sharing/helper');

test('helper records verified downloads and diagnostics stay read-only and exclude arbitrary metadata', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-helper-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  // This test worker replaces only its in-memory pin with a tiny known fixture.
  const platform = process.platform + '-' + process.arch;
  const original = BUILDS[platform];
  const bytes = Buffer.from('not an executable; diagnostics must never try to run it');
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  BUILDS[platform] = ['test-helper', digest];
  t.after(() => { BUILDS[platform] = original; });
  let downloads = 0;
  t.mock.method(https, 'get', (url, options, callback) => {
    assert.equal(url.href, `https://github.com/cloudflare/cloudflared/releases/download/${VERSION}/test-helper`);
    downloads++;
    const request = new EventEmitter();
    process.nextTick(() => { const response = Readable.from([bytes]); response.statusCode = 200; callback(response); });
    return request;
  });
  assert.equal(helperDiagnostics(directory).integrity, 'not downloaded');
  assert.deepEqual(fs.readdirSync(directory), []);
  assert.equal(downloads, 0);
  const executable = await ensureHelper(directory);
  const manifest = path.join(path.dirname(executable), 'installation.json');
  const first = helperDiagnostics(directory);
  assert.equal(first.installedVersion, VERSION);
  assert.equal(first.integrity, 'verified');
  assert.equal(first.executableSha256, digest);
  assert.ok(first.downloadedAt && first.lastVerifiedAt);
  assert.equal(downloads, 1);
  const metadata = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  metadata.secret = 'private-sentinel';
  metadata.source = 'private-sentinel';
  fs.writeFileSync(manifest, JSON.stringify(metadata));
  const before = fs.readFileSync(manifest, 'utf8');
  assert.ok(!JSON.stringify(helperDiagnostics(directory)).includes('private-sentinel'));
  assert.equal(fs.readFileSync(manifest, 'utf8'), before);
  assert.equal(await ensureHelper(directory), executable);
  assert.equal(downloads, 1);
  assert.equal(helperDiagnostics(directory).downloadedAt, first.downloadedAt);

  // A legacy verified cache has a known version but no invented download date.
  fs.unlinkSync(manifest);
  assert.equal(helperDiagnostics(directory).installedVersion, VERSION);
  assert.equal(helperDiagnostics(directory).downloadedAt, null);
  await ensureHelper(directory);
  assert.equal(helperDiagnostics(directory).downloadedAt, null);
  assert.ok(helperDiagnostics(directory).lastVerifiedAt);
  assert.equal(downloads, 1);

  for (const bad of ['{broken', JSON.stringify({ ...metadata, downloadedAt: 'private-sentinel', lastVerifiedAt: 'private-sentinel' }), 'x'.repeat(4097)]) {
    fs.writeFileSync(manifest, bad);
    const report = helperDiagnostics(directory);
    assert.equal(report.integrity, 'verified');
    assert.equal(report.downloadedAt, null);
    assert.equal(report.lastVerifiedAt, null);
    assert.ok(!JSON.stringify(report).includes('private-sentinel'));
  }
  fs.writeFileSync(executable, 'corrupted helper');
  const corrupted = helperDiagnostics(directory);
  assert.equal(corrupted.integrity, 'checksum mismatch');
  assert.equal(corrupted.installedVersion, null);
  assert.equal(downloads, 1);
  await ensureHelper(directory);
  assert.equal(downloads, 2);
  assert.equal(helperDiagnostics(directory).integrity, 'verified');
});
