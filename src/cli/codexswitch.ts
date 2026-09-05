import { withLock } from "../lib/lock.ts";
import { codexPaths } from "../lib/paths.ts";
import { loadConfig } from "../lib/state.ts";
import { loadCodexAccounts } from "../lib/codexstate.ts";
import { codexCurrentWins, pickBestCodex } from "../lib/codexpick.ts";
import { performCodexSwap } from "../lib/codexswap.ts";
import { CodexInvalidGrantError } from "../lib/codexoauth.ts";
import { liveCodexAccountId } from "../lib/codexsample.ts";
import { presentCodexAccountIds, targetableCodexAccounts } from "../lib/codexpresence.ts";
import { terminalBars } from "../lib/picker.ts";
import { c, emitError, emitJson } from "./render.ts";

export async function cmdCodexSwitch(sel?: string, json = false): Promise<number> {
  const deadGrants: string[] = [];
  const withDeadGrants = (report: Record<string, unknown>) => (deadGrants.length > 0 ? { ...report, deadGrants } : report);
  const emit = (text: string, report: Record<string, unknown>): void => {
    if (json) emitJson({ ok: true, ...withDeadGrants(report) });
    else console.log(text);
  };
  const fail = (message: string, opts: { paint?: (s: string) => string; notes?: string[]; extra?: Record<string, unknown> } = {}): number => {
    emitError({ json, message, paint: opts.paint, notes: opts.notes, extra: withDeadGrants(opts.extra ?? {}) });
    return 1;
  };
  const deadGrantMessage = (label: string) => `${label}'s refresh token is dead - re-add it with \`tokenmaxxing add --codex\``;
  const cfg = loadConfig();
  const bars = terminalBars(cfg);
  const now = Date.now();

  return withLock(codexPaths.lockFile, async () => {
    const index = loadCodexAccounts();
    if (index.accounts.length === 0) {
      if (json) emitJson({ ok: false, error: "no codex accounts yet - run `tokenmaxxing init --codex`" });
      else console.log(c.dim("no codex accounts yet - run `tokenmaxxing init --codex`"));
      return 1;
    }
    const currentId = liveCodexAccountId();

    if (sel) {
      const target = index.accounts.find(
        (account) => account.label === sel || account.email === sel || account.accountId.startsWith(sel),
      );
      if (!target) {
        return fail(`no codex account matches "${sel}"`, {
          notes: index.accounts.map((account) => `  ${account.label} (${account.accountId.slice(0, 8)})`),
          extra: { accounts: index.accounts.map((account) => account.label) },
        });
      }
      if (target.accountId === currentId) {
        emit(`already on ${c.bold(target.label)}`, { switched: false, account: target.label, reason: "already-on" });
        return 0;
      }
      if (presentCodexAccountIds().has(target.accountId)) {
        return fail(`${target.label} is running in a live codex session - swapping onto it would break that session's credential`);
      }
      if (target.needsReauth) {
        return fail(`${target.label} needs re-auth - run \`codex login\` in an isolated home and \`tokenmaxxing add --codex\``);
      }
      try {
        await performCodexSwap({ target });
      } catch (e) {
        if (e instanceof CodexInvalidGrantError) {
          deadGrants.push(target.label);
          return fail(deadGrantMessage(target.label));
        }
        throw e;
      }
      emit(`${c.green("✓")} switched codex to ${c.bold(target.label)} (takes effect on the next codex start)`, {
        switched: true,
        account: target.label,
        reason: "selected",
      });
      return 0;
    }

    while (true) {
      const current = loadCodexAccounts();
      const candidates = targetableCodexAccounts({ accounts: current.accounts, activeAccountId: currentId });
      const active = candidates.find((account) => account.accountId === currentId) ?? null;
      if (codexCurrentWins({ active, accounts: candidates, thresholds: bars, now })) {
        emit(`already on the best codex account: ${c.bold(active?.label ?? "?")}`, {
          switched: false,
          account: active?.label ?? null,
          reason: "current-wins",
        });
        return 0;
      }
      const best = pickBestCodex({ accounts: candidates, thresholds: bars, now, currentAccountId: currentId });
      if (!best) {
        const message = "no usable codex switch target (all at their bars, unmeasured, or needing reauth)";
        const reauthNeeded = current.accounts.filter((account) => account.needsReauth).map((account) => account.label);
        if (json) return fail(message, { extra: { reauthNeeded } });
        console.log(c.yellow(message));
        return 1;
      }
      try {
        await performCodexSwap({ target: best });
      } catch (e) {
        if (e instanceof CodexInvalidGrantError) {
          deadGrants.push(best.label);
          if (!json) console.error(c.red(deadGrantMessage(best.label)));
          continue;
        }
        throw e;
      }
      emit(`${c.green("✓")} switched codex to ${c.bold(best.label)} (takes effect on the next codex start)`, {
        switched: true,
        account: best.label,
        reason: "best",
      });
      return 0;
    }
  });
}
