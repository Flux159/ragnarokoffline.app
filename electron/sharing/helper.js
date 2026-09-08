'use strict';
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const VERSION = '2026.8.3';
const RELEASED_AT = '2026-08-31T10:12:13Z';
// Official release asset digests, verified against GitHub's release metadata.
// Darwin executables are also pinned after extracting the one named member.
const BUILDS = {
  'darwin-arm64': ['cloudflared-darwin-arm64.tgz', '40c9144d86df8937c5b43293a1f7d2d2107029aa74725023dd46b1b27154352f', '50a04624531e7a98ddb65f1223905e32f84e7488ed3ee8dadcd3260aa8932603'],
  'darwin-x64': ['cloudflared-darwin-amd64.tgz', '61e1316266a00fd70ce40da011d612badc805367fb65293dd1925f938f704c99', '936aa4ed783b0e191fac48e7140c34605b25d8d5c0495c3599c90e350ae6e4c4'],
  'linux-x64': ['cloudflared-linux-amd64', 'f29324fe934d1e100617484c78deef803c4dc2cd351d645bbde42e96b4fccc5e'],
  'linux-arm64': ['cloudflared-linux-arm64', '4bcfd35521a7cbc545ebfd5d57334a71ee180e2a64874981f374c81472118391'],
  'win32-x64': ['cloudflared-windows-amd64.exe', '83e726ed18ea78c5ad5213c4c3a3a27051393950d2bc8ed4de69bec12d14eaae'],
};
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function helperDetails(directory) {
  const platform = process.platform + '-' + process.arch;
  const build = BUILDS[platform];
  return { platform, build, executable: path.join(directory, VERSION, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'),
    source: build ? `https://github.com/cloudflare/cloudflared/releases/download/${VERSION}/${build[0]}` : null };
}
function installationMetadata(executable, wanted) {
  try {
    const file = path.join(path.dirname(executable), 'installation.json');
    if (fs.statSync(file).size > 4096) return null;
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value.version !== VERSION || value.executableSha256 !== wanted) return null;
    // Only allow known timestamp fields into diagnostics, never arbitrary JSON.
    const timestamp = text => typeof text === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(text) && Number.isFinite(Date.parse(text)) ? text : null;
    return { downloadedAt: timestamp(value.downloadedAt), lastVerifiedAt: timestamp(value.lastVerifiedAt) };
  } catch { return null; }
}
function recordInstallation(details, downloadedAt = null) {
  const { executable, build, platform, source } = details;
  const executableSha256 = build[2] || build[1];
  const previous = installationMetadata(executable, executableSha256);
  const metadata = { version: VERSION, releasedAt: RELEASED_AT, platform, asset: build[0], source,
    archiveSha256: build[1], executableSha256, downloadedAt: downloadedAt || previous?.downloadedAt || null,
    lastVerifiedAt: new Date().toISOString() };
  const file = path.join(path.dirname(executable), 'installation.json');
  const temporary = file + '.' + crypto.randomBytes(6).toString('hex') + '.new';
  try {
    fs.writeFileSync(temporary, JSON.stringify(metadata, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}
// Read-only: collecting a report never downloads or executes a helper or reads
// tunnel credentials. A matching pinned executable hash establishes its version.
function helperDiagnostics(directory) {
  const { platform, build, executable, source } = helperDetails(directory);
  const report = { pinnedVersion: VERSION, releasedAt: RELEASED_AT, platform, asset: build?.[0] || null, source,
    updatePolicy: 'Pinned by the app; update the app to receive a newer helper.',
    supportPolicy: 'Cloudflare supports versions within one year of its most recent release.',
    installedVersion: null, integrity: build ? 'not downloaded' : 'unsupported platform' };
  if (!build) return report;
  report.expectedExecutableSha256 = build[2] || build[1];
  report.archiveSha256 = build[1];
  try {
    const stat = fs.statSync(executable);
    if (!stat.isFile() || stat.size > 80 * 1024 * 1024) { report.integrity = 'invalid executable'; return report; }
    report.executableSha256 = hash(fs.readFileSync(executable));
    report.integrity = report.executableSha256 === report.expectedExecutableSha256 ? 'verified' : 'checksum mismatch';
    if (report.integrity === 'verified') report.installedVersion = VERSION;
    const metadata = installationMetadata(executable, report.executableSha256);
    report.downloadedAt = metadata?.downloadedAt || null;
    report.lastVerifiedAt = metadata?.lastVerifiedAt || null;
  } catch (error) { report.integrity = error.code === 'ENOENT' ? 'not downloaded' : 'could not read executable'; }
  return report;
}
function download(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(parsed.hostname) || redirects > 4) return reject(Error('Invalid helper download location'));
    const request = https.get(parsed, { timeout: 60000 }, response => {
      if ([301,302,303,307,308].includes(response.statusCode)) {
        response.resume();
        try { resolve(download(new URL(response.headers.location, parsed).href, redirects + 1)); } catch { reject(Error('Invalid helper redirect')); }
        return;
      }
      if (response.statusCode !== 200) { response.resume(); reject(Error('Cloudflare helper download failed. Try again later.')); return; }
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > 80 * 1024 * 1024) request.destroy(); else chunks.push(chunk); });
      response.on('end', () => resolve(Buffer.concat(chunks))); response.on('error', () => reject(Error('Cloudflare helper download was interrupted.')));
    });
    request.on('timeout', () => request.destroy()); request.on('error', () => reject(Error('Could not download the Cloudflare helper.')));
  });
}
async function ensureHelper(directory, progress = () => {}) {
  const details = helperDetails(directory);
  const { build, executable } = details;
  if (!build) throw Error(`Cloudflare sharing is not packaged for ${details.platform} yet.`);
  const wanted = build[2] || build[1];
  progress(`Checking the Cloudflare helper (${VERSION}) for ${details.platform}…`);
  if (fs.existsSync(executable) && hash(fs.readFileSync(executable)) === wanted) {
    recordInstallation(details);
    progress('Cloudflare helper already downloaded and verified.');
    return executable;
  }
  fs.mkdirSync(path.dirname(executable), { recursive: true, mode: 0o700 });
  progress(`Downloading the Cloudflare helper (${build[0]}, ${VERSION})…`);
  const archive = await download(`https://github.com/cloudflare/cloudflared/releases/download/${VERSION}/${build[0]}`);
  progress(`Downloaded ${archive.length} bytes; verifying checksum…`);
  if (hash(archive) !== build[1]) throw Error('The Cloudflare helper checksum did not match what this build expects. Sharing was not started; nothing was installed.');
  let bytes = archive;
  if (build[0].endsWith('.tgz')) {
    const temporary = executable + '.' + crypto.randomBytes(6).toString('hex') + '.download'; fs.writeFileSync(temporary, archive, { mode: 0o600, flag: 'wx' });
    try {
      bytes = await new Promise((resolve, reject) => execFile('/usr/bin/tar', ['-xzOf', temporary, 'cloudflared'], { encoding: 'buffer', maxBuffer: 80 * 1024 * 1024, timeout: 30000 }, (error, stdout) => error ? reject(Error('Could not unpack the Cloudflare helper.')) : resolve(stdout)));
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  if (hash(bytes) !== wanted) throw Error('The unpacked Cloudflare executable checksum did not match what this build expects. Sharing was not started; nothing was installed.');
  const temporary = executable + '.' + crypto.randomBytes(6).toString('hex') + '.new'; fs.writeFileSync(temporary, bytes, { mode: 0o700, flag: 'wx' });
  try { fs.renameSync(temporary, executable); } finally { fs.rmSync(temporary, { force: true }); }
  recordInstallation(details, new Date().toISOString());
  progress('Cloudflare helper installed and verified.');
  return executable;
}
module.exports = { VERSION, RELEASED_AT, BUILDS, ensureHelper, helperDiagnostics };
