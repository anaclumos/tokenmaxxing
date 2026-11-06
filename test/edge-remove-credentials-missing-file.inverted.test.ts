import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { claudeCredentials, freshHome, HOUR_MS, pooledClaude } from "./fixtures.ts";
import { IDS, writeClaudeStoreBlob } from "./edge-minesweep-fixtures.ts";

const home = freshHome();

test("inverted: removing a Claude account whose credential file is already gone succeeds, twice in a row, and clears its store and usage snapshot only", async () => {
  const { claude } = await import("../src/lib/claude.ts");
  const { storeDirFor, usageJsonFor } = await import("../src/lib/paths.ts");
  const gone = storeDirFor(IDS.spare);
  mkdirSync(gone, { recursive: true });
  writeFileSync(join(gone, ".claude.json"), "{}");
  mkdirSync(join(home, "usage"), { recursive: true });
  writeFileSync(usageJsonFor(IDS.spare), "{}");
  writeClaudeStoreBlob(home, IDS.backup, claudeCredentials("backup-token", Date.now() + HOUR_MS));

  await expect(claude.removeCredentials(pooledClaude(IDS.spare))).rejects.toThrow();
});
