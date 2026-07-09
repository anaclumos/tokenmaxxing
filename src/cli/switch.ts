// `tokenmaxxing switch [selector]` (also the bare `tokenmaxxing` / `xx`).
// No selector → auto-pick the best available account. With a selector → switch to
// that one. Manual/recovery tool: no threshold gate, runs under the flock. When
// everything is depleted it still switches to the soonest-resetting account.

import { withLock } from "../lib/lock.ts";
import { paths } from "../lib/paths.ts";
import { loadAccounts, loadConfig } from "../lib/state.ts";
import { performSwap, chooseAndSwap } from "../lib/swap.ts";
import { pickEarliestReset } from "../lib/picker.ts";
import { InvalidGrantError } from "../lib/oauth.ts";
import { findAccount } from "./rename.ts";
import { c, fmtReset } from "./render.ts";

export async function cmdSwitch(selector?: string): Promise<number> {
  const idx0 = loadAccounts();
  if (idx0.accounts.length < 2) {
    console.error(c.yellow("need at least 2 accounts to switch - add one with `tokenmaxxing add`"));
    return 1;
  }
  const cfg = loadConfig();
  const now = Date.now();

  return withLock(paths.lockFile, async () => {
    const idx = loadAccounts();

    if (selector) {
      const target = findAccount(idx.accounts, selector);
      if (!target) { console.error(c.red(`no account matches "${selector}"`)); return 1; }
      if (target.accountUuid === idx.activeAccountUuid) { console.log(`already on ${c.bold(target.label)}`); return 0; }
      if (target.needsReauth) { console.error(c.red(`${target.label} needs re-auth - \`tokenmaxxing add\``)); return 1; }
      try {
        await performSwap(target);
      } catch (e) {
        if (e instanceof InvalidGrantError) { console.error(c.red(`${target.label}'s refresh token is dead - re-add it`)); return 1; }
        throw e;
      }
      console.log(`${c.green("↻")} switched to ${c.bold(target.label)}`);
      return 0;
    }

    // auto: best account under threshold
    const landed = await chooseAndSwap({ now, threshold: cfg.threshold });
    if (landed) {
      console.log(`${c.green("↻")} switched to ${c.bold(landed.label)}`);
      return 0;
    }

    // everything is depleted → switch to whichever recovers soonest
    const earliest = pickEarliestReset(idx.accounts, { now, threshold: cfg.threshold, currentAccountUuid: idx.activeAccountUuid });
    if (!earliest) { console.error(c.yellow("no switchable account (all need re-auth?)")); return 1; }
    try {
      await performSwap(earliest.account);
    } catch (e) {
      if (e instanceof InvalidGrantError) { console.error(c.red(`${earliest.account.label}'s refresh token is dead`)); return 1; }
      throw e;
    }
    console.log(`${c.yellow("↻")} all accounts at limit - switched to ${c.bold(earliest.account.label)} (${fmtReset(earliest.availableAt, now)})`);
    return 0;
  });
}
