// Opt-in real Settings/roBrowser mandatory hosting guard acceptance. Owns one stopped disposable
// world for the duration; never reads or writes a player's save.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawnSync } = require('node:child_process');
const { _electron, chromium, devices, expect } = require('@playwright/test');
const { verifyWorld, snapshot } = require('./support.cjs');
const work = path.resolve(__dirname, '../..');
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
const out = path.join(world, 'account-tests', 'map-stress-' + Date.now());
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
function fingerprint(legacy) {
  return query("SET SESSION group_concat_max_len=1048576; SELECT SHA2(GROUP_CONCAT(CONCAT_WS(':',account_id,HEX(userid),HEX(user_pass),sex,group_id,state) ORDER BY account_id SEPARATOR '|'),256) FROM login WHERE sex<>'S'; SELECT SHA2(GROUP_CONCAT(CONCAT_WS(':',char_id,account_id,HEX(name)) ORDER BY char_id SEPARATOR '|'),256) FROM `char`;", legacy);
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
  for (const port of [3338, 6900, 6121, 5121, 7462]) {
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
    args: [path.join(work, 'electron/main.js'), '--user-data-dir=' + path.join(world, 'map-stress-electron-profile')],
    env, cwd: work, timeout: 45000 });
  let owner, browser;
  let failure;
  const invoke = (name, args) => owner.evaluate(({ name, args }) => window.__ELECTRON__.core.invoke(name, args), { name, args });
  try {
    owner = await app.firstWindow();
    await expect(owner.locator('body')).toContainText('Waiting for your client', { timeout: 30000 });
    const boot = owner;
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
    page.setDefaultTimeout(240000);
    browser = await chromium.launch({ headless: true });
    report.browser = browser.version();
    report.requestedImage = process.env.RAGNAROKMAC_IMAGE || 'normal runtime image';
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const game = await context.newPage();
    game.setDefaultTimeout(60000);
    game.on('pageerror', error => report.pageErrors.push(error.message));
    const cycles = Number(process.env.RO_E2E_STRESS_CYCLES || 5);
    if (!Number.isInteger(cycles) || cycles < 1 || cycles > 100) throw Error('Invalid stress cycle count');
    async function login(era) {
      await game.goto('http://127.0.0.1:3338/');
      await game.locator('#WinLogin .user').fill(credentials[era].account);
      await game.locator('#WinLogin .pass').fill(credentials[era].password);
      await game.locator('#WinLogin .connect').click();
      await game.locator('#slot0').dblclick();
      await expect.poll(async () => (await snapshot(game)).input.canMove, { timeout: 90000 }).toBe(true);
    }
    async function command(value, acknowledgement) {
      await game.keyboard.press('Enter');
      const chat = game.locator('.input-chatbox');
      await chat.fill(value);
      await game.keyboard.press('Enter');
      if (acknowledgement) await expect(game.locator('#ChatBox')).toContainText(acknowledgement, { timeout: 60000 });
      await game.locator('.input-chatbox').blur();
    }
    async function healthy() {
      for (const service of ['ragnarok-map', 'ragnarok-char', 'ragnarok-login']) {
        const result = docker(['inspect', service]);
        if (result.status !== 0) throw Error('Game container inspection failed');
        const meta = JSON.parse(result.stdout)[0];
        const log = docker(['logs', '--tail', '150', service]);
        const text = log.stdout + log.stderr;
        if (meta.State.Status !== 'running' || /AddressSanitizer|runtime error:|Received a crash signal/.test(text)) {
          fs.writeFileSync(path.join(out, service + '-fault.log'), redact(text), { mode: 0o600 });
          report.fault = { service, container: meta.Id, image: meta.Image, state: meta.State };
          throw Error('Real game fault detected; original evidence retained');
        }
      }
    }
    for (const era of ['prerenewal', 'renewal']) {
      await game.goto('about:blank');
      await page.locator(era === 'renewal' ? '#era-re' : '#era-pre').click();
      await expect(page.locator('#era-status')).toContainText(`Switched to ${era === 'renewal' ? 'renewal' : 'pre-renewal'} in`, { timeout: 240000 });
      await invoke('db_backup', { path: path.join(out, `before-${era}.sql`) });
      for (const population of [false, true]) {
        await game.goto('about:blank');
        await invoke('save_settings', { settings: { hosting_scope: 'local', population_enable: population } });
        await verifyWorld();
        const meta = JSON.parse(docker(['inspect', 'ragnarok-map']).stdout)[0];
        const row = { era, population, image: meta.Image, startedAt: new Date().toISOString(), completed: 0, events: [] };
        report.checks.push(row);
        for (let cycle = 0; cycle < cycles; cycle++) {
          await login(era);
          await healthy();
          await command('@warp prontera 150 180');
          await expect.poll(async () => (await snapshot(game)).map, { timeout: 60000 }).toMatch(/^prontera/);
          await expect.poll(async () => (await snapshot(game)).input.canMove).toBe(true);
          if (population) {
            await command('@populate stats', 'Active / created / errors');
            row.populationStats = await game.locator('#ChatBox').evaluate(host => host.shadowRoot?.textContent || host.textContent);
            if (!/Active \/ created \/ errors\s*:\s*[1-9]/.test(row.populationStats)) throw Error('Population did not actually spawn');
          }
          await command('@reloadscript', 'Scripts have been reloaded.');
          await healthy();
          if (cycle % 2 === 0) {
            await game.keyboard.press('Escape');
            await game.locator('#Escape .charselect').click();
            await expect(game.locator('#slot0')).toBeVisible();
            row.events.push('native character-select logout');
          } else {
            await game.goto('about:blank');
            row.events.push('abrupt page disconnect');
          }
          await healthy();
          row.completed++;
          row.finishedAt = new Date().toISOString();
          fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
          console.log('Completed real reload/logout cycle:', era, 'population=' + population, cycle + 1);
        }
      }
    }
    await game.goto('about:blank');
  } catch (error) {
    failure = error;
    report.failure = redact(error);
    console.error('Acceptance failed:', report.failure);
    // Capture the failing UI before cleanup can close it. Mask form fields;
    // no account or connector secrets should enter screenshots.
    for (const [index, page] of app.windows().entries()) {
      if (page.isClosed()) continue;
      await page.screenshot({ path: path.join(out, `failure-${index}.png`),
        mask: [page.locator('input, textarea')] }).catch(() => {});
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
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
