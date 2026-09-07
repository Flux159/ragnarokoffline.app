const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const { verifyWorld, snapshot } = require('./support.cjs');

async function login(page) {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.locator('#user').fill(process.env.RO_E2E_ACCOUNT || 'ragnarok');
    await page.locator('#pass').fill(process.env.RO_E2E_PASSWORD || 'ragnarok');
    await page.locator('.connect').click();
    await page.locator('#slot0').dblclick();
    await expect.poll(async () => (await snapshot(page)).map).toBeTruthy();
    await expect.poll(async () => (await snapshot(page)).input.canMove).toBe(true);
}

test('live game: movement acknowledgements, release, chat, Controls and teardown across reload', async ({ page, context, browser }, testInfo) => {
    const { identity } = await verifyWorld();
    const errors = [], consoleErrors = [], responses = [], sockets = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 1000)); });
    page.on('response', response => { if (response.status() >= 400) responses.push({ status: response.status(), path: new URL(response.url()).pathname }); });
    page.on('websocket', socket => {
        // Lifecycle only. Never persist RO authentication packet frames.
        sockets.push({ event: 'open', path: new URL(socket.url()).pathname });
        socket.on('close', () => sockets.push({ event: 'close', path: new URL(socket.url()).pathname }));
    });
    await login(page);
    await context.tracing.start({ screenshots: true, snapshots: true });
    const initial = await snapshot(page);
    await page.screenshot({ path: testInfo.outputPath('map-before.png') });
    const samples = [];
    for (const key of ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'ArrowUp', 'ArrowDown']) {
        await page.keyboard.down(key);
        await page.waitForTimeout(450);
        await page.keyboard.up(key);
        const release = await snapshot(page);
        await page.waitForTimeout(700);
        const stopped = await snapshot(page);
        expect(stopped.movement.source).toBe(null);
        expect(stopped.movement.requests).toBe(release.movement.requests);
        samples.push({ key, release, stopped });
    }
    const moved = await snapshot(page);
    expect(moved.movement.requests).toBeGreaterThan(initial.movement.requests);
    expect(moved.serverMovement.acknowledgements).toBeGreaterThan(initial.serverMovement.acknowledgements);
    expect(samples.some(sample => JSON.stringify(sample.stopped.player.position) !== JSON.stringify(initial.player.position))).toBe(true);

    // Native chat focus must preserve typing, including W/A/S/D.
    await page.keyboard.press('Enter');
    const chat = page.locator('.input-chatbox');
    await expect(chat).toBeVisible(); await chat.focus();
    const chatStart = await snapshot(page);
    await page.keyboard.type('wasd'); await page.waitForTimeout(300);
    expect((await snapshot(page)).movement.requests).toBe(chatStart.movement.requests);
    await chat.fill(''); await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Controls', exact: true }).click();
    const controls = page.getByRole('dialog', { name: 'Movement controls' });
    await expect(controls).toBeVisible();
    await controls.getByLabel('Keyboard movement', { exact: true }).uncheck();
    await page.screenshot({ path: testInfo.outputPath('controls.png') });
    await controls.getByRole('button', { name: 'Done', exact: true }).click();
    const disabled = await snapshot(page);
    await page.keyboard.down('KeyW'); await page.waitForTimeout(350); await page.keyboard.up('KeyW');
    expect((await snapshot(page)).movement.requests).toBe(disabled.movement.requests);
    await context.tracing.stop({ path: testInfo.outputPath('movement-trace.zip') });
    await page.reload({ waitUntil: 'domcontentloaded' });
    // The reload itself reconnects through the real login UI; no second host.
    await login(page);
    await page.getByRole('button', { name: 'Controls', exact: true }).click();
    await expect(page.getByLabel('Keyboard movement', { exact: true })).not.toBeChecked();
    await page.getByRole('button', { name: 'Restore defaults' }).click();
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    expect((await snapshot(page)).movement.registeredSources).toBe(initial.movement.registeredSources);
    await page.screenshot({ path: testInfo.outputPath('map-after.png') });
    const report = { browser: browser.version(), packetVersion: moved.packetVersion, map: initial.map,
        executableDigest: identity.executableDigest, configFingerprint: identity.configFingerprint,
        initial, samples, moved, pageErrors: errors, consoleErrors, failedResponses: responses, sockets };
    fs.writeFileSync(testInfo.outputPath('report.json'), JSON.stringify(report, null, 2));
    expect(errors).toEqual([]);
});
