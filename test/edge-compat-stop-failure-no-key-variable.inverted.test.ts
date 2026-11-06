import { expect, test } from "bun:test";
import { dropSandbox, readLog, readMarker, runMain, sandbox, seatSessionEnv, spentSeatWithSpareKey } from "./edge-compat-fixtures.ts";

test("inverted: the StopFailure hook of a supervised session with no API key variable offers no API key", async () => {
  const box = sandbox("stopfailure-no-key-inverted");
  try {
    const now = Date.now();
    const seatId = spentSeatWithSpareKey(box.tm, now);
    const sid = crypto.randomUUID();
    const launchedAt = now - 60_000;
    const run = await runMain({
      args: ["__stop-failure-hook"],
      cwd: box.root,
      stdin: JSON.stringify({ session_id: sid, hook_event_name: "StopFailure", error: "rate_limit" }),
      env: seatSessionEnv(box, { seatId, sid, extra: { TOKENMAXXING_LAUNCHED_AT: String(launchedAt) } }),
    });

    expect({ ...run, log: readLog(box.tm), marker: readMarker(box.tm, sid) }).not.toMatchObject({
      marker: { apiKeyId: "spare" },
    });
  } finally {
    dropSandbox(box);
  }
}, 30_000);
