import { expect, test } from "bun:test";
import { dropSandbox, readLog, readMarker, runMain, sandbox, seatSessionEnv, spentSeatWithSpareKey } from "./edge-compat-fixtures.ts";

test("the Stop hook of a supervised session whose environment has no launch time logs a failure and writes no respawn marker", async () => {
  const box = sandbox("stop-no-launch");
  try {
    const now = Date.now();
    const seatId = spentSeatWithSpareKey(box.tm, now);
    const sid = crypto.randomUUID();
    const run = await runMain({
      args: ["__stop-hook"],
      cwd: box.root,
      stdin: JSON.stringify({ session_id: sid, hook_event_name: "Stop" }),
      env: seatSessionEnv(box, { seatId, sid, extra: { TOKENMAXXING_API_KEY_ID: "" } }),
    });
    const log = readLog(box.tm);

    expect({ ...run, log, marker: readMarker(box.tm, sid), failureLogged: / stop\.error /.test(log) }).toMatchObject({
      exitCode: 0,
      marker: null,
      failureLogged: true,
    });
  } finally {
    dropSandbox(box);
  }
}, 30_000);
