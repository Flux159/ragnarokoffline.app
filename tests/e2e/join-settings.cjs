// Source-shell contract test with loopback HTTP/TLS fixtures. No VM/game assets
// are needed. This complements (does not replace) real three-stage RO login.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), https = require('node:https'), crypto = require('node:crypto');
const { _electron, expect } = require('@playwright/test');
const work = path.resolve(__dirname, '../..');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-join-settings-'));
const home = path.join(out, 'world'), runtime = path.join(home, 'runtime'), state = path.join(home, 'state');
fs.mkdirSync(runtime, { recursive: true }); fs.mkdirSync(state, { recursive: true });
// Also prevents migration from considering any real legacy player directory.
fs.writeFileSync(path.join(home, 'client.json'), '{}');
const certPath = path.join(work, 'tests/fixtures/tls/localhost-cert.pem');
const cert = fs.readFileSync(certPath), key = fs.readFileSync(path.join(work, 'tests/fixtures/tls/localhost-key.pem'));
const spki = crypto.createHash('sha256').update(new crypto.X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
const invite = 'loopback-test-invite-' + crypto.randomBytes(12).toString('hex');
const report = { checks: [], requests: [], tlsTrust: 'Public localhost test CA for Node; exact fixture SPKI exception for Chromium. No system trust store changes.' };
const serve = (req, res) => {
  report.requests.push({ url: req.url, cookie: !!req.headers.cookie, authorization: !!req.headers.authorization });
  if (req.url === '/') return res.writeHead(401).end('Invite required');
  res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>Loopback join fixture</title><h1>Host authentication fixture</h1>');
};
async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `${server instanceof https.Server ? 'https' : 'http'}://127.0.0.1:${server.address().port}`;
}
async function main() {
  const plain = http.createServer(serve), secure = https.createServer({ key, cert }, serve);
  const origins = [await listen(plain), await listen(secure)];
  const app = await _electron.launch({ executablePath: require('electron'), cwd: work,
    args: [path.join(work, 'electron/main.js'), '--quiet', '--user-data-dir=' + path.join(out, 'profile'), '--ignore-certificate-errors-spki-list=' + spki],
    env: { ...process.env, RAGNAROK_OFFLINE_HOME: home, RAGNAROKMAC_ROOT: runtime,
      RAGNAROKMAC_STATE: state, NEBULA_HOME: path.join(home, 'nebula'), NODE_EXTRA_CA_CERTS: certPath },
  });
  try {
    const boot = await app.firstWindow();
    await expect(boot.locator('body')).toContainText('Waiting for your client', { timeout: 15000 });
    await boot.evaluate(() => window.__ELECTRON__.core.invoke('open_settings'));
    await expect.poll(() => app.windows().some(p => p.url().endsWith('settings.html'))).toBe(true);
    const owner = app.windows().find(p => p.url().endsWith('settings.html'));
    const invoke = (name, args) => owner.evaluate(({ name, args }) => window.__ELECTRON__.core.invoke(name, args), { name, args });
    for (const origin of origins) {
      await invoke('set_client_paths', { paths: { mode: 'join', join_host: origin + '/api.html?app=ONLINE#invite=' + invite } });
      expect(JSON.parse(fs.readFileSync(path.join(home, 'client.json'))).join_host).toBe(origin);
      await invoke('start_stack');
      expect(await invoke('assets_ready')).toBe(true);
      const settings = await invoke('get_settings');
      expect(await invoke('save_settings', { settings })).toContain('Joining starts no local server');
      await invoke('save_settings', { settings: { prerenewal: true, max_aspd: 197 } });
      await owner.locator('#open-registration').selectOption('owner');
      await owner.locator('#registration-save').click();
      await expect(owner.locator('#registration-status')).toHaveText('Saved for your own server. It will apply when you next host.');
      expect(await invoke('get_settings')).toMatchObject({ open_registration: false, prerenewal: true, max_aspd: 197 });
      await invoke('launch_game');
      await expect(boot.locator('h1')).toHaveText('Host authentication fixture');
      expect(boot.url()).toBe(origin + '/api.html?app=ONLINE#invite=' + invite);
      expect(await boot.evaluate(() => window.__ELECTRON__.core.invoke('accounts', { action: 'list', era: 'renewal' }).then(() => false, () => true))).toBe(true);
      const title = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('http')).getTitle());
      expect(title).toContain(origin); expect(title).not.toContain(invite);
      await boot.evaluate(token => { console.error('Test redaction: ' + token); history.replaceState(null, '', '/api.html?app=ONLINE'); }, invite);
      await expect.poll(() => fs.readFileSync(path.join(state, 'client.log'), 'utf8')).toContain('[redacted invite]');
      expect(fs.readFileSync(path.join(state, 'client.log'), 'utf8')).not.toContain(invite);
      await invoke('launch_game');
      expect(boot.url()).toBe(origin + '/api.html?app=ONLINE');
      // A remote document cannot navigate into the exact privileged Settings
      // file or a different origin. Its current page remains the fixture.
      await boot.evaluate(() => { location.href = 'file:///tmp/untrusted-settings.html'; });
      expect(boot.url()).toBe(origin + '/api.html?app=ONLINE');
      await boot.evaluate(target => { location.href = target; }, origins.find(value => value !== origin));
      await expect.poll(() => fs.readFileSync(path.join(state, 'app.log'), 'utf8')).toContain('blocked game navigation');
      expect(boot.url()).toBe(origin + '/api.html?app=ONLINE');
      report.checks.push({ origin, inviteHandedOff: true, exchangedInviteCleared: true, gameIPCDenied: true, noLocalRuntime: true });
      await owner.screenshot({ path: path.join(out, new URL(origin).protocol.slice(0, -1) + '-settings.png') });
    }
    expect(fs.existsSync(path.join(home, 'nebula'))).toBe(false);
    expect(fs.readFileSync(path.join(home, 'client.json'), 'utf8')).not.toContain(invite);
    for (const name of ['phase', 'app.log', 'client.log'])
      if (fs.existsSync(path.join(state, name))) expect(fs.readFileSync(path.join(state, name), 'utf8')).not.toContain(invite);
    expect(report.requests.every(r => !r.url.includes(invite) && !r.authorization)).toBe(true);
    console.log('HTTP/TLS shell join contract passed. Evidence:', out);
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    for (const server of [plain, secure]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  }
}
main().catch(error => { console.error(String(error.message).split(invite).join('[redacted invite]')); process.exitCode = 1; });
