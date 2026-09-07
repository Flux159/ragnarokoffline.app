// Real owner plus invited browser gameplay through a local TLS connector fixture. Owns one stopped disposable
// world for the duration; never reads or writes a player's save.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { _electron, chromium, devices, expect } = require('@playwright/test');
const { verifyWorld, snapshot } = require('./support.cjs');
const work = path.resolve(__dirname, '../..');
const liveCloudflare = process.env.RO_E2E_REAL_CLOUDFLARE === '1';
if (!process.env.RO_E2E_WORLD || !process.env.RO_E2E_CLIENT_JSON)
  throw Error('Set RO_E2E_WORLD and RO_E2E_CLIENT_JSON; stop the disposable world first');
const world = fs.realpathSync(process.env.RO_E2E_WORLD);
if (JSON.parse(fs.readFileSync(path.join(world, '.ragnarok-e2e.json'))).disposable !== true)
  throw Error('Not a disposable world');
const clientPath = path.join(world, 'client.json');
if (fs.existsSync(clientPath)) throw Error('Fixture requires no existing client.json');
const selected = JSON.parse(fs.readFileSync(process.env.RO_E2E_CLIENT_JSON));
const state = path.join(world, 'state');
const settingsPath = path.join(state, 'settings.json');
const settings = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath) : null;
if (fs.existsSync(path.join(state, 'prerenewal'))) throw Error('Start with renewal selected');
const credentials = Object.fromEntries(['renewal', 'prerenewal'].map(era => [era,
  JSON.parse(fs.readFileSync(path.join(world, era === 'renewal'
    ? 'account-test-credentials.json' : 'prerenewal-account-test-credentials.json'))),
]));
const out = path.join(world, 'account-tests', 'friends-sharing-' + Date.now());
fs.mkdirSync(out, { recursive: true });
// Keep a private recovery copy even if the app or test process exits before
// finally runs. Never copy account/service credentials into the report.
const recovery = path.join(out, 'recovery');
fs.mkdirSync(recovery, { mode: 0o700 });
fs.writeFileSync(path.join(recovery, 'selection.json'), JSON.stringify({
  clientExisted: false, settingsExisted: settings !== null, prerenewalExisted: false,
}), { mode: 0o600 });
if (settings) fs.writeFileSync(path.join(recovery, 'settings.json'), settings, { mode: 0o600 });
const report = { checks: [], screens: [], pageErrors: [], startedAt: new Date().toISOString() };
const serviceSecrets = [];
const env = { ...process.env, RAGNAROK_OFFLINE_HOME: world,
  RAGNAROKMAC_ROOT: path.join(world, 'runtime'), RAGNAROKMAC_STATE: state,
  NEBULA_HOME: path.join(world, 'nebula') };
function docker(args, input) {
  const socket = path.join(world, 'nebula/run/docker.sock');
  const host = process.platform === 'win32' ? 'tcp://127.0.0.1:' + fs.readFileSync(socket, 'utf8').trim() : 'unix://' + socket;
  const result = spawnSync(path.join(world, 'runtime/bin/docker-slim' + (process.platform === 'win32' ? '.exe' : '')), args,
    { env: { ...env, DOCKER_HOST: host }, encoding: 'utf8', input, timeout: 120000, maxBuffer: 1024 * 1024 });
  return result;
}
function query(sql, legacy = false, success = true) {
  const auth = legacy ? ['-uroot', '-pragnarok'] : ['--defaults-extra-file=/run/ragnarok-private/root.cnf'];
  const result = docker(['exec', '-i', 'ragnarok-db', 'mariadb', ...auth, '--protocol=TCP', '-h127.0.0.1', '--batch', '--skip-column-names', 'ragnarok'], sql);
  if (success && result.status !== 0) throw Error('Private test database query failed; output suppressed.');
  if (!success && result.status === 0) throw Error('Known legacy SQL root password was unexpectedly accepted.');
  return result.stdout.trim();
}
function journal(era) {
  const file = path.join(state, 'private/service-credentials', era, 'credentials.json');
  const body = fs.readFileSync(file, 'utf8');
  const value = JSON.parse(body);
  serviceSecrets.push(value.root, value.database, value.interserver);
  if (value.era !== era || !/^[a-f0-9]{64}$/.test(value.root) || !/^[a-f0-9]{64}$/.test(value.database)
      || !/^[A-Za-z0-9_-]{23}$/.test(value.interserver) || value.root === value.database) throw Error('Invalid generated service credential shape');
  return body;
}

