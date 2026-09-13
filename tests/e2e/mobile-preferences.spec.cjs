const { test, expect, devices } = require("@playwright/test");
const { verifyWorld, snapshot } = require("./support.cjs");
test.use({
  ...devices["Pixel 5"],
  viewport: { width: 390, height: 844 },
  screen: { width: 390, height: 844 },
  deviceScaleFactor: 1,
});

async function login(page, phone) {
  await page.locator("#user").fill(process.env.RO_E2E_ACCOUNT || "ragnarok");
  await page.locator("#pass").fill(process.env.RO_E2E_PASSWORD || "ragnarok");
  await page.locator(".connect").tap();
  if (phone) {
    await page
      .getByRole("button", { name: "Character slot 1", exact: true })
      .tap();
    await page
      .getByRole("button", { name: "Play / create", exact: true })
      .tap();
  } else await page.locator("#slot0").dblclick();
  await expect
    .poll(async () => (await snapshot(page)).input.canMove)
    .toBe(true);
}

test("live phone: size and mode persistence, separate geometry, opt-out survives touch", async ({
  page,
}, testInfo) => {
  await verifyWorld();
  page.setDefaultTimeout(15000);
  const desktopGeometry = JSON.stringify({
    _version: 1,
    x: 205,
    y: 137,
    show: false,
  });
  await page.addInitScript((value) => {
    if (localStorage.getItem("InventoryV3") === null)
      localStorage.setItem("InventoryV3", value);
  }, desktopGeometry);
  await page.goto("/");
  await login(page, true);
  await page.getByRole("button", { name: "Menu", exact: true }).tap();
  await page.getByRole("button", { name: "Display", exact: true }).tap();
  const dialog = page.getByRole("dialog", { name: "Display settings" });
  await expect(dialog).toBeVisible();
  expect((await snapshot(page)).input.canMove).toBe(false);
  const size = dialog.getByLabel("Control size");
  await size.focus();
  await size.press("End");
  await dialog.getByRole("button", { name: "Done", exact: true }).tap();
  const attack = await page
    .getByRole("button", { name: "Attack", exact: true })
    .boundingBox();
  const shortcuts = await page
    .locator("#ragnarok-mobile .skills")
    .boundingBox();
  expect(attack.height).toBeGreaterThanOrEqual(120);
  expect(shortcuts.y + shortcuts.height).toBeLessThan(attack.y);
  await page.screenshot({ path: testInfo.outputPath("large-controls.png") });
  await page.getByRole("button", { name: "Menu", exact: true }).tap();
  await page.getByRole("button", { name: "Display", exact: true }).tap();
  await dialog.getByLabel("Phone layout").selectOption("off");
  await dialog
    .getByRole("button", { name: "Save and reload", exact: true })
    .tap();
  await page.locator("#user").waitFor();
  expect(await page.evaluate(() => localStorage.getItem("InventoryV3"))).toBe(
    desktopGeometry,
  );
  const phoneGeometry = await page.evaluate(() =>
    localStorage.getItem("ragnarok:phone:InventoryV3"),
  );
  expect(phoneGeometry).not.toBeNull();
  await login(page, false);
  await expect(
    page.getByRole("button", { name: "Attack", exact: true }),
  ).not.toBeVisible();
  // A real map touch invokes the legacy first-touch detector; Off still wins.
  await page.touchscreen.tap(195, 400);
  await expect(page.locator("#joystickBase")).not.toBeVisible();
  await page.getByRole("button", { name: "Display", exact: true }).tap();
  await expect(dialog.getByLabel("Phone layout")).toHaveValue("off");
  await expect(dialog.getByLabel("Control size")).toHaveValue("1.25");
  await dialog.getByLabel("Phone layout").selectOption("on");
  await dialog
    .getByRole("button", { name: "Save and reload", exact: true })
    .tap();
  await page.getByLabel("Account", { exact: true }).waitFor();
  expect(
    await page.evaluate(() =>
      localStorage.getItem("ragnarok:phone:InventoryV3"),
    ),
  ).toBe(phoneGeometry);
  await login(page, true);
  await expect(
    page.getByRole("button", { name: "Attack", exact: true }),
  ).toBeVisible();
  expect((await snapshot(page)).movement.registeredSources).toBe(2);
  await page.screenshot({ path: testInfo.outputPath("phone-restored.png") });
});
