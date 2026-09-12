import { mkdirSync } from "node:fs";
import { withLock } from "../lib/lock.ts";
import { paths } from "../lib/paths.ts";
import type { Provider } from "../lib/provider.ts";
import { loadAccounts, loadConfig, saveAccounts, upsertAccount } from "../lib/state.ts";
import { c, count } from "./render.ts";

export function printUsage(p: Provider): void {
  console.log();
  console.log(`  ${c.bold("how to use")} - ${c.cyan("xx")} is shorthand for ${c.cyan("tokenmaxxing")}:`);
  console.log(`    ${c.cyan(p.name)}             use ${p.name} as always; it switches accounts near quota automatically`);
  console.log(`    ${c.cyan("xx")}                 show the pool with usage bars (same as ${c.cyan("xx status")})`);
  console.log(`    ${c.cyan(`xx add${p.flag}`)}             log in and pool another account`);
  console.log(`    ${c.cyan(`xx switch${p.flag}`)}          hop to the best account right now (the automatic switching needs no command)`);
  console.log(`    ${c.cyan("xx help")}            everything else`);
}

export async function cmdInit(p: Provider): Promise<number> {
  mkdirSync(paths.home, { recursive: true });
  loadConfig();
  p.preflight();

  const existing = loadAccounts(p.pool);
  if (existing.accounts.length > 0) {
    p.install();
    const active = existing.accounts.find((a) => a.id === existing.activeId);
    console.log(`${c.green("✓")} re-installed (pool already has ${count({ n: existing.accounts.length, noun: "account" })} - not re-importing)`);
    console.log(`  active: ${c.bold(active?.label ?? "unknown")}`);
    printUsage(p);
    return 0;
  }

  const harvested = await p.importLive();
  if (!harvested) return 1;

  const account = await withLock(p.pool.lockFile, async () => {
    await harvested.park();
    const idx = loadAccounts(p.pool);
    const imported = upsertAccount(idx, harvested, p.mergeWindows);
    idx.activeId = harvested.id;
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
