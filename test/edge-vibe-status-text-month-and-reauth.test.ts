import { expect, test } from "bun:test";
import { join } from "node:path";
import { preparedHomes } from "./edge-async-sweep-fixtures.ts";
import { labeled, poolHeaders, writePool } from "./edge-cli-surface-fixtures.ts";
import { run } from "./edge-telemetry-fixtures.ts";
import { budgetBody, DAY_S, serveMistral, vibeEnv, vibeIdentity, writeVibeStore } from "./edge-vibe-fixtures.ts";

test("status after a live Vibe read draws one month bar for the readable key and marks a revoked key needs-reauth with the auth --vibe hint", async () => {
  const resetAt = new Date(Date.now() + 20 * DAY_S * 1000).toISOString();
  const ids = { ok: vibeIdentity("user_ok", "org_test"), revoked: vibeIdentity("user_revoked", "org_test") };
  const homes = preparedHomes();
  writePool(homes, "vibe", [labeled(ids.ok, "vibe-ok", "pro"), labeled(ids.revoked, "vibe-revoked", "pro")]);
  writeVibeStore(homes, ids.ok, "ok-key");
  writeVibeStore(homes, ids.revoked, "revoked-key");
  const mistral = serveMistral({
    users: { "ok-key": { id: "user_ok", email: "ok@example.com", organization: { id: "org_test" } } },
    budgets: { "ok-key": budgetBody(40, resetAt) },
  });
  try {
    const result = await run(["status"], vibeEnv(homes, mistral, { binDir: join(homes.home, "no-bin"), vibeHome: join(homes.home, "vibe-home") }));
    const lines = result.stdout.split("\n");
    expect({
      exitCode: result.exitCode,
      headers: poolHeaders(result.stdout),
      bars: lines.filter((line) => /[█░]/.test(line)).map((line) => line.replace(/[█░]+/, "#").replace(/\s+/g, " ").trim()),
      revokedFlagged: lines.some((line) => line.includes("vibe-revoked") && line.includes("needs-reauth")),
      authHint: result.stdout.includes("tokenmaxxing auth --vibe"),
      stdout: result.stdout,
      stderr: result.stderr,
    }).toMatchObject({
      exitCode: 0,
      headers: ["vibe  (2 accounts, status-only)"],
      bars: ["month # 40%"],
      revokedFlagged: true,
      authHint: true,
    });
  } finally {
    mistral.stop();
  }
}, 30_000);
