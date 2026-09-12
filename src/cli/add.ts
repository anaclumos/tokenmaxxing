import { withLock } from "../lib/lock.ts";
import type { Provider } from "../lib/provider.ts";
import { loadAccounts, saveAccounts, upsertAccount } from "../lib/state.ts";
import { sessionWindow, weeklyWindow } from "../lib/picker.ts";
import { c, count } from "./render.ts";
import type { Account } from "../lib/types.ts";

export function usageNote(account: Account): string {
  const session = sessionWindow(account);
  const week = weeklyWindow(account);
  return session && week ? ` (session ${session.usedPercentage}% / week ${week.usedPercentage}%)` : "";
}

export async function cmdAdd(p: Provider): Promise<number> {
  console.log(c.cyan(`Opening an isolated ${p.name} login - your primary login is untouched.`));
  console.log(c.dim(p.loginStep("the account to add")));
  console.log();

  const harvested = await p.login();
  if (!harvested) return 1;

  const { account, poolSize } = await withLock(p.pool.lockFile, async () => {
    await harvested.park();
    const idx = loadAccounts(p.pool);
    const account = upsertAccount(idx, harvested, p.mergeWindows);
    saveAccounts(p.pool, idx);
    return { account, poolSize: idx.accounts.length };
  });

  console.log();
  const note = harvested.sample ? usageNote(account) : "";
  console.log(`${c.green("✓")} added ${c.bold(account.label)} (${account.tier ?? "?"})${note} → pool now has ${count({ n: poolSize, noun: "account" })}`);
  return 0;
}
