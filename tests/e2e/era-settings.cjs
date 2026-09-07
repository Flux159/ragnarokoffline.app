// Opt-in real Settings/roBrowser era switching. Owns one stopped disposable
// world for the duration; never reads or writes a player's save.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
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
const out = path.join(world, 'account-tests', 'settings-eras-' + Date.now());
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
    args: [path.join(work, 'electron/main.js'), '--quiet', '--user-data-dir=' + path.join(world, 'eras-electron-profile')],
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
    for (const era of ['renewal', 'prerenewal', 'renewal']) {
      if (report.checks.length) {
        await game.goto('about:blank');
        await page.locator(era === 'renewal' ? '#era-re' : '#era-pre').click();
        const label = era === 'renewal' ? 'renewal' : 'pre-renewal';
        await expect(page.locator('#era-status')).toContainText(`Switched to ${label} in`, { timeout: 240000 });
      }
      await verifyWorld();
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
      console.log('Settings era and native game login passed:', era);
    }
    if (process.env.RO_E2E_JOIN_AT_END === '1') {
      const host = require('node:http').createServer((_request, response) => response.end('Join fixture'));
      await new Promise(resolve => host.listen(0, '127.0.0.1', resolve));
      try {
        await game.goto('about:blank');
        await invoke('set_client_paths', { paths: { mode: 'join', join_host: 'http://127.0.0.1:' + host.address().port } });
        await freePorts();
        expect(await invoke('save_settings', { settings: await invoke('get_settings') })).toContain('Joining starts no local server');
        await freePorts();
        report.hostToJoin = { localServicesStopped: true, settingsDoNotRestartHost: true };
        console.log('Real host-to-join transition stopped the local world and kept it stopped');
      } finally { host.closeAllConnections(); await new Promise(resolve => host.close(resolve)); }
    }
    expect(report.pageErrors).toEqual([]);
    console.log('Era Settings/game checks passed. Evidence:', out);
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
  for (const { password } of Object.values(credentials)) message = message.split(password).join('[redacted]');
  console.error(message); process.exitCode = 1;
});
