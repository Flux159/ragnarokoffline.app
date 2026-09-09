// Opt-in real Electron/roBrowser account integration. Never targets a user save.
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const work = path.resolve(__dirname, "../..");
if (!process.env.RO_E2E_WORLD)
  throw Error("Set RO_E2E_WORLD to an already running disposable test world");
const world = fs.realpathSync(process.env.RO_E2E_WORLD);
const { _electron, chromium, devices, expect } = require("@playwright/test");
const { verifyWorld } = require("./support.cjs");
const { login } = require("./phone.cjs");
if (
  JSON.parse(fs.readFileSync(path.join(world, ".ragnarok-e2e.json")))
    .disposable !== true ||
  fs.existsSync(path.join(world, "client.json"))
)
  throw Error(
    "This shell fixture needs a disposable world with no client.json, so boot cannot start a second supervisor",
  );
const password = crypto.randomBytes(8).toString("hex");
const username = "astrafriend" + crypto.randomBytes(3).toString("hex");
const credentialPath = path.join(world, "account-test-credentials.json");
const previous = fs.existsSync(credentialPath)
  ? JSON.parse(fs.readFileSync(credentialPath))
  : { account: "ragnarok", password: "ragnarok" };
const gmPassword = " " + crypto.randomBytes(9).toString("hex") + "'\\! ";
const secrets = [password, previous.password, gmPassword];
const out = path.join(world, "account-tests", String(Date.now()));
fs.mkdirSync(out, { recursive: true });
const env = {
  ...process.env,
  RAGNAROK_OFFLINE_HOME: world,
  RAGNAROKMAC_ROOT: path.join(world, "runtime"),
  RAGNAROKMAC_STATE: path.join(world, "state"),
  NEBULA_HOME: path.join(world, "nebula"),
};
async function main() {
  await verifyWorld();
  const app = await _electron.launch({
    executablePath: require("electron"),
    args: [
      path.join(work, "electron/main.js"), "--quiet",
      "--user-data-dir=" + path.join(world, "accounts-electron-profile"),
    ],
    env,
    cwd: work,
    timeout: 45000,
  });
  try {
    const boot = await app.firstWindow();
    await boot.waitForLoadState("domcontentloaded");
    await expect(boot.locator("body")).toContainText(
      /Waiting for your client|game files|assets/i,
      { timeout: 15000 },
    );
    await boot.evaluate(() => window.__ELECTRON__.core.invoke("open_settings"));
    const page = await expect
      .poll(() =>
        app
          .windows()
          .find((p) => p.url().endsWith("settings.html"))
          ?.url(),
      )
      .toBeTruthy()
      .then(() => app.windows().find((p) => p.url().endsWith("settings.html")));
    page.setDefaultTimeout(90000);
    await page
      .getByRole("button", { name: "Refresh accounts", exact: true })
      .click();
    await expect(page.locator("#accounts-era")).toHaveText("Renewal accounts", {
      timeout: 40000,
    });
    await expect(
      page.getByRole("button", {
        name: "Change GM/admin password",
        exact: true,
      }),
    ).toBeEnabled();
    await page
      .locator("#accounts-panel")
      .screenshot({ path: path.join(out, "settings-before.png") });
    await page.locator("#account-password").fill("x".repeat(24));
    await page.locator("#account-confirmation").fill("x".repeat(24));
    await expect(page.locator("#account-password")).toHaveValue("x".repeat(24));
    await page
      .getByRole("button", { name: "Change GM/admin password", exact: true })
      .click();
    await expect(page.locator("#accounts-status")).toContainText("8–23", {
      timeout: 40000,
    });
    await expect(page.locator("#account-password")).toHaveValue("");
    await expect(page.locator("#account-confirmation")).toHaveValue("");
    await page.locator("#account-username").fill(username);
    await page.locator("#account-password").fill(password);
    await page.locator("#account-confirmation").fill(password);
    await page
      .getByRole("button", { name: "Create friend account", exact: true })
      .click();
    await expect(page.locator("#accounts-status")).toContainText(
      "Account updated in renewal",
      { timeout: 90000 },
    );
    const accounts = await page.evaluate(() =>
      window.__ELECTRON__.core.invoke("accounts", {
        action: "list",
        era: "renewal",
      }),
    );
    const friend = accounts.accounts.find((a) => a.username === username);
    if (!friend || friend.group !== 0) throw Error("Friend not ordinary");
    // A new account has to be able to delete its characters: the game checks
    // its delete prompt against a birthday the account must actually carry.
    if (friend.needsBirthdate)
      throw Error("A created account has no birthday and cannot delete a character");
    // Worlds seeded before the birthday existed still have accounts without
    // one, so the migration tracks the listing rather than a fixed state.
    const migration = page.getByRole("button", {
      name: "Set missing account birthdays",
      exact: true,
    });
    if (accounts.accounts.some((account) => account.needsBirthdate))
      await expect(migration).toBeEnabled();
    else await expect(migration).toBeDisabled();
    await page.locator("#account-select").selectOption(friend.id);
    await page
      .getByRole("button", { name: "Disable account", exact: true })
      .click();
    await expect(page.locator("#accounts-status")).toContainText(
      "Account updated in renewal",
      { timeout: 90000 },
    );
    await page.locator("#account-select").selectOption(friend.id);
    await expect(page.locator("#account-detail")).toContainText(
      "disabled (state 5)",
    );
    await page
      .getByRole("button", { name: "Enable account", exact: true })
      .click();
    await expect(page.locator("#accounts-status")).toContainText(
      "Account updated in renewal",
      { timeout: 90000 },
    );
    await page.locator("#account-select").selectOption(friend.id);
    await expect(page.locator("#account-detail")).toContainText("enabled");
    await page
      .locator("#accounts-panel")
      .screenshot({ path: path.join(out, "settings-after.png") });
    fs.writeFileSync(
      path.join(world, "friend-test-credentials.json"),
      JSON.stringify({ account: username, password }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(out, "settings-report.json"),
      JSON.stringify(
        {
          realElectronIPC: true,
          overlengthRejectedWithoutTruncation: true,
          fieldsCleared: true,
          createdFriend: friend,
          disableEnable: true,
        },
        null,
        2,
      ),
    );
    const gm = accounts.accounts.find((a) => a.username === previous.account);
    if (!gm) throw Error("GM fixture missing");
    await page.locator("#account-select").selectOption(gm.id);
    await page.locator("#account-password").fill(gmPassword);
    await page.locator("#account-confirmation").fill(gmPassword);
    // Retain the candidate privately if a transport failure makes the write's
    // outcome uncertain; neither credential enters traces or screenshots.
    const pending = path.join(world, "account-test-credentials.pending.json");
    fs.writeFileSync(
      pending,
      JSON.stringify({ account: gm.username, password: gmPassword }),
      { mode: 0o600 },
    );
    await page
      .getByRole("button", { name: "Change GM/admin password", exact: true })
      .click();
    await expect(page.locator("#accounts-status")).toContainText(
      "Account updated in renewal",
      { timeout: 90000 },
    );
    await expect(page.locator("#account-password")).toHaveValue("");
    fs.renameSync(pending, credentialPath);
    const final = await page.evaluate(() =>
      window.__ELECTRON__.core.invoke("accounts", {
        action: "list",
        era: "renewal",
      }),
    );
    const finalGM = final.accounts.find((a) => a.id === gm.id);
    if (!finalGM || finalGM.group !== gm.group || finalGM.defaultPassword)
      throw Error("GM identity/password status changed unexpectedly");
    await page
      .locator("#accounts-panel")
      .screenshot({ path: path.join(out, "gm-updated.png") });
    await boot.goto("http://127.0.0.1:3338/");
    const gameIPCBlocked = await boot.evaluate(async () => {
      if (!window.__ELECTRON__) return true;
      try {
        await window.__ELECTRON__.core.invoke("accounts", {
          action: "list",
          era: "renewal",
        });
        return false;
      } catch (error) {
        return String(error.message).includes("not available to this page");
      }
    });
    expect(gameIPCBlocked).toBe(true);
    const browser = await chromium.launch({ headless: true });
    try {
      const bad = await browser.newContext({
        ...devices["Pixel 5"],
        baseURL: "http://127.0.0.1:3338",
      });
      const rejected = await bad.newPage();
      rejected.setDefaultTimeout(45000);
      await rejected.goto("/");
      await rejected
        .getByLabel("Account", { exact: true })
        .fill(previous.account);
      await rejected
        .getByLabel("Password", { exact: true })
        .fill(previous.password);
      await rejected.getByRole("button", { name: "Log in", exact: true }).tap();
      await expect(
        rejected
          .locator(".text")
          .filter({ hasText: /Incorrect User ID or Password/ }),
      ).toBeVisible({ timeout: 30000 });
      await bad.close();
      const good = await browser.newContext({
        ...devices["Pixel 5"],
        baseURL: "http://127.0.0.1:3338",
      });
      const game = await good.newPage();
      game.setDefaultTimeout(60000);
      process.env.RO_E2E_ACCOUNT = previous.account;
      process.env.RO_E2E_PASSWORD = gmPassword;
      await login(game);
      await game.screenshot({
        path: path.join(out, "game-after-password-change.png"),
      });
      fs.writeFileSync(
        path.join(out, "gm-report.json"),
        JSON.stringify(
          {
            realSettingsGMPasswordChange: true,
            oldPasswordRejected: true,
            newPasswordPlayable: true,
            gameIPCBlocked,
            passwordBoundaryWithSpacesAndPunctuation: true,
            browser: browser.version(),
            gm: finalGM,
          },
          null,
          2,
        ),
      );
    } finally {
      await browser.close();
    }
    console.log("Accounts and game login passed. Evidence:", out);
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  }
}
main().catch((error) => {
  let message = String(error.message);
  for (const secret of secrets)
    message = message.split(secret).join("[redacted]");
  console.error(message);
  process.exitCode = 1;
});
