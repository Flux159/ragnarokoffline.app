const { test, expect, devices } = require("@playwright/test");
const fs = require("node:fs");
const { verifyWorld, snapshot } = require("./support.cjs");
const {
  login,
  command,
  inventory,
  closeInventory,
  inventoryCounts,
} = require("./phone.cjs");

test.use({
  ...devices["Pixel 5"],
  viewport: { width: 390, height: 844 },
  screen: { width: 390, height: 844 },
  deviceScaleFactor: 1,
  actionTimeout: 10000,
});
const messages = async (page) =>
  (await page.locator("#ChatBox .content").allTextContents()).join("\n");
const occurrences = (text, pattern) => (text.match(pattern) || []).length;

test("live phone: item healing, shortcut use, one-tap distant pickup and combat", async ({
  page,
  context,
  browser,
}, testInfo) => {
  const { identity } = await verifyWorld();
  const errors = [],
    consoleErrors = [],
    failedResponses = [],
    sockets = [],
    evidence = {};
  const redact = (value) => {
    const password = process.env.RO_E2E_PASSWORD || "ragnarok";
    return value.split(password).join("[redacted]").slice(0, 1000);
  };
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(redact(message.text()));
  });
  page.on("response", (response) => {
    if (response.status() >= 400)
      failedResponses.push({
        status: response.status(),
        path: new URL(response.url()).pathname,
      });
  });
  page.on("websocket", (socket) => {
    const path = new URL(socket.url()).pathname;
    sockets.push({ event: "open", path });
    socket.on("close", () => sockets.push({ event: "close", path }));
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await login(page);
  await context.tracing.start({ screenshots: true, snapshots: true });
  let cdp;
  try {
    await command(page, "@warp prontera 150 190");
    await command(page, "@cleanmap"); // Remove only old floor loot in this verified disposable town.
    await command(page, "@heal");
    const maxHp = (await snapshot(page)).player.maxHp;
    await inventory(page);
    const before = await inventoryCounts(page);
    await closeInventory(page);
    await command(page, "@item 501 5");
    await inventory(page);
    let index;
    await expect
      .poll(async () => {
        const after = await inventoryCounts(page);
        const matching = Object.keys(after).filter(
          (key) => after[key] === (before[key] || 0) + 5,
        );
        if (matching.length === 1) index = matching[0];
        return matching.length;
      })
      .toBe(1);
    const initial = (await inventoryCounts(page))[index];
    const count = async () => (await inventoryCounts(page))[index] || 0;
    await closeInventory(page);
    await command(page, "@heal -25");
    await expect
      .poll(async () => (await snapshot(page)).player.hp)
      .toBeLessThan(maxHp - 10);
    const hurt = (await snapshot(page)).player.hp;
    await inventory(page);
    await page
      .locator(`#InventoryV3 .content .item[data-index="${index}"]`)
      .tap();
    await page.getByRole("button", { name: "Use / equip", exact: true }).tap();
    await expect.poll(count).toBe(initial - 1);
    await expect
      .poll(async () => (await snapshot(page)).player.hp)
      .toBeGreaterThan(hurt);
    const healed = (await snapshot(page)).player.hp;
    await page.getByRole("button", { name: "Set F2", exact: true }).tap();
    await expect(
      page.getByRole("button", { name: /Use.*F2.*Red Potion/ }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("item-use-and-shortcut.png"),
    });
    await closeInventory(page);
    await command(page, "@heal -25");
    await expect
      .poll(async () => (await snapshot(page)).player.hp)
      .toBeLessThan(maxHp - 10);
    const hurtAgain = (await snapshot(page)).player.hp;
    await page.getByRole("button", { name: /Use.*F2.*Red Potion/ }).tap();
    await expect.poll(count).toBe(initial - 2);
    await expect
      .poll(async () => (await snapshot(page)).player.hp)
      .toBeGreaterThan(hurtAgain);
    evidence.items = {
      initial,
      hurt,
      healed,
      hurtAgain,
      shortcutHp: (await snapshot(page)).player.hp,
      afterUse: await count(),
    };

    // Seed a real floor stack, then use actual joystick touch to leave pickup
    // range. One tap must both approach and collect, via native walk-end.
    const droppedAt = (await snapshot(page)).player.position;
    await command(page, "@dropall 0");
    await expect.poll(count).toBe(0);
    cdp = await context.newCDPSession(page);
    const base = await page.locator("#joystickBase").boundingBox();
    const start = {
      id: 1,
      x: base.x + base.width / 2,
      y: base.y + base.height / 2,
      radiusX: 4,
      radiusY: 4,
      force: 1,
    };
    try {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [start],
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ ...start, y: start.y + 35 }],
      });
      await expect
        .poll(async () =>
          Math.max(
            ...(await snapshot(page)).player.position.map((v, i) =>
              Math.abs(v - droppedAt[i]),
            ),
          ),
        )
        .toBeGreaterThanOrEqual(6);
    } finally {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
    }
    await page.waitForTimeout(1100); // Let the already accepted short destination finish.
    const away = await snapshot(page);
    await page.getByRole("button", { name: "Pick up", exact: true }).tap();
    // A deliberate new joystick direction must cancel the pending pickup,
    // just as native click-to-move cancels an earlier queued action.
    try {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [start],
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ ...start, x: start.x + 35 }],
      });
      await expect
        .poll(async () => (await snapshot(page)).movement.requests)
        .toBeGreaterThan(away.movement.requests);
    } finally {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
    }
    await page.waitForTimeout(1800);
    expect(await count()).toBe(0);
    const cancelled = await snapshot(page);
    await page.getByRole("button", { name: "Pick up", exact: true }).tap();
    await expect
      .poll(async () => {
        const rows = await inventoryCounts(page);
        const returned = Object.keys(rows).filter(
          (key) => rows[key] === initial - 2,
        );
        if (returned.length === 1) index = returned[0];
        return returned.length;
      })
      .toBe(1);
    const collected = await snapshot(page);
    expect(collected.serverMovement.acknowledgements).toBeGreaterThan(
      away.serverMovement.acknowledgements,
    );
    evidence.pickup = {
      droppedAt,
      away,
      cancelled,
      collected,
      restoredCount: await count(),
    };
    await page.screenshot({ path: testInfo.outputPath("distant-pickup.png") });

    const oldMessages = await messages(page);
    await command(page, "@monster 1002 1");
    await expect.poll(() => messages(page)).toContain("All monsters summoned!");
    await page.getByRole("button", { name: "Attack", exact: true }).tap();
    await expect
      .poll(async () => (await snapshot(page)).target?.name)
      .toBe("Poring");
    const target = (await snapshot(page)).target;
    await page.screenshot({ path: testInfo.outputPath("poring-target.png") });
    // These native battle messages are generated by received server action
    // and experience packets. A delivered click or unknown monster HP=-1
    // cannot, on its own, prove that an attack or kill happened.
    await expect
      .poll(
        async () => occurrences(await messages(page), /\[Poring\] receives/g),
        { timeout: 30000 },
      )
      .toBeGreaterThan(occurrences(oldMessages, /\[Poring\] receives/g));
    await expect
      .poll(async () => occurrences(await messages(page), /Base exp points/g), {
        timeout: 30000,
      })
      .toBeGreaterThan(occurrences(oldMessages, /Base exp points/g));
    await expect.poll(async () => (await snapshot(page)).target).toBe(null);
    evidence.combat = {
      target,
      after: await snapshot(page),
      messages: await messages(page),
    };
    await page.screenshot({ path: testInfo.outputPath("after-combat.png") });
    await command(page, "@delitem 501 3");
    await expect.poll(count).toBe(initial - 5);
    await command(page, "@heal");
    await command(page, "@warp prontera 150 180");
    expect(errors).toEqual([]);
  } finally {
    await cdp
      ?.send("Input.dispatchTouchEvent", {
        type: "touchCancel",
        touchPoints: [],
      })
      .catch(() => {});
    await page
      .screenshot({ path: testInfo.outputPath("final-state.png") })
      .catch(() => {});
    fs.writeFileSync(
      testInfo.outputPath("report.json"),
      JSON.stringify(
        {
          identity,
          browser: browser.version(),
          viewport: page.viewportSize(),
          evidence,
          errors,
          consoleErrors,
          failedResponses,
          sockets,
        },
        null,
        2,
      ),
    );
    await context.tracing.stop({
      path: testInfo.outputPath("actions-trace.zip"),
    });
  }
});
