import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadEnvFile } from "../src/config.js";

test("loads .env values without overriding existing environment", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anthropic-proxy-env-"));
  const envFile = path.join(dir, ".env");
  await fs.writeFile(
    envFile,
    [
      "PORT=9999",
      "HOST=\"127.0.0.1\"",
      "EXISTING=from-file",
      "INLINE=value # comment",
      "export EXPORTED=yes",
    ].join("\n"),
  );

  const target = { EXISTING: "from-env" };
  assert.equal(loadEnvFile(envFile, target), true);
  assert.deepEqual(target, {
    PORT: "9999",
    HOST: "127.0.0.1",
    EXISTING: "from-env",
    INLINE: "value",
    EXPORTED: "yes",
  });
});

