const { test, expect, devices } = require("@playwright/test");
const fs = require("node:fs");
const { verifyWorld, snapshot } = require("./support.cjs");

test.use({
  ...devices["Pixel 5"],
  viewport: { width: 390, height: 844 },
  screen: { width: 390, height: 844 },
  deviceScaleFactor: 1,
});

async function login(page) {
  await page.goto("/");
  await page
    .getByLabel("Account", { exact: true })
    .fill(process.env.RO_E2E_ACCOUNT || "ragnarok");
  await page
    .getByLabel("Password", { exact: true })
    .fill(process.env.RO_E2E_PASSWORD || "ragnarok");
  await page.getByRole("button", { name: "Log in", exact: true }).tap();
  await page
    .getByRole("button", { name: "Character slot 1", exact: true })
    .tap();
  await page.getByRole("button", { name: "Play / create", exact: true }).tap();
  await expect
    .poll(async () => (await snapshot(page)).input.canMove)
    .toBe(true);
}
async function command(page, text) {
  await page.getByRole("button", { name: "Menu", exact: true }).tap();
  await page.getByRole("button", { name: "Chat", exact: true }).tap();
  await page.getByLabel("Chat message", { exact: true }).fill(text);
  await page.keyboard.press("Enter");
}

test("live phone: two independent thumbs, both release orders, cancellation and native action delivery", async ({
  page,
  context,
}, testInfo) => {
  const { identity } = await verifyWorld();
  const errors = [],
    samples = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await login(page);
  // Real GM command in a marker- and identity-verified disposable world only.
  // An open town path makes server movement assertions repeatable.
  await command(page, "@warp prontera 150 180");
  await expect
    .poll(async () => (await snapshot(page)).map)
    .toBe("prontera.gat");
  await expect
    .poll(async () => Math.round((await snapshot(page)).player.position[1]))
    .toBe(180);
  const closeChat = page.getByRole("button", {
    name: "Close chat",
    exact: true,
  });
  if (await closeChat.isVisible()) await closeChat.tap();
  await expect
    .poll(async () => (await snapshot(page)).input.canMove)
    .toBe(true);
  await context.tracing.start({ screenshots: true, snapshots: true });
  await page.evaluate(() => {
    window.touchEvidence = [];
    for (const type of ["pointerdown", "pointerup", "pointercancel", "click"]) {
      document.addEventListener(
        type,
        (event) =>
          window.touchEvidence.push({
            type,
            id: event.pointerId,
            target: event.composedPath()[0]?.id,
            trusted: event.isTrusted,
          }),
        true,
      );
    }
  });
  const cdp = await context.newCDPSession(page);
  const touch = (type, touchPoints) =>
    cdp.send("Input.dispatchTouchEvent", { type, touchPoints });
  const base = await page.locator("#joystickBase").boundingBox();
  const attack = await page
    .getByRole("button", { name: "Attack", exact: true })
    .boundingBox();
  const center = {
    id: 1,
    x: base.x + base.width / 2,
    y: base.y + base.height / 2,
    radiusX: 4,
    radiusY: 4,
    force: 1,
  };
  const second = {
    id: 2,
    x: attack.x + attack.width / 2,
    y: attack.y + attack.height / 2,
    radiusX: 4,
    radiusY: 4,
    force: 1,
  };
  const first = { ...center, y: center.y + 35 };
  const record = async (name) => {
    const state = await snapshot(page);
    samples.push({ name, state });
    return state;
  };
  const initial = await record("initial");
  const attackCount = () =>
    page.evaluate(
      () =>
        window.touchEvidence.filter(
          (event) => event.type === "click" && event.target === "attackButton",
        ).length,
    );
  try {
    await touch("touchStart", [center]);
    await touch("touchMove", [first]);
    await expect
      .poll(async () => (await snapshot(page)).serverMovement.acknowledgements)
      .toBeGreaterThan(initial.serverMovement.acknowledgements);
    await touch("touchStart", [first, second]);
    await touch("touchEnd", [second]); // This Chromium ends the specified pointer, preserving the other.
    await expect.poll(attackCount).toBe(1);
    const attackReleased = await record("attack-released");
    expect(attackReleased.movement.source).toBe("engine:touch:joystick");
    expect(attackReleased.camera.direction).toBe(initial.camera.direction);
    await page.waitForTimeout(250);
    expect((await snapshot(page)).movement.requests).toBeGreaterThan(
      attackReleased.movement.requests,
    );
    await touch("touchEnd", []);
    const released = await record("joystick-released");
    await page.waitForTimeout(700);
    expect((await snapshot(page)).movement.requests).toBe(
      released.movement.requests,
    );
    expect((await snapshot(page)).movement.source).toBe(null);

    // Release the joystick first. The held action thumb cannot resume it.
    await touch("touchStart", [center]);
    await touch("touchMove", [first]);
    await touch("touchStart", [first, second]);
    await touch("touchEnd", [first]);
    const firstReleased = await record("joystick-released-first");
    expect(firstReleased.movement.source).toBe(null);
    await touch("touchEnd", []);
    await expect.poll(attackCount).toBe(2);
    await page.waitForTimeout(300);
    expect((await snapshot(page)).movement.requests).toBe(
      firstReleased.movement.requests,
    );

    await touch("touchStart", [center]);
    await touch("touchMove", [first]);
    await touch("touchCancel", []);
    const cancelled = await record("cancelled");
    expect(cancelled.movement.source).toBe(null);
    await page.waitForTimeout(300);
    expect((await snapshot(page)).movement.requests).toBe(
      cancelled.movement.requests,
    );
    expect((await snapshot(page)).camera.direction).toBe(
      initial.camera.direction,
    );
    // A single primary tap must not invoke both pointer and compatibility paths.
    await page.getByRole("button", { name: "Attack", exact: true }).tap();
    expect(await attackCount()).toBe(3);
    const events = await page.evaluate(() => window.touchEvidence);
    expect(
      events.filter((event) => event.type === "pointerdown" && event.trusted)
        .length,
    ).toBeGreaterThanOrEqual(6);
    expect(errors).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath("two-thumbs-map.png") });
    fs.writeFileSync(
      testInfo.outputPath("report.json"),
      JSON.stringify({ identity, samples, events, errors }, null, 2),
    );
  } finally {
    await touch("touchCancel", []).catch(() => {});
    await context.tracing.stop({
      path: testInfo.outputPath("two-thumbs-trace.zip"),
    });
  }
});
