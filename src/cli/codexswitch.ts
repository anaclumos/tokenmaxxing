// `tokenmaxxing switch --codex [sel]`. Bare form is GREEDY and IDEMPOTENT off
// cached windows, exactly like the claude switch: rank every codex account
// (current included) by pace pressure among those under their screening bars;
// when the current account already wins, do nothing. The current account is
// the LIVE auth.json's own identity, never the stored label. The swap takes
// effect for the NEXT codex start: a running codex refuses a different
// account's credential (restart is the switch; the Stop hook + supervisor
// automate that for supervised sessions).

import { withLock } from "../lib/lock.ts";
import { codexPaths } from "../lib/paths.ts";
import { loadConfig } from "../lib/state.ts";
import { loadCodexAccounts } from "../lib/codexstate.ts";
import { codexCurrentWins, pickBestCodex } from "../lib/codexpick.ts";
import { performCodexSwap } from "../lib/codexswap.ts";
import { CodexInvalidGrantError } from "../lib/codexoauth.ts";
import { liveCodexAccountId } from "../lib/codexsample.ts";
import { presentCodexAccountIds, targetableCodexAccounts } from "../lib/codexpresence.ts";
import { effectiveBars } from "../lib/picker.ts";
import { c } from "./render.ts";

export async function cmdCodexSwitch(sel?: string): Promise<number> {
  const cfg = loadConfig();
  const bars = effectiveBars(cfg);
  const now = Date.now();

  return withLock(codexPaths.lockFile, async () => {
    const index = loadCodexAccounts();
    if (index.accounts.length === 0) {
      console.log(c.dim("no codex accounts yet - run `tokenmaxxing init --codex`"));
      return 1;
    }
    const currentId = liveCodexAccountId();

    if (sel !== undefined) {
      const target = index.accounts.find(
        (account) => account.label === sel || account.email === sel || account.accountId.startsWith(sel),
      );
      if (!target) {
        console.error(c.red(`no codex account matches "${sel}"`));
        for (const account of index.accounts) console.error(c.dim(`  ${account.label} (${account.accountId.slice(0, 8)})`));
        return 1;
      }
      if (target.accountId === currentId) {
        console.log(`already on ${c.bold(target.label)}`);
        return 0;
      }
      if (presentCodexAccountIds().has(target.accountId)) {
        console.error(c.red(`${target.label} is running in a live codex session - swapping onto it would break that session's credential`));
        return 1;
      }
      await performCodexSwap({ target });
      console.log(`${c.green("✓")} switched codex to ${c.bold(target.label)} (takes effect on the next codex start)`);
      return 0;
    }

    while (true) {
      const current = loadCodexAccounts();
      const candidates = targetableCodexAccounts({ accounts: current.accounts, activeAccountId: currentId });
      const active = candidates.find((account) => account.accountId === currentId) ?? null;
      if (codexCurrentWins({ active, accounts: candidates, thresholds: bars, now })) {
        console.log(`already on the best codex account: ${c.bold(active?.label ?? "?")}`);
        return 0;
      }
      const best = pickBestCodex({ accounts: candidates, thresholds: bars, now, currentAccountId: currentId });
      if (!best) {
        console.log(c.yellow("no usable codex switch target (all at their bars, unmeasured, or needing reauth)"));
        return 1;
      }
      try {
        await performCodexSwap({ target: best });
      } catch (e) {
        if (e instanceof CodexInvalidGrantError) continue;
        throw e;
      }
      console.log(`${c.green("✓")} switched codex to ${c.bold(best.label)} (takes effect on the next codex start)`);
      return 0;
    }
  });
}
