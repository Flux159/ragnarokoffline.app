// Opt-in real Settings/roBrowser service credential migration and recovery. Owns one stopped disposable
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
const out = path.join(world, 'account-tests', 'service-credentials-' + Date.now());
fs.mkdirSync(out, { recursive: true });
const report = { checks: [], screens: [], pageErrors: [] };
const serviceSecrets = [];
const journals = new Map();
const accountChecks = new Set();
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
    args: [path.join(work, 'electron/main.js'), '--quiet', '--user-data-dir=' + path.join(world, 'service-credentials-electron-profile')],
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
      const directory = path.join(state, 'private/service-credentials', era);
      const wasManaged = fs.existsSync(path.join(directory, 'ready'));
      const previousPlayers = fingerprint(!wasManaged);
      const previousJournal = wasManaged ? journal(era) : null;
      await page.locator('#mp-internet-setup').check();
      await page.locator('#secure-services').click();
      await expect(page.locator('#secure-services')).toBeEnabled({ timeout: 300000 });
      await expect(page.locator('#services-status')).toHaveText('Internal service credentials secured for ' + era + '. Player accounts and characters were preserved.');
      const currentJournal = journal(era);
      if (previousJournal !== null && currentJournal !== previousJournal) throw Error('Idempotent preparation changed service credentials');
      if (fingerprint(false) !== previousPlayers) throw Error('Service migration changed player credentials or identities');
      query('SELECT 1;', true, false);
      if (journals.has(era) && journals.get(era) !== currentJournal) throw Error('Era switching changed its service journal');
      journals.set(era, currentJournal);
      if (era === 'prerenewal') {
        const first = JSON.parse(journals.get('renewal')), second = JSON.parse(currentJournal);
        if (first.root === second.root || first.database === second.database || first.interserver === second.interserver) throw Error('Eras shared service secrets');
      }
      if (report.checks.length === 0) {
        const backup = path.join(world, 'account-backups', 'managed-service-test.sql');
        await invoke('db_backup', { path: backup });
        expect(fs.statSync(backup).size).toBeGreaterThan(1000);
        const before = fs.readdirSync(path.join(state, 'backups')).filter(name => name.startsWith('before-service-credentials-renewal-') && name.endsWith('.sql')).sort();
        if (!before.length) throw Error('Pre-migration backup was not preserved');
        // Keep the fixture repeatable: current player data with the legacy
        // interserver row exercises restore without dropping later test users.
        const legacyBackup = path.join(world, 'account-backups', 'legacy-service-' + Date.now() + '.sql');
        fs.writeFileSync(legacyBackup, Buffer.concat([fs.readFileSync(backup),
          Buffer.from("\nUPDATE login SET user_pass='p1' WHERE account_id=1 AND BINARY userid='s1' AND sex='S';\n")]), { mode: 0o600, flag: 'wx' });
        await invoke('db_restore', { path: legacyBackup });
        await invoke('stack_up');
        if (fingerprint(false) !== previousPlayers || journal(era) !== currentJournal) throw Error('Restore did not retain player identities and current service credentials');
        query('SELECT 1;', true, false);
        report.managedBackupAndLegacyRestore = true;
        // Simulate an interrupted DDL sequence: application credentials have
        // changed but root still uses the legacy value. Only this guarded
        // disposable world is mutated, with its game services stopped first.
        for (const name of ['ragnarok-map', 'ragnarok-char', 'ragnarok-login']) {
          if (docker(['stop', '-t', '30', name]).status !== 0) throw Error('Could not stop disposable game service for recovery test');
        }
        fs.unlinkSync(path.join(directory, 'ready'));
        query("ALTER USER 'root'@'localhost' IDENTIFIED BY 'ragnarok';");
        await invoke('stack_up');
        if (fingerprint(false) !== previousPlayers || journal(era) !== currentJournal) throw Error('Pending migration recovery changed player data or regenerated secrets');
        query('SELECT 1;', true, false);
        report.partialMigrationRecovered = true;
      }
      if (!accountChecks.has(era)) {
        const random = require('node:crypto').randomBytes;
        const username = 'svc' + random(7).toString('hex');
        const password = random(9).toString('hex');
        const replacement = ' ' + random(8).toString('hex') + "'\\! ";
        serviceSecrets.push(password, replacement);
        await invoke('accounts', { action: 'create', era, username, password, confirmation: password });
        const list = await invoke('accounts', { action: 'list', era });
        const friend = list.accounts.find(account => account.username === username);
        expect(friend).toMatchObject({ group: 0, state: 0, defaultPassword: false });
        const account = { era, id: friend.id, username };
        await invoke('accounts', { ...account, action: 'password', password: replacement, confirmation: replacement });
        await invoke('accounts', { ...account, action: 'disable' });
        expect((await invoke('accounts', { action: 'list', era })).accounts.find(a => a.id === friend.id).state).toBe(5);
        await invoke('accounts', { ...account, action: 'enable' });
        expect((await invoke('accounts', { action: 'list', era })).accounts.find(a => a.id === friend.id)).toMatchObject({ ...friend, state: 0 });
        await game.goto('http://127.0.0.1:3338/');
        await game.getByLabel('Account', { exact: true }).fill(username);
        await game.getByLabel('Password', { exact: true }).fill(replacement);
        await game.getByRole('button', { name: 'Log in', exact: true }).tap();
        await expect(game.getByRole('button', { name: 'Character slot 1', exact: true })).toBeVisible({ timeout: 90000 });
        await game.goto('about:blank');
        accountChecks.add(era);
        report.managedAccountActions = [...accountChecks];
      }
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
      console.log('Service credentials, retained players and native game login passed:', era);
    }
    expect(report.pageErrors).toEqual([]);
    console.log('Service credential Settings/game checks passed. Evidence:', out);
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
  for (const era of ['renewal', 'prerenewal']) { try { journal(era); } catch {} }
  for (const password of [...Object.values(credentials).map(c => c.password), ...serviceSecrets]) message = message.split(password).join('[redacted]');
  console.error(message); process.exitCode = 1;
});
