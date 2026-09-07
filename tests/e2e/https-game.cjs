// Native RO login/character/map over HTTPS + WSS through a loopback-only TLS
// terminator. The actual Rust proxy and real rAthena world stay unchanged.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), https = require('node:https'), crypto = require('node:crypto');
const { chromium, devices, expect } = require('@playwright/test');
const { verifyWorld, snapshot } = require('./support.cjs');
const { login } = require('./phone.cjs');
const work = path.resolve(__dirname, '../..');
const tls = path.join(work, 'tests/fixtures/tls');
const cert = fs.readFileSync(path.join(tls, 'localhost-cert.pem'));
const key = fs.readFileSync(path.join(tls, 'localhost-key.pem'));
const spki = crypto.createHash('sha256').update(new crypto.X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
let testPassword = '';
async function main() {
  const { world, identity } = await verifyWorld();
  const out = path.join(world, 'account-tests', 'https-game-' + Date.now());
  fs.mkdirSync(out, { recursive: true });
  const credentials = JSON.parse(fs.readFileSync(path.join(world, 'account-test-credentials.json')));
  testPassword = credentials.password;
  process.env.RO_E2E_ACCOUNT = credentials.account; process.env.RO_E2E_PASSWORD = credentials.password;
  const report = { identity, checks: [], tlsTrust: 'Exact public localhost fixture SPKI exception in Chromium; external trusted-CA/provider acceptance remains separate.' };
  const peers = new Set();
  const proxy = https.createServer({ key, cert }, (request, response) => {
    const upstream = http.request({ host: '127.0.0.1', port: 3338, path: request.url,
      method: request.method, headers: request.headers }, incoming => {
      response.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(response);
    });
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    request.pipe(upstream); response.on('close', () => upstream.destroy());
  });
  proxy.on('connection', socket => { peers.add(socket); socket.once('close', () => peers.delete(socket)); });
  proxy.on('upgrade', (request, socket, head) => {
    const upstream = http.request({ host: '127.0.0.1', port: 3338, path: request.url, headers: request.headers });
    upstream.on('upgrade', (response, remote, remoteHead) => {
      peers.add(remote); remote.once('close', () => peers.delete(remote));
      socket.write('HTTP/1.1 101 Switching Protocols\r\n' + response.rawHeaders.reduce((lines, value, index, all) => index % 2 ? lines : lines + value + ': ' + all[index + 1] + '\r\n', '') + '\r\n');
      if (remoteHead.length) socket.write(remoteHead);
      if (head.length) remote.write(head);
      remote.on('error', () => socket.destroy()); socket.on('error', () => remote.destroy());
      remote.on('close', () => socket.destroy()); socket.on('close', () => remote.destroy());
      remote.pipe(socket); socket.pipe(remote);
    });
    upstream.on('response', response => { response.resume(); socket.destroy(); });
    upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy());
    upstream.end();
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const secureOrigin = 'https://localhost:' + proxy.address().port;
  const browser = await chromium.launch({ headless: true, args: ['--ignore-certificate-errors-spki-list=' + spki] });
  report.browser = browser.version();
  try {
    for (const origin of ['http://127.0.0.1:3338', secureOrigin]) {
      const context = await browser.newContext({ ...devices['Pixel 5'], baseURL: origin });
      const page = await context.newPage(); page.setDefaultTimeout(60000);
      const check = { origin, sockets: [], insecureRequests: [], pageErrors: [], failedResponses: [] };
      page.on('websocket', socket => check.sockets.push(socket.url()));
      page.on('request', request => { if (origin.startsWith('https:') && request.url().startsWith('http:')) check.insecureRequests.push(request.url()); });
      page.on('pageerror', error => check.pageErrors.push(error.message));
      page.on('response', response => { if (response.status() >= 400) check.failedResponses.push({ status: response.status(), path: new URL(response.url()).pathname }); });
      try {
        await page.goto(origin + '/#invite=public-loopback-test-invite');
        await expect(page).toHaveURL(origin + '/api.html?app=ONLINE#invite=public-loopback-test-invite');
        await login(page);
        const before = await snapshot(page);
        await page.keyboard.down('KeyW'); await page.waitForTimeout(400); await page.keyboard.up('KeyW');
        await expect.poll(async () => (await snapshot(page)).serverMovement.acknowledgements).toBeGreaterThan(before.serverMovement.acknowledgements);
        const current = await snapshot(page);
        expect(check.pageErrors).toEqual([]); expect(check.insecureRequests).toEqual([]);
        const ports = new Set(check.sockets.map(value => {
          const url = new URL(value);
          expect(url.protocol).toBe(origin.startsWith('https:') ? 'wss:' : 'ws:');
          expect(url.host).toBe(new URL(origin).host);
          expect(url.pathname).toMatch(/^\/ws\/127\.0\.0\.1:(6900|6121|5121)$/);
          return Number(url.pathname.split(':').pop());
        }));
        expect([...ports].sort()).toEqual([5121, 6121, 6900]);
        check.map = current.map; check.player = current.player; check.movementAcknowledged = true;
        await page.screenshot({ path: path.join(out, origin.startsWith('https:') ? 'https-map.png' : 'http-map.png') });
        console.log('Native login/character/map and movement passed:', new URL(origin).protocol);
      } finally { report.checks.push(check); await context.close(); }
    }
    console.log('Real HTTP/HTTPS game passed. Evidence:', out);
  } finally {
    await browser.close();
    for (const socket of peers) socket.destroy();
    await new Promise(resolve => proxy.close(resolve));
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    delete process.env.RO_E2E_PASSWORD;
  }
}
main().catch(error => {
  let message = String(error.message);
  if (testPassword) message = message.split(testPassword).join('[redacted]');
  console.error(message); process.exitCode = 1;
});
