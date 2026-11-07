import { expect, test } from "bun:test";
import { join } from "node:path";
import { z } from "zod";
import type { Window } from "../src/lib/types.ts";
import { HOUR_MS } from "./fixtures.ts";
import { parseJson, preparedHomes } from "./edge-async-sweep-fixtures.ts";
import { labeled, writePool } from "./edge-cli-surface-fixtures.ts";
import { run } from "./edge-telemetry-fixtures.ts";
import { budgetBody, DAY_S, serveMistral, vibeEnv, vibeIdentity, writeVibeStore } from "./edge-vibe-fixtures.ts";

const VibeReportSchema = z.object({ accounts: z.array(z.looseObject({ label: z.string() })) });

test("inverted: status --json reports a live Vibe figure no read returned", async () => {
  const now = Date.now();
  const resetAt = new Date(now + 20 * DAY_S * 1000).toISOString();
  const sampledAt = now - HOUR_MS;
  const stored: Window = { name: null, usedPercentage: 55, resetsAt: now + 10 * DAY_S * 1000, windowSeconds: 30 * DAY_S, sampledAt };
  const ids = { ok: vibeIdentity("user_ok", "org_test"), forbidden: vibeIdentity("user_forbidden", "org_test"), broken: vibeIdentity("user_broken", "org_test") };
  const homes = preparedHomes();
  writePool(homes, "vibe", [
    { ...labeled(ids.ok, "vibe-ok", "free"), email: "ok@example.com" },
    { ...labeled(ids.forbidden, "vibe-forbidden", "pro"), email: "forbidden@example.com", windows: [stored], lastUsageAt: sampledAt },
    { ...labeled(ids.broken, "vibe-broken", "pro"), email: "broken@example.com", windows: [stored], lastUsageAt: sampledAt },
  ]);
  writeVibeStore(homes, ids.ok, "ok-key");
  writeVibeStore(homes, ids.forbidden, "forbidden-key");
  writeVibeStore(homes, ids.broken, "broken-key");
  const mistral = serveMistral({
    users: {
      "ok-key": { id: "user_ok", email: "ok@example.com", organization: { id: "org_test" } },
      "forbidden-key": { id: "user_forbidden", email: "forbidden@example.com", organization: { id: "org_test" } },
      "broken-key": { id: "user_broken", email: "broken@example.com", organization: { id: "org_test" } },
    },
    budgets: { "ok-key": budgetBody(40, resetAt) },
    refusals: { "forbidden-key": 403, "broken-key": 500 },
  });
  try {
    const result = await run(["status", "--json"], vibeEnv(homes, mistral, { binDir: join(homes.home, "no-bin"), vibeHome: join(homes.home, "vibe-home") }));
    const report = VibeReportSchema.safeParse(parseJson(result.stdout)?.vibe);
    const byLabel = report.success ? Object.fromEntries(report.data.accounts.map((a) => [a.label, a])) : null;
    const kept = { needsReauth: false, sample: { ok: false }, usageAt: sampledAt, usage: { fiveHour: null, week: { usedPercentage: 55, windowSeconds: 30 * DAY_S }, limits: [] } };
    expect({ exitCode: result.exitCode, byLabel, stdout: result.stdout, stderr: result.stderr }).toMatchObject({
      exitCode: 0,
      byLabel: {
        "vibe-ok": {
          tier: "pro",
          needsReauth: false,
          sample: { ok: true, source: "probe" },
          usage: { fiveHour: null, week: { usedPercentage: -1, resetsAt: Date.parse(resetAt), windowSeconds: 30 * DAY_S }, limits: [] },
        },
        "vibe-forbidden": kept,
        "vibe-broken": kept,
      },
    });
  } finally {
    mistral.stop();
  }
}, 30_000);
