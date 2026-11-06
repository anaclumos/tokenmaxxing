import { afterAll, expect, test } from "bun:test";
import { account } from "./fixtures.ts";
import { scratchDir, serve, useEnv, writePrivate } from "./edge-providers-fixtures.ts";

const EMAIL = "dev@example.com";
const MUSE_ID = new Bun.CryptoHasher("sha256").update(EMAIL).digest("hex");

const stub = serve((req) => {
  if (req.headers.get("authorization") !== "Bearer muse-token") return Response.json({ error: "unauthorized" }, { status: 401 });
  const s = Math.floor(Date.now() / 1000);
  return Response.json({
    subs_usage: { window: { used_percent: 22, resets_at: s + 7200, window_duration_mins: 300 }, weekly: { used_percent: 41, resets_at: s + 4 * 86_400 } },
    user_email: EMAIL,
  });
});

const restoreEnv = useEnv({
  HOME: scratchDir("home"),
  TOKENMAXXING_HOME: scratchDir("state"),
  XDG_CONFIG_HOME: scratchDir("config"),
  TOKENMAXXING_XDG_CONFIG_HOME: undefined,
  TOKENMAXXING_MUSE_USAGE_URL: `${stub.base}/muse-code/key`,
});
afterAll(() => {
  stub.stop();
  restoreEnv();
});

const { museAuthJsonFor, musePool } = await import("../src/lib/paths.ts");
const { loadAccounts, saveAccounts } = await import("../src/lib/state.ts");
const { observeMuse } = await import("../src/lib/muse.ts");
const { ConfigSchema } = await import("../src/lib/types.ts");

test("inverted: a Muse probe lands both windows in the pool stamped with the time of the read, not the caller's earlier clock", async () => {
  writePrivate(museAuthJsonFor(MUSE_ID), JSON.stringify({ providers: { meta: { access_token: "muse-token", user_email: EMAIL } } }));
  saveAccounts(musePool, { version: 2, accounts: [{ ...account(MUSE_ID, "pro", []), email: EMAIL }] });
  const [pooled] = loadAccounts(musePool).accounts;
  if (!pooled) throw new Error("the Muse pool lost its account");

  const before = Date.now();
  const observed = await observeMuse(pooled, ConfigSchema.parse({}), before - 5_000, { probe: true });
  const after = Date.now();

  const stored = loadAccounts(musePool).accounts.find((a) => a.id === MUSE_ID);
  const at = stored?.lastUsageAt ?? 0;
  expect({
    used: stored?.windows.map((w) => w.usedPercentage),
    stampedAtRead: stored?.windows.every((w) => w.sampledAt === at),
    readDuringCall: at >= before && at <= after,
    observedAt: observed?.at === at,
  }).not.toEqual({ used: [22, 41], stampedAtRead: true, readDuringCall: true, observedAt: true });
}, 20_000);
