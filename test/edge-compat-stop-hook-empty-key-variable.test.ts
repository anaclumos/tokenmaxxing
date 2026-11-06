import { expect, test } from "bun:test";
import { dropSandbox, readLog, readMarker, runMain, sandbox, seatSessionEnv, spentSeatWithSpareKey } from "./edge-compat-fixtures.ts";

test("the Stop hook of a session launched on an account, whose API key variable is empty, moves the spent seat onto a stored API key", async () => {
  const box = sandbox("stop-empty-key");
  try {
    const now = Date.now();
    const seatId = spentSeatWithSpareKey(box.tm, now);
    const sid = crypto.randomUUID();
    const launchedAt = now - 60_000;
    const run = await runMain({
      args: ["__stop-hook"],
      cwd: box.root,
      stdin: JSON.stringify({ session_id: sid, hook_event_name: "Stop" }),
      env: seatSessionEnv(box, { seatId, sid, extra: { TOKENMAXXING_LAUNCHED_AT: String(launchedAt), TOKENMAXXING_API_KEY_ID: "" } }),
    });

    expect({ ...run, log: readLog(box.tm), marker: readMarker(box.tm, sid) }).toMatchObject({
      exitCode: 0,
      marker: { apiKeyId: "spare", accountId: "", sessionId: sid, launchedAt, origin: "stop", compact: true },
    });
  } finally {
    dropSandbox(box);
  }
}, 30_000);
