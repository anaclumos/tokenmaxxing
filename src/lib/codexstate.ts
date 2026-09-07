import { writeFileAtomic } from "./atomic.ts";
import type { CodexIdentity } from "./codexauth.ts";
import { readJson } from "./json.ts";
import { codexPaths } from "./paths.ts";
import { CodexAccountsIndexSchema, LastSwapSchema, type CodexAccount, type CodexAccountsIndex, type CodexUsage } from "./types.ts";

export function loadCodexAccounts(): CodexAccountsIndex {
  return readJson(codexPaths.accountsJson, CodexAccountsIndexSchema) ?? { version: 1, activeAccountId: null, accounts: [] };
}

export function saveCodexAccounts(input: { index: CodexAccountsIndex }): void {
  writeFileAtomic(codexPaths.accountsJson, JSON.stringify(input.index, null, 2) + "\n");
}

export function upsertCodexAccount(index: CodexAccountsIndex, fresh: CodexAccount): void {
  const existing = index.accounts.find((entry) => entry.accountId === fresh.accountId);
  if (existing) Object.assign(existing, fresh);
  else index.accounts.push(fresh);
}

export function importedCodexAccount(input: { existing: CodexAccount | undefined; identity: CodexIdentity; usage: CodexUsage | null; credFile: string }): CodexAccount {
  const { existing, identity, usage, credFile } = input;
  return {
    accountId: identity.accountId,
    email: usage?.email ?? identity.email,
    label: existing?.label ?? usage?.email ?? identity.email ?? identity.accountId.slice(0, 8),
    planType: usage?.planType ?? identity.planType,
    credFile,
    addedAt: existing?.addedAt ?? new Date().toISOString(),
    needsReauth: false,
    lastUsage: usage ? { aggregate: usage.aggregate, perLimit: usage.perLimit } : existing?.lastUsage,
    lastUsageAt: usage ? Date.now() : existing?.lastUsageAt,
  };
}

export function loadCodexLastSwapAt(): number | null {
  return readJson(codexPaths.lastSwapJson, LastSwapSchema)?.ts ?? null;
}

export function saveCodexLastSwapAt(input: { ts: number }): void {
  writeFileAtomic(codexPaths.lastSwapJson, JSON.stringify({ ts: input.ts }));
}
