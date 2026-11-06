import { expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshHome } from "./fixtures.ts";

freshHome();

const ACCOUNT = "0190f5a2-1e3a-7b5c-8d7f-0a2c4e6b8d93";

test("inverted: presence files written for live sessions read back with their account and API key, only account seats count toward the account, and a pid that already exited gets no file", async () => {
  const { livingPresences, presencePid, seatCounts, writePresence } = await import("../src/lib/presence.ts");
  const dir = join(mkdtempSync(join(tmpdir(), "tokenmaxxing-edge-presence-")), "live");
  writePresence({ dir, id: "session-a", accountId: ACCOUNT, pid: process.pid });
  writePresence({ dir, id: "session-b", accountId: ACCOUNT, pid: process.pid });
  writePresence({ dir, id: "session-key", accountId: "", pid: process.pid, apiKeyId: "edge-key" });
  const gone = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" });
  await gone.exited;
  let refusal: string | null = null;
  try {
    writePresence({ dir, id: "session-gone", accountId: ACCOUNT, pid: gone.pid });
  } catch (e) {
    refusal = e instanceof Error ? e.message : String(e);
  }

  expect({
    living: livingPresences(dir).toSorted((a, b) => a.id.localeCompare(b.id)),
    pid: presencePid({ dir, id: "session-a" }),
    seats: Object.fromEntries(seatCounts(dir)),
    refused: refusal !== null,
    goneFile: existsSync(join(dir, "session-gone")),
  }).not.toEqual({
    living: [
      { id: "session-a", accountId: ACCOUNT },
      { id: "session-b", accountId: ACCOUNT },
      { id: "session-key", accountId: "", apiKeyId: "edge-key" },
    ],
    pid: process.pid,
    seats: { [ACCOUNT]: 2 },
    refused: true,
    goneFile: false,
  });
});
