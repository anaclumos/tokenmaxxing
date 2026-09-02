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
    const liveClaim = readOAuthAccount();
    const claimed = liveClaim?.accountUuid ?? null;
    const claimedOrg = liveClaim?.organizationUuid ?? null;
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
      if (target.needsReauth) { console.error(c.red(`${target.label} needs re-auth - run \`tokenmaxxing auth ${target.label}\``)); return 1; }
      return swapTo(target);
    }

    const everyoneIn = (accounts: Account[]): PickCtx => ({
      now,
      thresholds: effectiveBars(cfg, { accounts, now, switchFamilies: cfg.policy.switchModels }),
      currentAccountUuid: null,
      switchFamilies: cfg.policy.switchModels,
    });
    while (true) {
      const cur = loadAccounts();
      const everyone = everyoneIn(cur.accounts);
      const active =
        (claimedOrg != null ? cur.accounts.find((a) => a.organizationUuid === claimedOrg) : null) ??
        cur.accounts.find((a) => a.accountUuid === cur.activeAccountUuid) ??
        null;
      if (active != null && currentWins(active, cur.accounts, everyone)) {
        if (drifted) return swapTo(active);
        const expiry = weeklyExpiry(active, now);
        const why = Number.isFinite(expiry) ? ` (weekly ${fmtReset(expiry, now)})` : "";
        console.log(`already on the best account: ${c.bold(active.label)}${why}`);
        return 0;
      }
      const best = pickBest(cur.accounts, { ...everyone, currentAccountUuid: active?.accountUuid ?? null });
      if (!best) break;
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

    const fresh = loadAccounts();
    const earliest = pickEarliestReset(fresh.accounts, everyoneIn(fresh.accounts));
    if (!earliest) {
      const reauth = fresh.accounts.filter((a) => a.needsReauth).map((a) => a.label);
      if (reauth.length > 0) { console.error(c.yellow(`no switchable account - reauth needed (run \`tokenmaxxing auth --all\`): ${reauth.join(", ")}`)); return 1; }
      const freshActive = fresh.accounts.find((a) => a.accountUuid === fresh.activeAccountUuid) ?? null;
      if (drifted && freshActive) return swapTo(freshActive);
      console.log(c.yellow("all accounts at their limit with unknown reset times (unparsed reset clocks? see tokenmaxxing.log) - staying put"));
      return 0;
    }
    const reauth = fresh.accounts.filter((a) => a.needsReauth).map((a) => a.label);
    const reauthNote = reauth.length ? ` - re-auth needed: ${reauth.join(", ")}` : "";
    if (earliest.account.accountUuid === fresh.activeAccountUuid && !drifted) {
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
