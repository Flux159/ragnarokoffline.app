const { test, expect, devices } = require("@playwright/test");
const fs = require("node:fs");
const { verifyWorld, snapshot } = require("./support.cjs");

const profiles = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone390", width: 390, height: 844, touch: true },
  { name: "phone360", width: 360, height: 800, touch: true },
  { name: "landscape844", width: 844, height: 390, touch: true },
  { name: "landscape800", width: 800, height: 360, touch: true },
  { name: "tablet", width: 768, height: 1024, touch: true },
];
for (const profile of profiles)
  test(`live layout: ${profile.name}`, async ({ browser }, testInfo) => {
    const { identity } = await verifyWorld();
    const context = await browser.newContext({
      ...(profile.touch ? devices["Pixel 5"] : {}),
      viewport: { width: profile.width, height: profile.height },
      screen: { width: profile.width, height: profile.height },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const report = {
      profile,
      browser: browser.version(),
      identity,
      errors: [],
      consoleErrors: [],
      responses: [],
      sockets: [],
      screens: [],
    };
    page.on("pageerror", (error) => report.errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error")
        report.consoleErrors.push(message.text().slice(0, 700));
    });
    page.on("response", (response) => {
      if (response.status() >= 400)
        report.responses.push({
          status: response.status(),
          path: new URL(response.url()).pathname,
        });
    });
    page.on("websocket", (socket) => {
      const pathname = new URL(socket.url()).pathname;
      report.sockets.push({ event: "open", path: pathname });
      socket.on("close", () =>
        report.sockets.push({ event: "close", path: pathname }),
      );
    });
    const press = (locator) =>
      profile.touch ? locator.tap() : locator.click();
    const capture = async (name) => {
      await page.waitForTimeout(600);
      await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
      report.screens.push(name);
    };
    const fit = async (locator) => {
      const box = await locator.boundingBox();
      expect(box).toBeTruthy();
      expect(box.x).toBeGreaterThanOrEqual(-1);
      expect(box.y).toBeGreaterThanOrEqual(-1);
      expect(box.x + box.width).toBeLessThanOrEqual(profile.width + 1);
      expect(box.y + box.height).toBeLessThanOrEqual(profile.height + 1);
    };
    try {
      await page.goto("http://127.0.0.1:3338/");
      await page.locator("#user").waitFor();
      await capture("login");
      if (profile.touch) await fit(page.locator("body > [id^=WinLogin]"));
      await page
        .locator("#user")
        .fill(process.env.RO_E2E_ACCOUNT || "ragnarok");
      await page
        .locator("#pass")
        .fill(process.env.RO_E2E_PASSWORD || "ragnarok");
      await press(page.locator(".connect"));
      await page.locator("#slot0").waitFor();
      await capture("characters");
      // Inspect creation without populating additional slots on every run.
      // The disposable fixture keeps slot 3 empty; this is not a user save.
      if (profile.touch) {
        await page
          .getByRole("button", { name: "Character slot 3", exact: true })
          .tap();
        await page
          .getByRole("button", { name: "Play / create", exact: true })
          .tap();
        await page.getByLabel("Character name", { exact: true }).waitFor();
        await capture("creation");
        await fit(page.locator("body > #CharCreatev4"));
        const create = page.getByRole("button", {
          name: "Create",
          exact: true,
        });
        await create.scrollIntoViewIfNeeded();
        await fit(create);
        const size = await create.boundingBox();
        expect(size.height).toBeGreaterThanOrEqual(44);
        await page.getByRole("button", { name: "Cancel", exact: true }).tap();
        await page
          .getByRole("button", { name: "Character slot 1", exact: true })
          .tap();
        await page
          .getByRole("button", { name: "Play / create", exact: true })
          .tap();
      } else await page.locator("#slot0").dblclick();
      await expect.poll(async () => (await snapshot(page)).map).toBeTruthy();
      await context.tracing.start({ screenshots: true, snapshots: true });
      await capture("map");
      report.state = await snapshot(page);
      if (profile.touch) {
        for (const name of ["Attack", "Talk", "Pick up", "Menu"]) {
          const button = page.getByRole("button", { name, exact: true });
          await fit(button);
          const box = await button.boundingBox();
          expect(box.height).toBeGreaterThanOrEqual(44);
          expect(box.width).toBeGreaterThanOrEqual(44);
        }
        await page.getByRole("button", { name: "Menu", exact: true }).tap();
        await page
          .getByRole("button", { name: "Inventory", exact: true })
          .tap();
        await capture("inventory");
        await fit(page.locator("body > #InventoryV3"));
        await page.locator("#InventoryV3 .close").tap();
      } else
        await expect(
          page.getByRole("button", { name: "Attack", exact: true }),
        ).not.toBeVisible();
      await context.tracing.stop({
        path: testInfo.outputPath("layout-trace.zip"),
      });
      expect(report.errors).toEqual([]);
    } finally {
      fs.writeFileSync(
        testInfo.outputPath("report.json"),
        JSON.stringify(report, null, 2),
      );
      await context.close();
    }
  });
