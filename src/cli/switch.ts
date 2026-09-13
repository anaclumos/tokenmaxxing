import { withLock } from "../lib/lock.ts";
import { codex } from "../lib/codex.ts";
import { loadAccounts, loadConfig } from "../lib/state.ts";
import { currentWins, pickBest, thresholdBars, weeklyExpiry, type PickCtx } from "../lib/picker.ts";
import { findAccount } from "./rename.ts";
import { log } from "../lib/log.ts";
import { c, emitError, emitJson, fmtReset } from "./render.ts";
import type { Account } from "../lib/types.ts";

const SWITCH_MARGIN = 1.2;

export async function cmdSwitch(selector?: string, json = false): Promise<number> {
  const p = codex;
  const deadGrants: string[] = [];
  const withDeadGrants = (report: Record<string, unknown>) => (deadGrants.length > 0 ? { ...report, deadGrants } : report);
  const emit = (text: string, report: Record<string, unknown>): void => {
    if (json) emitJson({ ok: true, ...withDeadGrants(report) });
    else console.log(text);
  };
  const fail = (message: string, opts: { paint?: (s: string) => string; extra?: Record<string, unknown> } = {}): number => {
    emitError({ json, message, paint: opts.paint, extra: withDeadGrants(opts.extra ?? {}) });
    return 1;
  };
  const reauthHint = (a: Account) => `run \`tokenmaxxing auth${p.flag} ${a.label}\``;
  const deadGrantMessage = (a: Account) => `${a.label}'s refresh token is dead - ${reauthHint(a)}`;
  const switched = (target: Account) => `${c.green("↻")} switched to ${c.bold(target.label)} (takes effect on the next codex start)`;

  const idx0 = loadAccounts(p.pool);
  if (idx0.accounts.length < 2) return fail(`need at least 2 accounts to switch - add one with \`tokenmaxxing add${p.flag}\``, { paint: c.yellow });
  const cfg = loadConfig();
  const now = Date.now();

  return withLock(p.pool.lockFile, async () => {
    const idx = loadAccounts(p.pool);
    const claimed = p.liveId();
    const drifted = claimed != null && claimed !== idx.activeId;
    const present = p.presence();

    const swapTo = async (target: Account, reason: string, extra: Record<string, unknown> = {}): Promise<number> => {
      try {
        await p.swap(target);
      } catch (e) {
        if (p.classifySwapError(e) === "dead-grant") {
          deadGrants.push(target.label);
          return fail(deadGrantMessage(target));
        }
        throw e;
      }
      log("switch.manual", { account: target.id.slice(0, 8), reason });
      emit(switched(target), { switched: true, account: target.label, reason, ...extra });
      return 0;
    };

    if (selector) {
      const target = findAccount(idx.accounts, selector);
      if (!target) return fail(`no account matches "${selector}"`);
      if (target.id === idx.activeId && !drifted) {
        emit(`already on ${c.bold(target.label)}`, { switched: false, account: target.label, reason: "already-on" });
        return 0;
      }
      if (target.id !== claimed && present.has(target.id)) {
        return fail(`${target.label} is running in a live ${p.name} session - swapping onto it would break that session's credential`);
      }
      if (target.needsReauth) return fail(`${target.label} needs re-auth - ${reauthHint(target)}`);
      return swapTo(target, "selected");
    }

    const everyone: PickCtx = { now, thresholds: thresholdBars(cfg), currentId: null, families: p.gatedFamilies(cfg), seats: null };
    const rejected = new Set<string>();
    const candidatesOf = (accounts: Account[]): Account[] => accounts.filter((a) => !rejected.has(a.id) && (a.id === claimed || !present.has(a.id)));
    while (true) {
      const cur = loadAccounts(p.pool);
      const pool = candidatesOf(cur.accounts);
      const active =
        (claimed != null ? cur.accounts.find((a) => a.id === claimed) : null) ??
        cur.accounts.find((a) => a.id === cur.activeId) ??
        null;
      if (active != null && currentWins(active, pool, everyone, SWITCH_MARGIN)) {
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
      const best = pickBest(pool, { ...everyone, currentId: active?.id ?? null });
      if (!best) break;
      try {
        await p.swap(best);
      } catch (e) {
        rejected.add(best.id);
        const kind = p.classifySwapError(e);
        if (kind === "dead-grant") {
          deadGrants.push(best.label);
          if (!json) console.error(c.red(deadGrantMessage(best)));
          continue;
        }
        if (kind === "skip") {
          if (!json) console.error(c.yellow(`${best.label}: ${e instanceof Error ? e.message : String(e)} - skipped for this run`));
          continue;
        }
        throw e;
      }
      log("switch.manual", { account: best.id.slice(0, 8), reason: "best" });
      emit(switched(best), { switched: true, account: best.label, reason: "best" });
      return 0;
    }

    const reauth = loadAccounts(p.pool).accounts.filter((a) => a.needsReauth).map((a) => a.label);
    return fail(`no usable ${p.name} switch target (all at their bars, unmeasured, or needing reauth)`, { paint: c.yellow, extra: { reauthNeeded: reauth } });
  });
}
