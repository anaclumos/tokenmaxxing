import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { claudeCredentials, freshHome, HOUR_MS, pooledClaude } from "./fixtures.ts";
import { IDS, writeClaudeStoreBlob } from "./edge-minesweep-fixtures.ts";

const home = freshHome();

test("removing a Claude account whose credential file is already gone succeeds, twice in a row, and clears its store and usage snapshot only", async () => {
  const { claude } = await import("../src/lib/claude.ts");
  const { storeDirFor, usageJsonFor } = await import("../src/lib/paths.ts");
  const gone = storeDirFor(IDS.spare);
  mkdirSync(gone, { recursive: true });
  writeFileSync(join(gone, ".claude.json"), "{}");
  mkdirSync(join(home, "usage"), { recursive: true });
  writeFileSync(usageJsonFor(IDS.spare), "{}");
  writeClaudeStoreBlob(home, IDS.backup, claudeCredentials("backup-token", Date.now() + HOUR_MS));

  await claude.removeCredentials(pooledClaude(IDS.spare));
  await claude.removeCredentials(pooledClaude(IDS.spare));

  expect({ store: existsSync(gone), usage: existsSync(usageJsonFor(IDS.spare)), other: existsSync(join(storeDirFor(IDS.backup), ".credentials.json")) }).toEqual({ store: false, usage: false, other: true });
});
