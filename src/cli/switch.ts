// `tokenmaxxing switch [selector]`.
// No selector → greedy: rank EVERY account (current included) by pace pressure
// (furthest behind its own weekly pace first, see picker.ts) among those with
// session/week under threshold, off the cached windows.
// When the current account already wins (or ties - swapping between equals buys
// nothing), do nothing: the command is idempotent, so running it periodically
// converges on the right account. With a selector → switch to that one. Runs
// under the flock. When everything is depleted it stays on / switches to
// whichever account recovers soonest.
//
// The active LABEL can drift from the live login (manual /login is the
// surviving drift source). A no-op would freeze that drift forever, so when
// ~/.claude.json names a different account than accounts.json we swap for real
// instead of trusting the label - performSwap resolves the live credential's
// true owner, harvesting the drifted login correctly.

import { withLock } from "../lib/lock.ts";
import { paths } from "../lib/paths.ts";
import { loadAccounts, loadConfig } from "../lib/state.ts";
import { readOAuthAccount } from "../lib/claudejson.ts";
import { performSwap } from "../lib/swap.ts";
import { currentWins, effectiveBars, pickBest, pickEarliestReset, weeklyExpiry, type PickCtx } from "../lib/picker.ts";
import { InvalidGrantError } from "../lib/oauth.ts";
import { findAccount } from "./rename.ts";
import { c, fmtReset } from "./render.ts";
import type { Account } from "../lib/types.ts";

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
    const claimed = readOAuthAccount()?.accountUuid ?? null;
    const drifted = claimed != null && claimed !== idx.activeAccountUuid;

    const swapTo = async (target: Account): Promise<number> => {
      try {
        await performSwap(target);
      } catch (e) {
        if (e instanceof InvalidGrantError) { console.error(c.red(`${target.label}'s refresh token is dead - run \`tokenmaxxing auth ${target.label}\``)); return 1; }
        throw e;
      }
      console.log(`${c.green("↻")} switched to ${c.bold(target.label)}`);
      return 0;
    };

    if (selector) {
      const target = findAccount(idx.accounts, selector);
      if (!target) { console.error(c.red(`no account matches "${selector}"`)); return 1; }
      if (target.accountUuid === idx.activeAccountUuid && !drifted) { console.log(`already on ${c.bold(target.label)}`); return 0; }
      if (target.needsReauth) { console.error(c.red(`${target.label} needs re-auth - \`tokenmaxxing add\``)); return 1; }
      return swapTo(target);
    }

    // auto: greedy over everyone, current included - a no-op when current wins.
    // No session context here, so every configured per-model family gates.
    // Dead-token fallback mirrors decide.ts's greedy loop, NOT chooseAndSwap:
    // its fallback lands on the next usable candidate unconditionally, which
    // is right when over a bar but wrong here - a dead grant on the pace
    // winner must re-check the seat, or a healthy current account gets a real
    // swap onto a pace-WORSE account and the next periodic check bounces it
    // straight back (closing-review catch). performSwap persists needs-reauth
    // before throwing, so each reload shrinks the candidate set and the loop
    // terminates.
    const everyone: PickCtx = { now, thresholds: effectiveBars(cfg), currentAccountUuid: null, switchFamilies: cfg.policy.switchModels };
    while (true) {
      const cur = loadAccounts();
      const active = cur.accounts.find((a) => a.accountUuid === cur.activeAccountUuid) ?? null;
      if (active != null && currentWins(active, cur.accounts, everyone)) {
        if (drifted) return swapTo(active);
        const expiry = weeklyExpiry(active, now);
        const why = Number.isFinite(expiry) ? ` (weekly ${fmtReset(expiry, now)})` : "";
        console.log(`already on the best account: ${c.bold(active.label)}${why}`);
        return 0;
      }
      const best = pickBest(cur.accounts, { ...everyone, currentAccountUuid: cur.activeAccountUuid });
      if (!best) break; // no usable target: the depleted path below decides
      try {
        await performSwap(best);
      } catch (e) {
        if (e instanceof InvalidGrantError) {
          console.error(c.red(`${best.label}'s refresh token is dead - run \`tokenmaxxing auth ${best.label}\``));
          continue;
        }
        throw e;
      }
      console.log(`${c.green("↻")} switched to ${c.bold(best.label)}`);
      return 0;
    }

    // No usable target swapped in: everything is depleted, or the remaining
    // candidates' refresh tokens just died (chooseAndSwap marks needs-reauth,
    // hence the reload). Stay on / switch to whichever recovers soonest.
    const fresh = loadAccounts();
    const earliest = pickEarliestReset(fresh.accounts, everyone);
    if (!earliest) {
      // Either every account needs re-auth, or every account is blocked with no
      // recoverable bound (unparsed reset clocks AND no sample time - see log).
      const reauth = fresh.accounts.filter((a) => a.needsReauth).map((a) => a.label);
      if (reauth.length > 0) { console.error(c.yellow(`no switchable account - reauth needed (run \`tokenmaxxing auth --all\`): ${reauth.join(", ")}`)); return 1; }
      // never freeze a label drift behind a no-op (see header).
      const freshActive = fresh.accounts.find((a) => a.accountUuid === fresh.activeAccountUuid) ?? null;
      if (drifted && freshActive) return swapTo(freshActive);
      console.log(c.yellow("all accounts at their limit with unknown reset times (unparsed reset clocks? see tokenmaxxing.log) - staying put"));
      return 0;
    }
    const reauth = fresh.accounts.filter((a) => a.needsReauth).map((a) => a.label);
    const reauthNote = reauth.length ? ` - re-auth needed: ${reauth.join(", ")}` : "";
    if (earliest.account.accountUuid === fresh.activeAccountUuid && !drifted) {
      // availableAt in the past means the current account is fine and the
      // others are simply unusable - do not claim a limit that is not there.
      const msg = earliest.availableAt <= now
        ? `staying on ${c.bold(earliest.account.label)} - no usable switch target${reauthNote}`
        : `all accounts at limit - staying on ${c.bold(earliest.account.label)} (${fmtReset(earliest.availableAt, now)})${reauthNote}`;
      console.log(c.yellow(msg));
      return 0;
    }
    const code = await swapTo(earliest.account);
    if (code === 0 && earliest.availableAt > now) {
      console.log(c.yellow(`all accounts at limit - ${c.bold(earliest.account.label)} recovers soonest (${fmtReset(earliest.availableAt, now)})${reauthNote}`));
    }
    return code;
  });
}
