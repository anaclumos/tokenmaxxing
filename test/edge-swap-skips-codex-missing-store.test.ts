import { expect, test } from "bun:test";
import { freshHome } from "./fixtures.ts";
import { writeCodexStore } from "./edge-async-sweep-fixtures.ts";
import { CLOSED_URL, IDS, pooled } from "./edge-minesweep-fixtures.ts";

const home = freshHome();
process.env.TOKENMAXXING_CODEX_USAGE_URL = `${CLOSED_URL}/backend-api/wham/usage`;

test("a Codex move skips the roomiest account when its store holds no credential and lands on the next account", async () => {
  const now = Date.now();
  const { codexPool } = await import("../src/lib/paths.ts");
  const { saveAccounts } = await import("../src/lib/state.ts");
  const { codex } = await import("../src/lib/codex.ts");
  const { evaluateAndMaybeSwap } = await import("../src/lib/decide.ts");
  saveAccounts(codexPool, {
    version: 2,
    accounts: [
      pooled({ id: IDS.work, label: "work", tier: "pro", sessionUsed: 95, weeklyUsed: 30, now }),
      pooled({ id: IDS.spare, label: "spare", tier: "pro", sessionUsed: 5, weeklyUsed: 10, now }),
      pooled({ id: IDS.backup, label: "backup", tier: "pro", sessionUsed: 40, weeklyUsed: 50, now }),
    ],
  });
  writeCodexStore({ home, state: home }, IDS.work);
  writeCodexStore({ home, state: home }, IDS.backup);

  const decision = await evaluateAndMaybeSwap(codex, now, false, null, { seatId: IDS.work });

  expect({ swapped: decision.swapped, account: decision.account?.id, reason: decision.reason }).toEqual({ swapped: true, account: IDS.backup, reason: "swapped" });
});
