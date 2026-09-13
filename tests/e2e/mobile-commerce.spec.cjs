const { test, expect, devices } = require("@playwright/test");
const fs = require("node:fs");
const { verifyWorld, snapshot } = require("./support.cjs");

test.use({ ...devices["Pixel 5"], deviceScaleFactor: 1, actionTimeout: 10000 });

const {
  login,
  menu,
  command,
  inventory,
  closeInventory,
  inventoryCounts: items,
} = require("./phone.cjs");

const zeny = async (page) =>
  Number(
    (await page.locator(".zeny_value").first().textContent()).replace(
      /[^0-9]/g,
      "",
    ),
  );
const storedCount = async (page) => {
  const potion = page
    .locator("#Storage .content .item")
    .filter({ hasText: "Red Potion" });
  return (await potion.count())
    ? Number(await potion.locator(".count").textContent())
    : 0;
};

for (const [name, viewport] of [
  ["portrait", { width: 390, height: 844 }],
  ["landscape", { width: 800, height: 360 }],
]) {
  test.describe(name, () => {
    test.use({ viewport, screen: viewport });
    test("live phone: storage conservation, quantity rejection and NPC buy/sell", async ({
      page,
      context,
    }, testInfo) => {
      const { identity } = await verifyWorld();
      const errors = [],
        evidence = {};
      page.on("pageerror", (error) => errors.push(error.message));
      await login(page);
      await context.tracing.start({ screenshots: true, snapshots: true });
      try {
        // The marker/ownership check above is required before these real
        // GM fixture commands. Never assign player state or mock packets.
        await inventory(page);
        const before = await items(page);
        await closeInventory(page);
        await command(page, "@item 501 10");
        await inventory(page);
        let potionIndex;
        await expect
          .poll(async () => {
            const after = await items(page);
            const changed = Object.keys(after).filter(
              (index) => after[index] === (before[index] || 0) + 10,
            );
            if (changed.length === 1) potionIndex = changed[0];
            return changed.length;
          })
          .toBe(1);
        const count = async () => (await items(page))[potionIndex] || 0;
        const initial = await count();
        await closeInventory(page);
        await command(page, "@storage");
        await expect(
          page.getByRole("button", { name: "Open inventory", exact: true }),
        ).toBeVisible();
        const stored = await storedCount(page);
        await page
          .getByRole("button", { name: "Open inventory", exact: true })
          .tap();
        const potion = page.locator(
          `#InventoryV3 .content .item[data-index="${potionIndex}"]`,
        );
        await potion.tap();
        await page
          .getByLabel("Deposit quantity", { exact: true })
          .fill(String(initial + 1));
        await page.getByRole("button", { name: "Deposit", exact: true }).tap();
        await expect(
          page.locator("#InventoryV3 .ro-storage-controls output"),
        ).toContainText("Choose an available quantity");
        expect(await count()).toBe(initial);
        expect(await storedCount(page)).toBe(stored);
        await page.getByLabel("Deposit quantity", { exact: true }).fill("2");
        await page.getByRole("button", { name: "Deposit", exact: true }).tap();
        await expect.poll(count).toBe(initial - 2);
        await expect.poll(() => storedCount(page)).toBe(stored + 2);
        await page.screenshot({
          path: testInfo.outputPath("inventory-deposit.png"),
        });
        await page
          .getByRole("button", { name: "Back to storage", exact: true })
          .tap();
        await page
          .locator("#Storage .content .item")
          .filter({ hasText: "Red Potion" })
          .tap();
        await page.getByLabel("Withdraw quantity", { exact: true }).fill("2");
        await page.getByRole("button", { name: "Withdraw", exact: true }).tap();
        await expect.poll(() => storedCount(page)).toBe(stored);
        await expect.poll(count).toBe(initial);
        await page.screenshot({
          path: testInfo.outputPath("storage-withdraw.png"),
        });
        await page
          .getByRole("button", { name: "Open inventory", exact: true })
          .tap();
        await potion.tap();
        await page
          .getByRole("button", { name: "Deposit all", exact: true })
          .tap();
        await expect.poll(count).toBe(0);
        await expect.poll(() => storedCount(page)).toBe(stored + initial);
        await page
          .getByRole("button", { name: "Back to storage", exact: true })
          .tap();
        await page
          .locator("#Storage .content .item")
          .filter({ hasText: "Red Potion" })
          .tap();
        await page
          .getByRole("button", { name: "Withdraw all", exact: true })
          .tap();
        await expect.poll(() => storedCount(page)).toBe(0);
        // The server may reuse a different inventory slot after a whole stack
        // was removed. Identify the returned stack through its acknowledged count.
        await expect
          .poll(async () => {
            const rows = await items(page);
            const matching = Object.keys(rows).filter(
              (index) => rows[index] === initial + stored,
            );
            if (matching.length === 1) potionIndex = matching[0];
            return matching.length;
          })
          .toBe(1);
        if (stored > 0) {
          await page
            .getByRole("button", { name: "Open inventory", exact: true })
            .tap();
          await page
            .locator(`#InventoryV3 .content .item[data-index="${potionIndex}"]`)
            .tap();
          await page
            .getByLabel("Deposit quantity", { exact: true })
            .fill(String(stored));
          await page
            .getByRole("button", { name: "Deposit", exact: true })
            .tap();
          await expect.poll(count).toBe(initial);
          await expect.poll(() => storedCount(page)).toBe(stored);
          await page
            .getByRole("button", { name: "Back to storage", exact: true })
            .tap();
        }
        await page
          .getByRole("button", { name: "Close storage", exact: true })
          .tap();
        await expect(
          page.getByLabel("Deposit quantity", { exact: true }),
        ).toBeHidden();
        await closeInventory(page);
        evidence.storage = {
          initial,
          stored,
          deposited: 2,
          withdrawn: 2,
          wholeStackDeposit: initial,
          wholeStackWithdraw: initial + stored,
          restoredStorage: stored,
          final: initial,
        };

        await expect(page.locator("#NpcStore")).toHaveCount(0);
        const originalZeny = await zeny(page);
        await command(page, "@zeny 10000");
        await expect.poll(() => zeny(page)).toBe(originalZeny + 10000);
        await command(page, "@warp prt_in 126 74");
        await expect
          .poll(async () => (await snapshot(page)).map)
          .toBe("prt_in.gat");
        await expect
          .poll(async () =>
            Math.round((await snapshot(page)).player.position[1]),
          )
          .toBe(74);
        // This is the pinned renewal tool dealer at prt_in (126,76).
        await page.getByRole("button", { name: "Talk", exact: true }).tap();
        await page.getByRole("button", { name: "Buy", exact: true }).tap();
        const store = page.locator("#NpcStore");
        const shopPotion = store
          .locator(".InputWindow .item")
          .filter({ hasText: "Red Potion" });
        await shopPotion.tap();
        const price = Number(
          (await shopPotion.locator(".price").textContent()).replace(
            /[^0-9]/g,
            "",
          ),
        );
        const beforeBuy = await zeny(page);
        await page
          .getByRole("button", { name: "Add selected", exact: true })
          .tap();
        await expect(page.getByLabel("Value", { exact: true })).toHaveAttribute(
          "inputmode",
          "numeric",
        );
        expect((await snapshot(page)).input.canMove).toBe(false);
        await page.screenshot({
          path: testInfo.outputPath("shop-quantity.png"),
        });
        await page.getByLabel("Value", { exact: true }).fill("2");
        await page
          .locator("#InputBox")
          .getByRole("button", { name: "OK", exact: true })
          .tap();
        await expect(store.locator(".OutputWindow .item")).toContainText(
          "Red Potion",
        );
        await page.screenshot({ path: testInfo.outputPath("shop-cart.png") });
        await page.getByRole("button", { name: "Buy", exact: true }).tap();
        await expect(store).toHaveCount(0);
        await expect.poll(() => zeny(page)).toBe(beforeBuy - price * 2);
        await inventory(page);
        await expect.poll(count).toBe(initial + 2);
        await closeInventory(page);

        await page.getByRole("button", { name: "Talk", exact: true }).tap();
        await page.getByRole("button", { name: "Sell", exact: true }).tap();
        const sellPotion = store
          .locator(".InputWindow .item")
          .filter({ hasText: "Red Potion" });
        await sellPotion.tap();
        const sellPrice = Number(
          (await sellPotion.locator(".price").textContent()).replace(
            /[^0-9]/g,
            "",
          ),
        );
        const beforeSell = await zeny(page);
        await page
          .getByRole("button", { name: "Add selected", exact: true })
          .tap();
        await page.getByLabel("Value", { exact: true }).fill("1");
        await page
          .locator("#InputBox")
          .getByRole("button", { name: "OK", exact: true })
          .tap();
        await page.getByRole("button", { name: "Sell", exact: true }).tap();
        await expect(store).toHaveCount(0);
        await expect.poll(() => zeny(page)).toBe(beforeSell + sellPrice);
        await inventory(page);
        await expect.poll(count).toBe(initial + 1);
        await page.screenshot({
          path: testInfo.outputPath("inventory-after-buy-sell.png"),
        });
        evidence.shop = {
          price,
          beforeBuy,
          purchased: 2,
          sellPrice,
          sold: 1,
          finalCount: await count(),
          finalZeny: await zeny(page),
        };
        const preferences = await page.evaluate(() => ({
          desktop: localStorage.getItem("NpcStore"),
          phone: localStorage.getItem("ragnarok:phone:NpcStore"),
        }));
        expect(preferences.desktop).toBe(null);
        expect(preferences.phone).not.toBe(null);
        evidence.shop.preferences = preferences;
        await closeInventory(page);
        // Successful runs restore the fixture's item and money changes so
        // repeating the suite cannot eventually overload the character.
        await command(page, "@delitem 501 11");
        await inventory(page);
        await expect.poll(count).toBe(initial - 10);
        await closeInventory(page);
        await command(page, `@zeny ${originalZeny - (await zeny(page))}`);
        await expect.poll(() => zeny(page)).toBe(originalZeny);
        evidence.restored = { items: initial - 10, zeny: originalZeny, stored };
        await command(page, "@warp prontera 150 180");
        await expect
          .poll(async () => (await snapshot(page)).map)
          .toBe("prontera.gat");
        expect(errors).toEqual([]);
      } finally {
        await page
          .screenshot({ path: testInfo.outputPath("final-state.png") })
          .catch(() => {});
        fs.writeFileSync(
          testInfo.outputPath("report.json"),
          JSON.stringify({ identity, evidence, errors }, null, 2),
        );
        await context.tracing.stop({
          path: testInfo.outputPath("commerce-trace.zip"),
        });
      }
    });
  });
}
