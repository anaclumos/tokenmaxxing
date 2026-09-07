import { withLock } from "../lib/lock.ts";
import { paths } from "../lib/paths.ts";
import { loadAccounts, loadConfig, loadUsage } from "../lib/state.ts";
import { readOAuthAccount } from "../lib/claudejson.ts";
import { isSkippableSwapError, performSwap } from "../lib/swap.ts";
import { currentWins, effectiveBars, pickBest, pickEarliestReset, weeklyExpiry, type PickCtx } from "../lib/picker.ts";
import { InvalidGrantError } from "../lib/oauth.ts";
import { errorMessage } from "../lib/errors.ts";
import { gatedFamilies } from "../lib/usage.ts";
import { findAccount } from "./rename.ts";
import { c, fmtReset, switchReporter } from "./render.ts";
import type { Account } from "../lib/types.ts";

export async function cmdSwitch(selector?: string, json = false): Promise<number> {
  const { deadGrants, emit, fail } = switchReporter({ json });
  const deadGrantMessage = (a: Account) => `${a.label}'s refresh token is dead - run \`tokenmaxxing auth ${a.label}\``;

  const idx0 = loadAccounts();
  if (idx0.accounts.length < 2) return fail("need at least 2 accounts to switch - add one with `tokenmaxxing add`", { paint: c.yellow });
  const cfg = loadConfig();
  const now = Date.now();

  return withLock(paths.lockFile, async () => {
    const idx = loadAccounts();
    const liveClaim = readOAuthAccount();
    const claimed = liveClaim?.accountUuid ?? null;
    const drifted = claimed != null && claimed !== idx.activeAccountUuid;

    const swapTo = async (target: Account, reason: string, extra: Record<string, unknown> = {}): Promise<number> => {
      try {
        await performSwap(target);
      } catch (e) {
        if (e instanceof InvalidGrantError) {
          deadGrants.push(target.label);
          return fail(deadGrantMessage(target));
        }
        throw e;
      }
      emit(`${c.green("↻")} switched to ${c.bold(target.label)}`, { switched: true, account: target.label, reason, ...extra });
      return 0;
    };

    if (selector) {
      const target = findAccount(idx.accounts, selector);
      if (!target) return fail(`no account matches "${selector}"`);
      if (target.accountUuid === idx.activeAccountUuid && !drifted) {
        emit(`already on ${c.bold(target.label)}`, { switched: false, account: target.label, reason: "already-on" });
        return 0;
      }
      if (target.needsReauth) return fail(`${target.label} needs re-auth - run \`tokenmaxxing auth ${target.label}\``);
      return swapTo(target, "selected");
    }

    const switchFamilies = gatedFamilies(loadUsage()?.model ?? null, cfg.policy.switchModels);
    const everyoneIn = (accounts: Account[]): PickCtx => ({
      now,
      thresholds: effectiveBars(cfg, { accounts, now, switchFamilies }),
      currentAccountUuid: null,
      switchFamilies,
    });
    const rejected = new Set<string>();
    while (true) {
      const cur = loadAccounts();
      const everyone = everyoneIn(cur.accounts);
      const pool = cur.accounts.filter((a) => !rejected.has(a.accountUuid));
      const active =
        (claimed != null ? cur.accounts.find((a) => a.accountUuid === claimed) : null) ??
        cur.accounts.find((a) => a.accountUuid === cur.activeAccountUuid) ??
        null;
      if (active != null && currentWins(active, pool, everyone)) {
        if (drifted) return swapTo(active, "drift-reconciled");
        const expiry = weeklyExpiry(active, now);
        const why = Number.isFinite(expiry) ? ` (weekly ${fmtReset(expiry, now)})` : "";
        emit(`already on the best account: ${c.bold(active.label)}${why}`, {
          switched: false,
          account: active.label,
          reason: "current-wins",
          weeklyResetsAt: Number.isFinite(expiry) ? expiry : null,
        });
        return 0;
      }
      const best = pickBest(pool, { ...everyone, currentAccountUuid: active?.accountUuid ?? null });
      if (!best) break;
      try {
        await performSwap(best);
      } catch (e) {
        rejected.add(best.accountUuid);
        if (e instanceof InvalidGrantError) {
          deadGrants.push(best.label);
          if (!json) console.error(c.red(deadGrantMessage(best)));
          continue;
        }
        if (isSkippableSwapError(e)) {
          if (!json) console.error(c.yellow(`${best.label}: ${errorMessage(e)} - skipped for this run`));
          continue;
        }
        throw e;
      }
      emit(`${c.green("↻")} switched to ${c.bold(best.label)}`, { switched: true, account: best.label, reason: "best" });
      return 0;
    }

    while (true) {
      const fresh = loadAccounts();
      const pool = fresh.accounts.filter((a) => !rejected.has(a.accountUuid));
      const earliest = pickEarliestReset(pool, everyoneIn(fresh.accounts));
      const reauth = fresh.accounts.filter((a) => a.needsReauth).map((a) => a.label);
      if (!earliest) {
        if (reauth.length > 0) {
          return fail(`no switchable account - reauth needed (run \`tokenmaxxing auth --all\`): ${reauth.join(", ")}`, {
            paint: c.yellow,
            extra: { reauthNeeded: reauth },
          });
        }
        const freshActive = fresh.accounts.find((a) => a.accountUuid === fresh.activeAccountUuid) ?? null;
        if (drifted && freshActive) return swapTo(freshActive, "drift-reconciled");
        emit(c.yellow("all accounts at their limit with unknown reset times (unparsed reset clocks? see tokenmaxxing.log) - staying put"), {
          switched: false,
          account: freshActive?.label ?? null,
          reason: "unknown-resets",
        });
        return 0;
      }
      const reauthNote = reauth.length ? ` - re-auth needed: ${reauth.join(", ")}` : "";
      const availableAt = earliest.availableAt > now ? earliest.availableAt : null;
      if (earliest.account.accountUuid === fresh.activeAccountUuid && !drifted) {
        const msg = availableAt == null
          ? `staying on ${c.bold(earliest.account.label)} - no usable switch target${reauthNote}`
          : `all accounts at limit - staying on ${c.bold(earliest.account.label)} (${fmtReset(availableAt, now)})${reauthNote}`;
        emit(c.yellow(msg), {
          switched: false,
          account: earliest.account.label,
          reason: availableAt == null ? "no-target" : "all-at-limit",
          availableAt,
          reauthNeeded: reauth,
        });
        return 0;
      }
      try {
        await performSwap(earliest.account);
      } catch (e) {
        rejected.add(earliest.account.accountUuid);
        if (e instanceof InvalidGrantError) {
          deadGrants.push(earliest.account.label);
          if (!json) console.error(c.red(deadGrantMessage(earliest.account)));
          continue;
        }
        if (isSkippableSwapError(e)) {
          if (!json) console.error(c.yellow(`${earliest.account.label}: ${errorMessage(e)} - skipped for this run`));
          continue;
        }
        throw e;
      }
      emit(`${c.green("↻")} switched to ${c.bold(earliest.account.label)}`, { switched: true, account: earliest.account.label, reason: "earliest-reset", availableAt, reauthNeeded: reauth });
      if (availableAt != null && !json) {
        console.log(c.yellow(`all accounts at limit - ${c.bold(earliest.account.label)} recovers soonest (${fmtReset(availableAt, now)})${reauthNote}`));
      }
      return 0;
    }
  });
}
