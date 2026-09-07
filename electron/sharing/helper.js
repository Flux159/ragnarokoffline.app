'use strict';
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const VERSION = '2026.8.3';
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
async function ensureHelper(directory) {
  const build = BUILDS[process.platform + '-' + process.arch];
  if (!build) throw Error('Cloudflare sharing is not packaged for this platform yet.');
  const executable = path.join(directory, VERSION, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  const wanted = build[2] || build[1];
  if (fs.existsSync(executable) && hash(fs.readFileSync(executable)) === wanted) return executable;
  fs.mkdirSync(path.dirname(executable), { recursive: true, mode: 0o700 });
  const archive = await download(`https://github.com/cloudflare/cloudflared/releases/download/${VERSION}/${build[0]}`);
  if (hash(archive) !== build[1]) throw Error('The Cloudflare helper checksum did not match. Sharing was not started.');
  let bytes = archive;
  if (build[0].endsWith('.tgz')) {
    const temporary = executable + '.' + crypto.randomBytes(6).toString('hex') + '.download'; fs.writeFileSync(temporary, archive, { mode: 0o600, flag: 'wx' });
    try {
      bytes = await new Promise((resolve, reject) => execFile('/usr/bin/tar', ['-xzOf', temporary, 'cloudflared'], { encoding: 'buffer', maxBuffer: 80 * 1024 * 1024, timeout: 30000 }, (error, stdout) => error ? reject(Error('Could not unpack the Cloudflare helper.')) : resolve(stdout)));
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  if (hash(bytes) !== wanted) throw Error('The Cloudflare executable checksum did not match.');
  const temporary = executable + '.' + crypto.randomBytes(6).toString('hex') + '.new'; fs.writeFileSync(temporary, bytes, { mode: 0o700, flag: 'wx' });
  try { fs.renameSync(temporary, executable); } finally { fs.rmSync(temporary, { force: true }); }
  return executable;
}
module.exports = { VERSION, BUILDS, ensureHelper };