function redact(error) {
  let message = String(error.message || error);
  for (const era of ['renewal', 'prerenewal']) { try { journal(era); } catch {} }
  for (const password of [...Object.values(credentials).map(c => c.password), ...serviceSecrets]) {
    if (password) message = message.split(password).join('[redacted]');
  }
  return message;
}

async function freePorts() {
  for (const port of [3338, 3339, 6900, 6121, 5121, 7462]) {
    await new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); reject(Error(`Port ${port} is occupied; stop the other host first`)); });
      socket.once('error', e => e.code === 'ECONNREFUSED' ? resolve() : reject(e));
      socket.setTimeout(1000, () => { socket.destroy(); reject(Error(`Port ${port} did not refuse connections`)); });
    });
  }
}
async function main() {
  await freePorts();
  const app = await _electron.launch({ executablePath: require('electron'),
    args: [path.join(work, 'tests/fixtures/sharing-main.cjs'), '--quiet', '--user-data-dir=' + path.join(world, 'friends-sharing-electron-profile')],
    env, cwd: work, timeout: 45000 });
  let owner, browser, game, tls;
  const tlsSockets = new Set();
  let failure, fixtureSecretCreated = false;
  const invoke = (name, args) => owner.evaluate(({ name, args }) => window.__ELECTRON__.core.invoke(name, args), { name, args });
  try {
    owner = await app.firstWindow();
    await expect(owner.locator('body')).toContainText('Waiting for your client', { timeout: 30000 });
    const boot = owner;
    boot.on('dialog', dialog => dialog.accept().catch(() => {}));
    await invoke('open_settings');
    await expect.poll(() => app.windows().some(p => p.url().endsWith('settings.html'))).toBe(true);
    const page = app.windows().find(p => p.url().endsWith('settings.html'));
    // The game page loses privileged IPC once it navigates. Keep owner actions
    // in Settings and complete the actual setup Continue handler instead of
    // starting services behind an abandoned "Waiting for your client" page.
    owner = page;
    await expect.poll(() => app.windows().some(p => p.url().endsWith('setup.html'))).toBe(true);
    const setup = app.windows().find(p => p.url().endsWith('setup.html'));
    await app.evaluate(({ dialog }) => { globalThis.roOriginalOpenDialog = dialog.showOpenDialog; });
    try {
      for (const key of ['data_grf', 'rdata_grf', 'official_grf', 'bgm_dir']) {
        if (!selected[key]) continue;
        // Stub only the OS file picker; real setup selection, validation,
        // save, boot reload, readiness and navigation all run unchanged.
        await app.evaluate(({ dialog }, chosen) => {
          dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
        }, selected[key]);
        await setup.locator(`[data-pick="${key}"]`).click();
        await expect(setup.locator('#p-' + key)).toHaveText(selected[key]);
      }
    } finally {
      await app.evaluate(({ dialog }) => {
        dialog.showOpenDialog = globalThis.roOriginalOpenDialog;
        delete globalThis.roOriginalOpenDialog;
      });
    }
    await setup.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(boot).toHaveURL(/^http:\/\/127\.0\.0\.1:3338\//, { timeout: 240000 });
    // The desktop skin uses the native WinLogin inputs; accessible Account
    // labels belong to the mobile adapter exercised separately below.
    await expect(boot.locator('#WinLogin .user')).toBeVisible({ timeout: 90000 });
    await verifyWorld();
    await boot.screenshot({ path: path.join(out, 'setup-completed-login.png') });
    report.screens.push('setup-completed-login.png');
    report.setupCompletedToNativeLogin = true;
    console.log('Real setup Continue reached the owned desktop login screen.');
    await app.evaluate(({ BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.setTitle('Ragnarok Offline — disposable acceptance test');
      }
    });
    await invoke('db_backup', { path: path.join(out, 'before-friends-sharing.sql') });
    // Only the connector is substituted: real TLS -> real invitation gateway
    // -> pinned Rust RemoteClient -> the same actual rAthena world.
    let origin;
    if (!liveCloudflare) {
    tls = https.createServer({ key: fs.readFileSync(path.join(work, 'tests/fixtures/tls/localhost-key.pem')),
      cert: fs.readFileSync(path.join(work, 'tests/fixtures/tls/localhost-cert.pem')) }, (req, res) => {
      const proxy = http.request({ host: '127.0.0.1', port: 3339, method: req.method, path: req.url, headers: req.headers }, reply => { res.writeHead(reply.statusCode, reply.headers); reply.pipe(res); });
      proxy.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); }); req.pipe(proxy);
    });
    tls.on('connection', socket => { tlsSockets.add(socket); socket.on('close', () => tlsSockets.delete(socket)); });
    tls.on('upgrade', (req, socket, head) => {
      const proxy = net.connect(3339, '127.0.0.1', () => {
        proxy.write(`GET ${req.url} HTTP/1.1\r\n` + Object.entries(req.headers).map(([name, value]) => name + ': ' + value).join('\r\n') + '\r\n\r\n');
        if (head.length) proxy.write(head); socket.pipe(proxy); proxy.pipe(socket);
      });
      socket.on('error', () => proxy.destroy()); proxy.on('error', () => socket.destroy()); socket.on('close', () => proxy.destroy()); proxy.on('close', () => socket.destroy());
    });
    await new Promise(resolve => tls.listen(0, '127.0.0.1', resolve));
    origin = 'https://localhost:' + tls.address().port;
    }
    await app.evaluate(({ clipboard }) => { globalThis.roSharingClipboard = clipboard.readText(); });
    if (!liveCloudflare) await app.evaluate(({ safeStorage, clipboard }, { work, world, origin }) => {
      const require = globalThis.roFixtureRequire;
      const fs = require('node:fs'), path = require('node:path');
      const secretFile = path.join(world, 'sharing/cloudflare.enc');
      if (fs.existsSync(secretFile)) throw Error('Refusing to overwrite existing Cloudflare setup');
      globalThis.roSharingClipboard = clipboard.readText();
      const store = new (require(path.join(work, 'electron/sharing/secrets')).SharingSecrets)(path.join(world, 'sharing'), safeStorage);
      store.save({ hostname: new URL(origin).host, tunnelId: '11111111-2222-3333-4444-555555555555', accountId: 'a'.repeat(32), secret: Buffer.alloc(32, 1).toString('base64') });
      const Controller = require(path.join(work, 'electron/sharing/controller')).SharingController;
      Controller.prototype.start = async function() {
        await this.guard();
        this.gateway = new (require(path.join(work, 'electron/sharing/gateway')).FriendGateway)({ origin, register: this.register });
        await this.gateway.start();
        this.update('sharing', 'Sharing through the local TLS acceptance fixture.');
      };
    }, { work, world, origin });
    fixtureSecretCreated = !liveCloudflare;
    await page.locator('#mp-internet-setup').check();
    await expect(page.locator('#sharing-start')).toBeEnabled({ timeout: 10000 });
    await page.locator('#sharing-start').click();
    const sharingDeadline = Date.now() + 240000;
    for (;;) {
      const status = await invoke('sharing_status');
      if (status.state === 'failed') throw Error(status.message);
      if (status.state === 'sharing') break;
      if (Date.now() >= sharingDeadline) throw Error('Sharing did not become ready: ' + status.message);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    await expect(page.locator('#sharing-state')).toContainText(liveCloudflare ? 'Sharing is on' : 'Sharing through', { timeout: 240000 });
    await page.locator('#sharing-copy').click();
    const link = await app.evaluate(({ clipboard }) => clipboard.readText());
    origin = new URL(link).origin;
    serviceSecrets.push(new URL(link).hash.slice('#invite='.length));
    report.transport = liveCloudflare ? 'real temporary Cloudflare HTTPS/WSS tunnel, normal certificate verification' : 'local TLS connector fixture, real gateway and game';
    await page.locator('#internet-hosting').screenshot({ path: path.join(out, 'sharing-settings.png') });
    let hostDisconnects = 0; boot.on('websocket', socket => { if (socket.url().endsWith(':5121')) socket.on('close', () => hostDisconnects++); });
    await boot.reload(); await boot.bringToFront();
    await boot.locator('#WinLogin .user').fill(credentials.renewal.account);
    await boot.locator('#WinLogin .pass').fill(credentials.renewal.password);
    await boot.locator('#WinLogin .connect').click(); await boot.locator('#slot0').dblclick();
    await expect.poll(async () => (await snapshot(boot)).input.canMove, { timeout: 90000 }).toBe(true);
    const mapBefore = JSON.parse(docker(['inspect', 'ragnarok-map']).stdout)[0];
    browser = await chromium.launch({ headless: true });
    // Two invited browsers make four rejected native logins each. Native
    // source-IP bans used to group these together and lock out every friend.
    // Distinct account/session limits allow these attempts but cap each one.
    for (let visitor = 0; visitor < 2; visitor++) {
      const attempts = await browser.newContext({ ignoreHTTPSErrors: !liveCloudflare });
      try {
        const loginPage = await attempts.newPage(); await loginPage.goto(link);
        await expect(loginPage.locator('#ready')).toBeVisible();
        const rejected = await loginPage.evaluate(async name => {
          const socket = new WebSocket(location.origin.replace('https:', 'wss:') + '/ws/127.0.0.1:6900');
          socket.binaryType = 'arraybuffer';
          await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(Error('Invited login socket failed')); });
          const packet = new Uint8Array(55), view = new DataView(packet.buffer);
          view.setUint16(0, 0x64, true); view.setUint32(2, 20221005, true);
          packet.set(new TextEncoder().encode(name), 6); packet.set(new TextEncoder().encode('invalid-test-password'), 30);
          const replies = [];
          try {
            for (let count = 0; count < 4; count++) {
              replies.push(await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(Error('Native login rejection timed out')), 5000);
                socket.onmessage = event => { clearTimeout(timer); const response = new DataView(event.data); resolve({ id: response.getUint16(0, true), error: response.getUint8(2) }); };
                socket.onclose = () => { clearTimeout(timer); reject(Error('Group was blocked after rejected passwords')); };
                socket.send(packet);
              }));
            }
          } finally { socket.onclose = null; socket.close(); }
          return replies;
        }, 'absent' + Date.now().toString(36) + visitor);
        expect(rejected).toHaveLength(4);
        for (const reply of rejected) { expect([0x6a, 0x83e]).toContain(reply.id); expect(reply.error).toBe(0); }
      } finally { await attempts.close(); }
    }
    report.checks.push('eight rejected native logins did not ban the shared proxy or prevent another friend from joining');
    // Trust only this test browser's loopback TLS fixture. Product probes do
    // not disable certificate validation and no system trust store is changed.
    const context = await browser.newContext({ ...devices['Pixel 5'], ignoreHTTPSErrors: !liveCloudflare });
    game = await context.newPage(); game.setDefaultTimeout(60000);
    game.on('pageerror', error => report.pageErrors.push(error.message));
    const sockets = []; game.on('websocket', socket => sockets.push(socket.url()));
    await game.goto(link);
    await expect(game.locator('#ready')).toBeVisible();
    expect(new URL(game.url()).hash).toBe('');
    const account = 'friend' + Date.now().toString(36), password = crypto.randomBytes(12).toString('base64url');
    serviceSecrets.push(password);
    fs.writeFileSync(path.join(out, 'friend-credentials.json'), JSON.stringify({ account, password }), { mode: 0o600 });
    await game.locator('#signup summary').tap();
    await game.locator('#username').fill(account); await game.locator('#password').fill(password); await game.locator('#confirmation').fill(password);
    await game.locator('#create').tap();
    await expect(game.locator('#status')).toContainText('Account created', { timeout: 60000 });
    expect(query(`SELECT group_id FROM login WHERE userid='${account}';`)).toBe('0');
    const mapAfter = JSON.parse(docker(['inspect', 'ragnarok-map']).stdout)[0];
    expect(mapAfter.Id).toBe(mapBefore.Id); expect(mapAfter.State.StartedAt).toBe(mapBefore.State.StartedAt);
    report.checks.push('invited group-0 creation did not restart the host server');
    await game.locator('a.play').tap();
    await game.getByLabel('Account', { exact: true }).fill(account); await game.getByLabel('Password', { exact: true }).fill(password);
    await game.getByRole('button', { name: 'Log in', exact: true }).tap();
    await game.getByRole('button', { name: 'Character slot 1', exact: true }).tap(); await game.getByRole('button', { name: 'Play / create', exact: true }).tap();
    await game.getByLabel('Character name', { exact: true }).fill('Friend' + Date.now().toString(36));
    await game.getByRole('button', { name: 'Create', exact: true }).tap();
    await game.getByRole('button', { name: 'Character slot 1', exact: true }).tap(); await game.getByRole('button', { name: 'Play / create', exact: true }).tap();
    await expect.poll(async () => (await snapshot(game)).input.canMove, { timeout: 90000 }).toBe(true);
    for (const port of [6900, 6121, 5121]) expect(sockets.some(url => url === origin.replace('https:', 'wss:') + '/ws/127.0.0.1:' + port)).toBe(true);
    const friend = await snapshot(game), map = friend.map.replace(/\.gat$/, '');
    await boot.bringToFront(); await boot.keyboard.press('Enter');
    await boot.locator('.input-chatbox').fill(`@warp ${map} ${Math.round(friend.player.position[0])} ${Math.round(friend.player.position[1])}`); await boot.keyboard.press('Enter');
    await expect.poll(async () => (await snapshot(boot)).map).toBe(friend.map);
    const phone = require('./phone.cjs');
    const greeting = 'Hello from an invited browser ' + Date.now();
    await phone.command(game, greeting);
    await expect(boot.locator('#ChatBox')).toContainText(greeting, { timeout: 30000 });
    report.checks.push('host and invited browser shared a map and received live chat over HTTPS/WSS');
    await game.screenshot({ path: path.join(out, 'friend-game.png') });
    await boot.screenshot({ path: path.join(out, 'host-game.png') });
    await expect(game.evaluate(() => window.__ELECTRON__.core.invoke('sharing_copy'))).rejects.toThrow();
    await page.bringToFront(); await page.locator('#sharing-stop').click();
    await expect(page.locator('#sharing-state')).toContainText('Sharing is off', { timeout: 15000 });
    await verifyWorld(); await boot.bringToFront();
    expect(hostDisconnects).toBe(0);
    expect(JSON.parse(docker(['inspect', 'ragnarok-map']).stdout)[0].State.Status).toBe('running');
    report.checks.push('Stop sharing disconnected remote access while the owned world kept running');
    expect(report.pageErrors).toEqual([]);
    console.log('Real shared-world invitation gameplay passed:', out);
  } catch (error) {
    failure = error;
    report.failure = redact(error);
    console.error('Acceptance failed:', report.failure);
    if (game && !game.isClosed()) await game.screenshot({ path: path.join(out, 'failed-game.png'), mask: [game.locator('input,textarea')] }).catch(() => {});
    // Capture the failing UI before cleanup can close it. Mask form fields;
    // no account or connector secrets should enter screenshots.
    for (const [index, page] of app.windows().entries()) {
      if (page.isClosed()) continue;
      await page.screenshot({ path: path.join(out, `failure-${index}.png`),
        mask: [page.locator('input, textarea')] }).catch(() => {});
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (owner && !owner.isClosed()) await invoke('sharing_stop').catch(() => {});
    if (tls) { for (const socket of tlsSockets) socket.destroy(); await new Promise(resolve => tls.close(resolve)); }
    await app.evaluate(({ clipboard }) => { if (globalThis.roSharingClipboard !== undefined) clipboard.writeText(globalThis.roSharingClipboard); }).catch(() => {});
    if (fixtureSecretCreated) fs.rmSync(path.join(world, 'sharing/cloudflare.enc'), { force: true });
    // Use the owning shell to stop its assets before restoring selection files.
    // If teardown fails, retain the files so a later launch sees the true state.
    let stopped = false;
    try {
      if (owner && !owner.isClosed()) {
        await invoke('assets_stop'); await invoke('stack_down');
        await freePorts(); stopped = true;
      }
    } catch (error) {
      report.cleanupFailure = redact(error);
    }
    finally {
      if (stopped) await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
      else {
        // Request the app's normal graceful teardown, never bypass it with
        // app.exit after a failed owner IPC call. Verify ports before restore.
        await app.close().catch(() => {});
        try { await freePorts(); stopped = true; } catch {}
      }
      if (stopped) {
        fs.rmSync(clientPath);
        if (settings) fs.writeFileSync(settingsPath, settings); else fs.rmSync(settingsPath, { force: true });
        fs.rmSync(path.join(state, 'prerenewal'), { force: true });
      }
      report.finishedAt = new Date().toISOString();
      fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    }
    if (!stopped && !failure) failure = Error('Owned teardown did not free all ports; selection files retained');
  }
  if (failure) throw failure;
}
main().catch(error => {
  console.error(redact(error)); process.exitCode = 1;
});
