import test from "node:test";
import assert from "node:assert";
import { loadConfig } from "../src/config.js";

test("loadConfig throws when FACTORIO_RCON_PASSWORD is missing", () => {
  const originalPassword = process.env.FACTORIO_RCON_PASSWORD;
  delete process.env.FACTORIO_RCON_PASSWORD;
  try {
    assert.throws(() => loadConfig(), /FACTORIO_RCON_PASSWORD environment variable is required/);
  } finally {
    if (originalPassword !== undefined) {
      process.env.FACTORIO_RCON_PASSWORD = originalPassword;
    }
  }
});

test("loadConfig uses FACTORIO_RCON_PASSWORD when provided", () => {
  const originalPassword = process.env.FACTORIO_RCON_PASSWORD;
  process.env.FACTORIO_RCON_PASSWORD = "secret-password";
  try {
    const config = loadConfig();
    assert.strictEqual(config.rconPassword, "secret-password");
  } finally {
    if (originalPassword !== undefined) {
      process.env.FACTORIO_RCON_PASSWORD = originalPassword;
    } else {
      delete process.env.FACTORIO_RCON_PASSWORD;
    }
  }
});
