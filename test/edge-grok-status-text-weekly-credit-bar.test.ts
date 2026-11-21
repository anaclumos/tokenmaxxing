import { expect, test } from "bun:test";
import { run } from "./edge-telemetry-fixtures.ts";
import { preparedHomes } from "./edge-async-sweep-fixtures.ts";
import { writePool } from "./edge-cli-surface-fixtures.ts";
import { barRows, grokCards, grokEntry, grokEnv, pooledGrok, serveGrokCredits, storeGrokLogin } from "./edge-grok-statusonly-fixtures.ts";

const USED = "4e1f0a7c-9b2d-4c3e-8f6a-0d5b7c1e2a94";
const IDLE = "9b2d4c3e-8f6a-4d5b-9c1e-2a944e1f0a7c";
const EMPTY = "0bde028b-b09d-49e8-9b7c-2de039f5bca6";

test("status heads the grok pool status-only and draws one weekly credit bar per sampled account, 0% for a credits body with no creditUsagePercent, and status --cached replays the stored bars without a read", async () => {
  const homes = preparedHomes();
  writePool(homes, "grok", [pooledGrok(USED, "used@example.com"), pooledGrok(IDLE, "idle@example.com"), pooledGrok(EMPTY, "empty@example.com")]);
  storeGrokLogin(homes, USED, grokEntry(USED, { key: "used-token" }));
  storeGrokLogin(homes, IDLE, grokEntry(IDLE, { key: "idle-token" }));
  const stub = serveGrokCredits({ "used-token": { percent: 37 }, "idle-token": { percent: null } });
  try {
    const env = grokEnv(homes, stub);
    const live = await run(["status"], env);
    const liveReads = stub.bearers.length;
    const cached = await run(["status", "--cached"], env);
    const shown = grokCards(live.stdout);
    const replayed = grokCards(cached.stdout);
    const emptyLive = (shown.cards["empty@example.com"] ?? []).join("\n");
    const emptyCached = (replayed.cards["empty@example.com"] ?? []).join("\n");
    expect({
      exitCodes: [live.exitCode, cached.exitCode],
      header: shown.header,
      liveBars: { used: barRows(shown.cards["used@example.com"]), idle: barRows(shown.cards["idle@example.com"]), empty: barRows(shown.cards["empty@example.com"]) },
      emptyLive: { failed: emptyLive.includes("live sample failed"), pointsAtAuth: emptyLive.includes("auth --grok") },
      cachedBars: { used: barRows(replayed.cards["used@example.com"]), idle: barRows(replayed.cards["idle@example.com"]), empty: barRows(replayed.cards["empty@example.com"]) },
      emptyCached: { neverSampled: emptyCached.includes("never sampled") },
      liveReads,
      cachedReads: stub.bearers.length - liveReads,
      stderr: [live.stderr, cached.stderr],
    }).toEqual({
      exitCodes: [0, 0],
      header: "grok  (3 accounts, status-only)",
      liveBars: { used: ["week 37%"], idle: ["week 0%"], empty: [] },
      emptyLive: { failed: true, pointsAtAuth: true },
      cachedBars: { used: ["week 37%"], idle: ["week 0%"], empty: [] },
      emptyCached: { neverSampled: true },
      liveReads: 2,
      cachedReads: 0,
      stderr: ["", ""],
    });
  } finally {
    stub.stop();
  }
}, 30_000);
