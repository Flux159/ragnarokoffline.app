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
const out = path.join(world, 'account-tests', 'hosting-guards-' + Date.now());
fs.mkdirSync(out, { recursive: true });
// Keep a private recovery copy even if the app or test process exits before
// finally runs. Never copy account/service credentials into the report.
const recovery = path.join(out, 'recovery');
fs.mkdirSync(recovery, { mode: 0o700 });
fs.writeFileSync(path.join(recovery, 'selection.json'), JSON.stringify({
  clientExisted: false, settingsExisted: settings !== null, prerenewalExisted: false,
}), { mode: 0o600 });
if (settings) fs.writeFileSync(path.join(recovery, 'settings.json'), settings, { mode: 0o600 });
const report = { checks: [], screens: [], pageErrors: [] };
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
    args: [path.join(work, 'electron/main.js'), '--quiet', '--user-data-dir=' + path.join(world, 'hosting-guards-electron-profile')],
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
    const context = await browser.newContext({ ...devices['Pixel 5'] });
    const game = await context.newPage();
    game.setDefaultTimeout(90000);
    game.on('pageerror', error => report.pageErrors.push(error.message));
    for (const era of ['renewal', 'prerenewal', 'renewal']) {
      if (report.checks.length) {
        await game.goto('about:blank');
        await page.locator(era === 'renewal' ? '#era-re' : '#era-pre').click();
        const label = era === 'renewal' ? 'renewal' : 'pre-renewal';
        await expect(page.locator('#era-status')).toContainText(`Switched to ${label} in`, { timeout: 240000 });
      }
      await verifyWorld();
      const scope = report.checks.length === 2 ? 'public' : 'friends';
      await invoke('save_settings', { settings: { hosting_scope: scope, open_registration: true } });
      await verifyWorld();
      expect((await invoke('get_mode')).hosting_scope).toBe(scope);
      expect((await invoke('get_mode')).lan).toBe(false);
      expect((await invoke('get_settings')).open_registration).toBe(true);
      expect(fs.readFileSync(path.join(state, 'conf/login_conf.txt'), 'utf8')).toContain('new_account: no');
      journal(era); // redaction only; never copy credentials to reports.
      await page.reload();
      await expect(page.locator('#open-registration')).toHaveValue('owner');
      await expect(page.locator('#open-registration')).toBeDisabled();
      await expect(page.locator('#registration-save')).toBeDisabled();
      if (!report.guardedAdminLifecycle) {
        const random = require('node:crypto').randomBytes;
        const username = 'astraguard' + random(5).toString('hex');
        const hex = value => '0x' + Buffer.from(value).toString('hex');
        const gmBefore = query("SELECT SHA2(CONCAT_WS(':',account_id,HEX(userid),HEX(user_pass),group_id,state),256) FROM login WHERE account_id=2000000;");
        for (const name of ['ragnarok-map', 'ragnarok-char', 'ragnarok-login']) {
          if (docker(['stop', '-t', '30', name]).status !== 0) throw Error('Could not stop owned game service for guarded fixture');
        }
        query("INSERT INTO login (userid,user_pass,sex,email,group_id) VALUES (" + hex(username) + ",'ragnarok','M','a@a.com',99);");
        let blocked = false;
        try { await invoke('stack_up'); } catch (error) { blocked = String(error.message).includes('GM/admin'); }
        if (!blocked) throw Error('Internet startup accepted an unsafe renamed GM');
        const account = (await invoke('accounts', { action: 'list', era })).accounts.find(a => a.username === username);
        expect(account).toMatchObject({ group: 99, state: 0, defaultPassword: true });
        await invoke('accounts', { action: 'disable', era, id: account.id, username });
        await invoke('stack_up');
        blocked = false;
        try { await invoke('accounts', { action: 'enable', era, id: account.id, username }); }
        catch (error) { blocked = String(error.message).includes('internet account safeguards failed'); }
        if (!blocked) throw Error('Enabling an unsafe GM bypassed the restart guard');
        for (const name of ['ragnarok-map', 'ragnarok-char', 'ragnarok-login']) {
          const status = docker(['inspect', '-f', '{{.State.Status}}', name]);
          if (status.status !== 0 || status.stdout.trim() === 'running') throw Error('Unsafe admin edit restarted game services');
        }
        const password = random(9).toString('hex'); serviceSecrets.push(password);
        await invoke('accounts', { action: 'password', era, id: account.id, username, password, confirmation: password });
        await invoke('stack_up');
        expect(query("SELECT SHA2(CONCAT_WS(':',account_id,HEX(userid),HEX(user_pass),group_id,state),256) FROM login WHERE account_id=2000000;")).toBe(gmBefore);
        await invoke('accounts', { action: 'disable', era, id: account.id, username });
        report.guardedAdminLifecycle = true;
      }
      await page.locator('#mp-internet-setup').check();
      await page.locator('#hosting-check').click();
      await expect(page.locator('#hosting-check')).toBeEnabled({ timeout: 60000 });
      await expect(page.locator('#hosting-checks li')).toHaveCount(3);
      const readiness = await invoke('hosting_check');
      expect(readiness).toMatchObject({ era, scope, accountPolicyReady: true, publicationReady: false });
      expect(readiness.checks.every(check => check.passed)).toBe(true);
      report.readiness = [...(report.readiness || []), readiness];
      // Native suffix signup must remain off even while the saved local
      // preference says true; no browser assertion alone proves provisioning.
      const random = require('node:crypto').randomBytes;
      const rejected = 'gate' + random(6).toString('hex');
      const rejectedPassword = random(9).toString('hex'); serviceSecrets.push(rejectedPassword);
      await game.goto('http://127.0.0.1:3338/');
      await game.getByLabel('Account', { exact: true }).fill(rejected + '_F');
      await game.getByLabel('Password', { exact: true }).fill(rejectedPassword);
      await game.getByRole('button', { name: 'Log in', exact: true }).tap();
      await expect(game.locator('.text').filter({ hasText: /Unregistered ID/ })).toBeVisible({ timeout: 90000 });
      expect(query("SELECT COUNT(*) FROM login WHERE userid IN ('" + rejected + "','" + rejected + "_F');")).toBe('0');
      await game.goto('about:blank');
      await page.getByRole('button', { name: 'Refresh accounts', exact: true }).click();
      await expect(page.locator('#accounts-era')).toHaveText(era === 'renewal' ? 'Renewal accounts' : 'Pre-renewal accounts');
      const accounts = await invoke('accounts', { action: 'list', era });
      const gm = accounts.accounts.find(a => a.id === '2000000');
      expect(gm).toMatchObject({ username: 'ragnarok', group: 99, state: 0, defaultPassword: false });
      const config = await (await context.request.get('http://127.0.0.1:3338/Config.local.js')).text();
      expect(config).toContain(`renewal: ${era === 'renewal'},`);
      const prefix = String(report.checks.length) + '-' + era;
      await page.locator('#accounts-panel').screenshot({ path: path.join(out, prefix + '-accounts.png') });
      await game.goto('http://127.0.0.1:3338/');
      await game.getByLabel('Account', { exact: true }).fill(credentials[era].account);
      await game.getByLabel('Password', { exact: true }).fill(credentials[era].password);
      await game.getByRole('button', { name: 'Log in', exact: true }).tap();
      await game.getByRole('button', { name: 'Character slot 1', exact: true }).tap();
      await game.getByRole('button', { name: 'Play / create', exact: true }).tap();
      if (era === 'prerenewal') {
        await expect.poll(async () => await game.getByLabel('Character name', { exact: true }).isVisible()
          || !!(await snapshot(game))?.input?.canMove).toBe(true);
        if (await game.getByLabel('Character name', { exact: true }).isVisible()) {
          await game.getByLabel('Character name', { exact: true }).fill('AstraEra');
          await game.getByRole('button', { name: 'Create', exact: true }).tap();
          await game.getByRole('button', { name: 'Character slot 1', exact: true }).tap();
          await game.getByRole('button', { name: 'Play / create', exact: true }).tap();
        }
      }
      await expect.poll(async () => (await snapshot(game)).input.canMove, { timeout: 90000 }).toBe(true);
      expect(await game.evaluate(() => window.ROConfigLocal.servers[0].renewal)).toBe(era === 'renewal');
      const current = await snapshot(game);
      report.checks.push({ era, configMatches: true, gm, player: current.player, map: current.map });
      await game.screenshot({ path: path.join(out, prefix + '-map.png') });
      report.screens.push(prefix + '-accounts.png', prefix + '-map.png');
      console.log('Mandatory internet policy, rejected signup and native GM game login passed:', era, scope);
      // Explicit opt-in: validate the new handler inside real rAthena, after
      // gameplay screenshots. This is injected-signal proof, not reproduction
      // of the intermittent crash, and runs only in this marked test world.
      if (process.env.RO_E2E_NATIVE_CRASH_TRACE === '1'
          && !(report.nativeTraces || []).some(trace => trace.era === era)) {
        await game.goto('about:blank');
        const before = JSON.parse(docker(['inspect', 'ragnarok-map']).stdout)[0];
        // The pinned slim runtime accepts numeric signals, but silently maps
        // the unsupported SEGV name to SIGTERM. Use Linux SIGSEGV explicitly.
        expect(docker(['kill', '--signal', '11', 'ragnarok-map']).status).toBe(0);
        await expect.poll(() => {
          const value = docker(['inspect', '-f', '{{.State.Status}}', 'ragnarok-map']);
          return value.status === 0 ? value.stdout.trim() : 'unknown';
        }, { timeout: 60000 }).toBe('exited');
        const after = JSON.parse(docker(['inspect', 'ragnarok-map']).stdout)[0];
        // Retain only bounded, non-secret incident identity if capture fails.
        report.nativeSignalAttempts = [...(report.nativeSignalAttempts || []), {
          era, signal: 11, container: before.Id, image: before.Image,
          exitCode: after.State.ExitCode, oomKilled: after.State.OOMKilled,
        }];
        const reportsDir = path.join(state, 'crashes/reports');
        let captured;
        await expect.poll(() => {
          // The owning shell's monitor may already have captured this incident.
          spawnSync(path.join(world, 'runtime/bin/ragnarok-stack' + (process.platform === 'win32' ? '.exe' : '')),
            ['capture-crashes'], { env, encoding: 'utf8', timeout: 60000 });
          for (const name of fs.existsSync(reportsDir) ? fs.readdirSync(reportsDir) : []) {
            if (!name.startsWith('incident-') || !name.endsWith('.log')) continue;
            const body = fs.readFileSync(path.join(reportsDir, name), 'utf8');
            const metadata = JSON.parse(body.split('\n')[0]);
            if (metadata.container === before.Id) captured = { metadata, body, name };
          }
          return !!captured;
        }, { timeout: 90000 }).toBe(true);
        expect(captured.metadata.backtraceAvailable).toBe(true);
        expect(captured.metadata.image).toBe(before.Image);
        expect(captured.body.includes('RAGNAROK_CRASH_FRAME index=0x0 ')).toBe(true);
        expect(captured.body.includes('RAGNAROK_CRASH_TRACE v1 signal=0xb ')).toBe(true);
        // An external signal can interrupt a libc syscall, and unwinding may
        // stop there. Main-image frames/source lookup are asserted by the
        // image's deliberate in-process fault fixture, not guaranteed here.
        const frames = captured.body.split('\n').filter(line => line.includes('RAGNAROK_CRASH_FRAME '));
        expect(frames.length).toBeGreaterThan(0);
        expect(frames.length).toBeLessThanOrEqual(32);
        expect(captured.body.indexOf('RAGNAROK_CRASH_TRACE v1')).toBeLessThan(
          captured.body.indexOf('Received a crash signal'));
        report.nativeTraces = [...(report.nativeTraces || []), { era,
          artifact: captured.name, metadata: captured.metadata, frames,
          mainImageFrameAvailable: frames.some(line => line.includes('main_offset=')),
          injectedSignal: true }];
        await invoke('stack_up');
        await verifyWorld();
        console.log('Injected rAthena signal retained native frames before emergency-save handler:', era);
      }

    }
    expect(report.pageErrors).toEqual([]);
    console.log('Hosting guard Settings/game checks passed. Evidence:', out);
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
      fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    }
    if (!stopped && !failure) failure = Error('Owned teardown did not free all ports; selection files retained');
  }
  if (failure) throw failure;
}
main().catch(error => {
  console.error(redact(error)); process.exitCode = 1;
});
