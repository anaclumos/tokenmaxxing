// codex-accounts.json + codex-lastswap.json persistence. Parallel to the
// claude files in state.ts, deliberately a separate file pair: claude and
// codex accounts have different shapes and swap independently, so neither
// index can clobber the other. Absent files are the empty state; a file that
// exists but fails to parse THROWS (a fabricated empty pool would silently
// orphan parked credentials).

import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "./atomic.ts";
import { codexPaths } from "./paths.ts";
import { CodexAccountsIndexSchema, LastSwapSchema, type CodexAccountsIndex } from "./types.ts";

export function loadCodexAccounts(): CodexAccountsIndex {
  if (!existsSync(codexPaths.accountsJson)) return { version: 1, activeAccountId: null, accounts: [] };
  return CodexAccountsIndexSchema.parse(JSON.parse(readFileSync(codexPaths.accountsJson, "utf8")));
}

export function saveCodexAccounts(input: { index: CodexAccountsIndex }): void {
  writeFileAtomic(codexPaths.accountsJson, JSON.stringify(CodexAccountsIndexSchema.parse(input.index), null, 2) + "\n");
}

export function loadCodexLastSwapAt(): number | null {
  if (!existsSync(codexPaths.lastSwapJson)) return null;
  return LastSwapSchema.parse(JSON.parse(readFileSync(codexPaths.lastSwapJson, "utf8"))).ts;
}

export function saveCodexLastSwapAt(input: { ts: number }): void {
  writeFileAtomic(codexPaths.lastSwapJson, JSON.stringify(LastSwapSchema.parse({ ts: input.ts })));
}
