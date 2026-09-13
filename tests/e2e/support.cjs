const { expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const {
  control,
  processIdentity,
  sha256,
} = require("../../electron/asset-server");

async function verifyWorld() {
  if (!process.env.RO_E2E_WORLD)
    throw new Error(
      "Set RO_E2E_WORLD to a running disposable test world; see docs/TESTING.md",
    );
  const world = fs.realpathSync(process.env.RO_E2E_WORLD);
  const marker = JSON.parse(
    fs.readFileSync(path.join(world, ".ragnarok-e2e.json"), "utf8"),
  );
  expect(marker.disposable).toBe(true);
  const state = fs.realpathSync(path.join(world, "state"));
  const record = JSON.parse(
    fs.readFileSync(path.join(state, "asset-owner.json"), "utf8"),
  );
  const identity = record.identity;
  expect(identity.stateRoot).toBe(state);
  expect(identity.httpPort).toBe(3338);
  const binary = path.join(
    world,
    "runtime/bin",
    process.platform === "win32"
      ? "robrowser-remoteclient.exe"
      : "robrowser-remoteclient",
  );
  expect(identity.executableDigest).toBe(sha256(fs.readFileSync(binary)));
  expect(
    await processIdentity(
      identity.pid,
      path.join(
        world,
        "runtime/bin",
        process.platform === "win32" ? "ragnarok-stack.exe" : "ragnarok-stack",
      ),
    ),
  ).toEqual(record.osIdentity);
  const secret = fs
    .readFileSync(path.join(state, "asset-control.secret"), "utf8")
    .trim();
  await control(identity, secret, "status");
  return { world, identity };
}

const snapshot = (page) =>
  page.evaluate(() => window.roClientDiagnostics.snapshot());
module.exports = { verifyWorld, snapshot };
