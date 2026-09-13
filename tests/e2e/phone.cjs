const { expect } = require("@playwright/test");
const { snapshot } = require("./support.cjs");

async function login(page, { movementTimeout = 60000 } = {}) {
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
    .poll(async () => (await snapshot(page)).input.canMove, {
      timeout: movementTimeout,
    })
    .toBe(true);
}
async function menu(page, name) {
  await page.getByRole("button", { name: "Menu", exact: true }).tap();
  await page.getByRole("button", { name, exact: true }).tap();
}
async function command(page, value) {
  await menu(page, "Chat");
  await page.getByLabel("Chat message", { exact: true }).fill(value);
  await page.keyboard.press("Enter");
  const close = page.getByRole("button", { name: "Close chat", exact: true });
  if (value.startsWith("@warp ")) {
    // Map transitions rebuild ChatBox and hide the phone chat. Wait for that
    // lifecycle change before touching controls on the destination map.
    await expect(close).toBeHidden();
    await expect
      .poll(async () => (await snapshot(page)).input.canMove)
      .toBe(true);
  } else await close.tap();
}
async function inventory(page) {
  await menu(page, "Inventory");
  await page
    .locator("#InventoryV3 .tabs .tab")
    .filter({ hasText: /^Use$/ })
    .tap();
}
const closeInventory = (page) =>
  page
    .locator("#InventoryV3")
    .getByRole("button", { name: "Close", exact: true })
    .tap();
const inventoryCounts = (page) =>
  page
    .locator("#InventoryV3 .content .item")
    .evaluateAll((elements) =>
      Object.fromEntries(
        elements.map((item) => [
          item.dataset.index,
          Number(item.querySelector(".count").textContent),
        ]),
      ),
    );

module.exports = {
  login,
  menu,
  command,
  inventory,
  closeInventory,
  inventoryCounts,
};
