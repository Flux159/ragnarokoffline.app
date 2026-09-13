// Real Electron recovery UI with an ephemeral HTTP host; no VM or player save.
'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http');
const { _electron, expect } = require('@playwright/test');
const root = path.resolve(__dirname, '../..');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-startup-recovery-'));
const state = path.join(out, 'state');
fs.mkdirSync(state);
fs.writeFileSync(path.join(out, 'client.json'), '{}');
let broken = true, requests = 0;
const server = http.createServer((req, res) => {
  if (req.url === '/') return res.end('ready');
  requests++;
  if (broken) return req.socket.destroy();
  res.setHeader('Content-Type', 'text/html');
  res.end('<h1>Recovered game fixture</h1>');
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const app = await _electron.launch({ executablePath: require('electron'), cwd: root,
    args: [path.join(root, 'electron/main.js'), '--quiet', '--user-data-dir=' + path.join(out, 'profile')],
    env: { ...process.env, RAGNAROK_OFFLINE_HOME: out, RAGNAROKMAC_ROOT: path.join(out, 'runtime'),
      RAGNAROKMAC_STATE: state, NEBULA_HOME: path.join(out, 'nebula') } });
  try {
    const game = await app.firstWindow();
    await expect(game.locator('#status')).toHaveText('Waiting for your client…');
    await expect.poll(() => app.windows().some(p => p.url().endsWith('setup.html'))).toBe(true);
    await app.windows().find(p => p.url().endsWith('setup.html')).close();
    await game.getByRole('button', { name: 'Choose client files…' }).click();
    await expect.poll(() => app.windows().some(p => p.url().endsWith('setup.html'))).toBe(true);
    await game.evaluate(() => window.__ELECTRON__.core.invoke('open_settings'));
    await expect.poll(() => app.windows().some(p => p.url().endsWith('settings.html'))).toBe(true);
    const owner = app.windows().find(p => p.url().endsWith('settings.html'));
    const invoke = (name, args) => owner.evaluate(({name,args}) => window.__ELECTRON__.core.invoke(name,args), {name,args});
    await invoke('set_client_paths', { paths: { mode: 'join', join_host: origin } });
    await invoke('open_game');
    await expect(game.locator('#fail')).toContainText('The game page could not load', { timeout: 30000 });
    await expect(game.locator('#retry')).toBeVisible();
    await expect(game.locator('#repair')).toBeHidden();
    const failedRequests = requests;
    await game.waitForTimeout(1200);
    expect(requests).toBe(failedRequests); // Recovery does not retry in a loop.
    await game.screenshot({ path: path.join(out, 'navigation-failure.png') });
    broken = false;
    await game.locator('#retry').click();
    await expect(game.locator('h1')).toHaveText('Recovered game fixture');
    expect(await game.evaluate(() => window.__ELECTRON__.core.invoke('boot_failure').then(() => false, () => true))).toBe(true);
    // Crash only this fixture's renderer, then recover through the actual UI.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('http:')).webContents.forcefullyCrashRenderer());
    await expect(game.locator('#fail')).toContainText('game window stopped unexpectedly');
    await game.screenshot({ path: path.join(out, 'renderer-failure.png') });
    await game.locator('#retry').click();
    await expect(game.locator('h1')).toHaveText('Recovered game fixture');
    expect(fs.existsSync(path.join(out, 'nebula'))).toBe(false);
    console.log('Setup cancellation, navigation failure/retry and renderer recovery passed:', out);
  } finally {
    await app.evaluate(({app}) => app.exit(0)).catch(() => {});
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
