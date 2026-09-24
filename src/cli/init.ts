import { mkdirSync } from "node:fs";
import { withLock } from "../lib/lock.ts";
import { claudePool, codexPool, paths } from "../lib/paths.ts";
import { piInstall, piPreflight } from "../lib/pi.ts";
import { piStoreUsable } from "../lib/piauth.ts";
import type { Provider } from "../lib/provider.ts";
import { loadAccounts, loadConfig, saveAccounts, upsertAccount } from "../lib/state.ts";
import { c, count } from "./render.ts";

export function printUsage(p: Provider): void {
  console.log();
  console.log(`  ${c.bold("how to use")} - ${c.cyan("xx")} is shorthand for ${c.cyan("tokenmaxxing")}:`);
  if (p.statusOnly) {
    console.log(`    ${c.cyan(`xx status`)}         view pooled ${p.name} accounts (status-only pool: no automatic switching yet)`);
  } else {
    console.log(`    ${c.cyan(p.name)}             use ${p.name} as always; it switches accounts near quota automatically`);
  }
  console.log(`    ${c.cyan("xx")}                 show the pool with usage bars (same as ${c.cyan("xx status")})`);
  console.log(`    ${c.cyan(`xx add${p.flag}`)}             log in and pool another account`);
  console.log(`    ${c.cyan("xx help")}            everything else`);
}

export function cmdInitPi(): number {
  mkdirSync(paths.home, { recursive: true });
  loadConfig();
  piPreflight();
  piInstall();
  console.log();
  for (const [pool, poolPaths, flag] of [["claude", claudePool, ""], ["codex", codexPool, " --codex"]] as const) {
    const accounts = loadAccounts(poolPaths).accounts;
    if (accounts.length === 0) {
      console.log(`  ${pool} pool: empty - ${c.cyan(`xx init${flag}`)} pools the first account`);
      continue;
    }
    const ready = accounts.filter((a) => piStoreUsable(pool, a.id)).length;
    console.log(`  ${pool} pool: ${ready} of ${count({ n: accounts.length, noun: "account" })} logged into pi - ${c.cyan(`xx auth --pi${flag} --all`)} logs in the rest`);
  }
  console.log(`  then run ${c.cyan("pi")} as always: a session on an ${c.bold("anthropic")} or ${c.bold("openai-codex")} model starts on a pooled account and moves near quota`);
  return 0;
}

export async function cmdInit(p: Provider): Promise<number> {
  mkdirSync(paths.home, { recursive: true });
  loadConfig();
  p.preflight();

  const existing = loadAccounts(p.pool);
  if (existing.accounts.length > 0) {
    p.install();
    console.log(`${c.green("✓")} re-installed (pool already has ${count({ n: existing.accounts.length, noun: "account" })} - not re-importing)`);
    printUsage(p);
    return 0;
  }

  const harvested = await p.importLive();
  if (!harvested) return 1;

  const account = await withLock(p.pool.lockFile, async () => {
    await harvested.park();
    const idx = loadAccounts(p.pool);
    const imported = upsertAccount(idx, harvested, p.mergeWindows);
    saveAccounts(p.pool, idx);
    return imported;
  });

  console.log(`${c.green("✓")} imported current account → ${c.bold(account.label)} (${account.tier ?? "?"})`);
  p.install();
  const poolSize = loadAccounts(p.pool).accounts.length;
  console.log();
  console.log(`  pool ready (${count({ n: poolSize, noun: "account" })})`);
  printUsage(p);
  return 0;
}
