"use strict";
const { spawn } = require("node:child_process");

// Dedicated transport: unlike general supervisor output, raw account output
// and stderr are never suitable diagnostics. Secrets travel only through stdin.
function runAccounts(binary, options, request) {
  if (
    !request ||
    !["list", "create", "invite-create", "password", "disable", "enable"].includes(
      request.action,
    ) ||
    !["renewal", "prerenewal"].includes(request.era)
  ) {
    return Promise.reject(new Error("Invalid account request"));
  }
  const input = JSON.stringify(request);
  if (Buffer.byteLength(input) > 4096)
    return Promise.reject(new Error("Account request is too large"));
  const redact = (message) => {
    let safe = String(message);
    for (const key of ["password", "confirmation"]) {
      if (typeof request[key] === "string" && request[key])
        safe = safe.split(request[key]).join("[redacted]");
    }
    return safe;
  };
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ["accounts"], {
      ...options,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let output = "",
      settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(
        new Error(
          "The account operation timed out. Refresh Accounts and check the server before retrying.",
        ),
      );
    }, 120000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.length > 128 * 1024) {
        child.kill();
        finish(new Error("Invalid account response"));
      }
    });
    child.on("error", () =>
      finish(new Error("Could not start the account supervisor")),
    );
    child.stdin.on("error", () => {}); // exit/response determines the result
    child.stdin.end(input);
    child.on("close", (code) => {
      if (settled) return;
      let result;
      try {
        result = JSON.parse(output);
      } catch {
        finish(
          new Error(
            "Could not read the account response. Check that the server is ready and refresh Accounts.",
          ),
        );
        return;
      }
      if (code !== 0 || result.error) {
        finish(
          new Error(
            typeof result.error === "string"
              ? redact(result.error)
              : "Account operation failed",
          ),
        );
        return;
      }
      finish();
      resolve(result);
    });
  });
}

module.exports = { runAccounts };
