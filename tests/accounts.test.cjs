const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runAccounts } = require("../electron/accounts");

function fixture(t, source) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ro-account-transport-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, "accounts"), source);
  return cwd;
}
const request = {
  action: "password",
  era: "renewal",
  id: "2000000",
  username: "ragnarok",
  password: "a-test-only-secret",
  confirmation: "a-test-only-secret",
};

test("password request uses stdin while argv contains only the operation", async (t) => {
  const cwd = fixture(
    t,
    `let input=''; process.stdin.on('data',c=>input+=c); process.stdin.on('end',()=>{
        const request=JSON.parse(input);
        require('node:fs').writeFileSync('argv.json',JSON.stringify(process.argv));
        process.stdout.write(JSON.stringify({era:request.era,updated:request.password===request.confirmation}));
    });`,
  );
  assert.deepEqual(await runAccounts(process.execPath, { cwd }, request), {
    era: "renewal",
    updated: true,
  });
  const argv = JSON.parse(fs.readFileSync(path.join(cwd, "argv.json")));
  assert.equal(argv.length, 2);
  assert.equal(path.basename(argv[1]), "accounts");
  assert.ok(!JSON.stringify(argv).includes(request.password));
});

test("raw output and stderr never appear in account transport errors", async (t) => {
  const cwd = fixture(
    t,
    `process.stdin.resume(); process.stdin.on('end',()=>{
        process.stdout.write('malformed a-test-only-secret');
        process.stderr.write('SQL error a-test-only-secret'); process.exitCode=1;
    });`,
  );
  await assert.rejects(
    runAccounts(process.execPath, { cwd }, request),
    (error) => {
      assert.ok(!error.message.includes(request.password));
      assert.ok(!error.message.includes("SQL"));
      return true;
    },
  );
});

test("structured errors redact the supplied password", async (t) => {
  const cwd = fixture(
    t,
    `process.stdin.resume(); process.stdin.on('end',()=>{
        process.stdout.write(JSON.stringify({error:'rejected a-test-only-secret'})); process.exitCode=1;
    });`,
  );
  await assert.rejects(
    runAccounts(process.execPath, { cwd }, request),
    /rejected \[redacted\]/,
  );
});

test("unknown operations and oversized UTF-8 requests are rejected before spawning", async () => {
  await assert.rejects(
    runAccounts("/does-not-exist", {}, { ...request, action: "sql" }),
    /Invalid account request/,
  );
  await assert.rejects(
    runAccounts(
      "/does-not-exist",
      {},
      { ...request, username: "é".repeat(4096) },
    ),
    /too large/,
  );
});
