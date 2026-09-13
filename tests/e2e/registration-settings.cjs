// Opt-in real Settings/roBrowser registration policy. Owns one stopped disposable
// world for the duration; never reads or writes a player's save.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { _electron, chromium, devices, expect: defaultExpect } = require('@playwright/test');
const expect = defaultExpect.configure({ timeout: 90000 });
const generatedSecrets = [];
function freshPassword() { const value = crypto.randomBytes(8).toString('hex'); generatedSecrets.push(value); return value; }
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
const out = path.join(world, 'account-tests', 'registration-' + Date.now());
fs.mkdirSync(out, { recursive: true });
const report = { checks: [], screens: [], pageErrors: [] };
const env = { ...process.env, RAGNAROK_OFFLINE_HOME: world,
  RAGNAROKMAC_ROOT: path.join(world, 'runtime'), RAGNAROKMAC_STATE: state,
  NEBULA_HOME: path.join(world, 'nebula') };
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
    args: [path.join(work, 'electron/main.js'), '--quiet', '--user-data-dir=' + path.join(world, 'registration-electron-profile')],
    env, cwd: work, timeout: 45000 });
  let owner, browser;
  const invoke = (name, args) => owner.evaluate(({ name, args }) => window.__ELECTRON__.core.invoke(name, args), { name, args });
  try {
    owner = await app.firstWindow();
    await expect(owner.locator('body')).toContainText('Waiting for your client', { timeout: 30000 });
    await invoke('set_client_paths', { paths: { ...selected, mode: 'host', lan: false, vm_ram_mib: 4096 } });
    await invoke('start_stack');
    await verifyWorld();
    await invoke('open_settings');
    await expect.poll(() => app.windows().some(p => p.url().endsWith('settings.html'))).toBe(true);
    const page = app.windows().find(p => p.url().endsWith('settings.html'));
    page.setDefaultTimeout(240000);
    browser = await chromium.launch({ headless: true });
    report.browser = browser.version();
    const context = await browser.newContext({ ...devices['Pixel 5'] });
    const game = await context.newPage();
    game.setDefaultTimeout(90000);
    game.on('pageerror', error => report.pageErrors.push(error.message));
    async function signupAttempt(username, password, allowed) {
      const isolated = await browser.newContext({ ...devices['Pixel 5'] });
      try {
        const attempt = await isolated.newPage();
        attempt.setDefaultTimeout(45000);
        await attempt.goto('http://127.0.0.1:3338/');
        await attempt.getByLabel('Account', { exact: true }).fill(username);
        await attempt.getByLabel('Password', { exact: true }).fill(password);
        await attempt.getByRole('button', { name: 'Log in', exact: true }).tap();
        if (allowed) await expect(attempt.getByRole('button', { name: 'Character slot 1', exact: true })).toBeVisible();
        else {
          // REFUSE_LOGIN code 0 is an unregistered ID; code 1 is a wrong
          // password for an existing account. Assert the actual pinned message.
          await expect(attempt.locator('.text').filter({ hasText: /Unregistered ID/ })).toBeVisible();
          const era = (await invoke('get_settings')).prerenewal ? 'prerenewal' : 'renewal';
          const accounts = await invoke('accounts', { action: 'list', era });
          expect(accounts.accounts.some(a => [username, username.replace(/_[MF]$/, '')].includes(a.username))).toBe(false);
          report.rejectedSignupCount = (report.rejectedSignupCount || 0) + 1;
          if (report.rejectedSignupCount === 1) await attempt.screenshot({ path: path.join(out, 'signup-denied.png') });
        }
      } finally { await isolated.close(); }
    }
    // Verify the opt-out reverses cleanly while this is a local test host.
    await page.locator('#open-registration').selectOption('open');
    await page.locator('#registration-save').click();
    await expect(page.locator('#registration-status')).toHaveText('Game login signup is enabled.', { timeout: 240000 });
    const openUser = 'astraopen' + crypto.randomBytes(4).toString('hex');
    await signupAttempt(openUser + '_M', freshPassword(), true);
    const openAccounts = await invoke('accounts', { action: 'list', era: 'renewal' });
    expect(openAccounts.accounts.find(a => a.username === openUser)).toMatchObject({ group: 0, state: 0 });
    report.openSignupWorks = true;
    console.log('Native login signup enabled and verified');
    await page.locator('#open-registration').selectOption('owner');
    await page.locator('#registration-save').click();
    await expect(page.locator('#registration-status')).toContainText('Only the owner can create accounts', { timeout: 240000 });
    console.log('Owner-only policy applied through Settings');
    await page.locator('#accounts-panel').screenshot({ path: path.join(out, 'owner-policy.png') });
    for (const era of ['renewal', 'prerenewal', 'renewal']) {
      if (report.checks.length) {
        await game.goto('about:blank');
        await page.locator(era === 'renewal' ? '#era-re' : '#era-pre').click();
        const label = era === 'renewal' ? 'renewal' : 'pre-renewal';
        await expect(page.locator('#era-status')).toContainText(`Switched to ${label} in`, { timeout: 240000 });
      }
      await verifyWorld();
      expect(fs.readFileSync(path.join(state, 'conf/login_conf.txt'), 'utf8')).toMatch(/^new_account: no$/m);
      expect((await invoke('get_settings')).open_registration).toBe(false);
      for (const suffix of ['_M', '_F']) {
        await signupAttempt('astradeny' + crypto.randomBytes(4).toString('hex') + suffix,
          freshPassword(), false);
      }
      if (era === 'prerenewal') {
        await invoke('stack_repair');
        await verifyWorld();
        expect(fs.readFileSync(path.join(state, 'conf/login_conf.txt'), 'utf8')).toMatch(/^new_account: no$/m);
        await signupAttempt('astrarepair' + crypto.randomBytes(3).toString('hex') + '_F',
          freshPassword(), false);
        report.repairRetainsOwnerPolicy = true;
      }
      const friend = 'astraowner' + crypto.randomBytes(4).toString('hex');
      const friendPassword = freshPassword();
      await page.locator('#account-username').fill(friend);
      await page.locator('#account-password').fill(friendPassword);
      await page.locator('#account-confirmation').fill(friendPassword);
      await page.locator('#accounts-refresh').click();
      await expect(page.locator('#accounts-era')).toHaveText(era === 'renewal' ? 'Renewal accounts' : 'Pre-renewal accounts');
      // Refresh intentionally clears password fields; enter only after it finishes.
      await page.locator('#account-username').fill(friend);
      await page.locator('#account-password').fill(friendPassword);
      await page.locator('#account-confirmation').fill(friendPassword);
      await page.locator('#account-create').click();
      await expect(page.locator('#accounts-status')).toContainText('Account updated in ' + (era === 'prerenewal' ? 'pre-renewal' : era));
      await signupAttempt(friend, friendPassword, true);
      report.approvedAccounts = [...(report.approvedAccounts || []), { era, username: friend }];
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
      console.log('Owner registration policy and existing game login passed:', era);
    }
    expect(report.pageErrors).toEqual([]);
    console.log('Registration Settings/game checks passed. Evidence:', out);
  } finally {
    if (browser) await browser.close();
    // Use the owning shell to stop its assets before restoring selection files.
    // If teardown fails, retain the files so a later launch sees the true state.
    let stopped = false;
    try { if (owner) { await invoke('assets_stop'); await invoke('stack_down'); stopped = true; } }
    finally {
      await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
      if (stopped) {
        fs.rmSync(clientPath);
        if (settings) fs.writeFileSync(settingsPath, settings); else fs.rmSync(settingsPath, { force: true });
        fs.rmSync(path.join(state, 'prerenewal'), { force: true });
      }
      fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    }
  }
}
main().catch(error => {
  let message = String(error.message);
  for (const password of [...Object.values(credentials).map(c => c.password), ...generatedSecrets]) message = message.split(password).join('[redacted]');
  console.error(message); process.exitCode = 1;
});
