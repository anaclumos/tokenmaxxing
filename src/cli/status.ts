// `tokenmaxxing status`: accounts with 5h / weekly / per-model usage bars.
// Parked accounts are live-sampled in isolation (`claude -p /usage`); the active
// account is read off the free statusLine feed (usage.json) so we never poll its
// own busy token. A sample that fails falls back to the last-known values with a
// visible "(cached)" note - never a silent stale number. Fresh figures are
// persisted onto each account for the picker/switch logic.

import { loadAccounts, loadConfig, loadUsage, loadModelUsage, saveAccounts } from "../lib/state.ts";
import { readOAuthAccount } from "../lib/claudejson.ts";
import { probeActiveUsage, probeParkedUsage, type SampleOutcome } from "../lib/sample.ts";
import { withLock } from "../lib/lock.ts";
import { paths } from "../lib/paths.ts";
import { isExhausted, nextWeeklyReset } from "../lib/picker.ts";
import { bar, c, fmtAgo, fmtReset } from "./render.ts";
import type { FullUsage } from "../lib/usage.ts";
import type { UsageWindow } from "../lib/types.ts";

export async function cmdStatus(): Promise<number> {
  let idx = loadAccounts();
  const cfg = loadConfig();
  const now = Date.now();

  if (idx.accounts.length === 0) {
    console.log(c.dim("no accounts yet, run `tokenmaxxing init`"));
    return 0;
  }

  // Load, sample, and save entirely under the flock: parked refreshes must not
  // collide with an in-flight swap, and a save of an index loaded before a
  // concurrent swap would clobber the swap's activeAccountUuid.
  console.error(c.dim("sampling live usage..."));
  const outcomes = new Map<string, SampleOutcome>();
  await withLock(paths.lockFile, async () => {
    idx = loadAccounts();
    const live = loadUsage();
    const modelUsage = loadModelUsage();
    const activeOrg = readOAuthAccount()?.organizationUuid ?? null;
    await Promise.all(
      idx.accounts.map(async (a) => {
        const isActive = a.accountUuid === idx.activeAccountUuid && activeOrg === a.organizationUuid;
        // Active account: prefer the free statusLine push (usage.json) so we never
        // poll its own token, which is busy exactly when it matters. per-model
        // comes from model-usage.json (also statusLine-driven).
        const fromStatusLine: FullUsage | null =
          isActive && live && live.org === a.organizationUuid
            ? {
                session: live.fiveHour,
                weekAll: live.sevenDay,
                perModel: modelUsage && modelUsage.org === a.organizationUuid ? modelUsage.perModel : {},
              }
            : null;
        const outcome: SampleOutcome = fromStatusLine
          ? { ok: true, usage: fromStatusLine }
          : isActive
            ? await probeActiveUsage(a)
            : await probeParkedUsage(a);
        outcomes.set(a.accountUuid, outcome);
        if (!outcome.ok) return;
        a.lastUsage = { fiveHour: outcome.usage.session, sevenDay: outcome.usage.weekAll };
        if (Object.keys(outcome.usage.perModel).length > 0) a.lastPerModel = outcome.usage.perModel;
        // stamp when the figures were actually measured: the statusLine tee's
        // own write time for the push-fed active account, else the probe time.
        a.lastUsageAt = fromStatusLine && live ? live.ts : Date.now();
      }),
    );
    saveAccounts(idx);
  });

  console.log(c.dim(`threshold ${cfg.threshold}%  ·  ${idx.accounts.length} account(s)`));
  console.log();

  // A window whose cached reset has passed is empty again; weekly windows recur
  // on a fixed per-account anchor, so a stale weekly reset extrapolates forward.
  // Fresh samples pass through unchanged (their resets are in the future).
  const row = (name: string, w: UsageWindow, weekly: boolean) => {
    const passed = w.resetsAt != null && w.resetsAt <= now;
    const pct = passed ? 0 : w.usedPercentage;
    const resetsAt = weekly ? nextWeeklyReset(w.resetsAt, now) : passed ? null : w.resetsAt;
    console.log(`    ${name.padEnd(5)} ${bar(pct)}  ${c.dim(fmtReset(resetsAt, now))}`);
  };

  for (const a of idx.accounts) {
    const active = a.accountUuid === idx.activeAccountUuid;
    const outcome = outcomes.get(a.accountUuid);
    const failed = outcome ? !outcome.ok : false;
    // On a failed sample, fall back to the last-known values (with a note below).
    const usage = outcome?.ok ? outcome.usage : undefined;
    const aggregate = usage ? { fiveHour: usage.session, sevenDay: usage.weekAll } : a.lastUsage;
    const perModel = usage ? usage.perModel : a.lastPerModel;

    const marker = active ? c.green("●") : c.dim("○");
    const badges: string[] = [];
    if (active) badges.push(c.green("active"));
    if (a.needsReauth) badges.push(c.red("needs-reauth"));
    if (isExhausted(a, { now, threshold: cfg.threshold, currentAccountUuid: idx.activeAccountUuid, switchFamilies: cfg.policy.switchModels }))
      badges.push(c.yellow("exhausted"));

    console.log(`${marker} ${c.bold(a.label || a.email)} ${badges.join(" ")}`);
    if (aggregate) {
      row("5h", aggregate.fiveHour, false);
      row("week", aggregate.sevenDay, true);
    }
    if (perModel) for (const [name, w] of Object.entries(perModel)) row(name, w, true);
    if (failed && outcome && !outcome.ok) {
      const cached = aggregate || perModel ? `cached${a.lastUsageAt != null ? ` ${fmtAgo(a.lastUsageAt, now)}` : ""} · ` : "";
      console.log(`    ${c.yellow(`${cached}live sample failed`)}: ${c.dim(outcome.reason)}`);
    }
    console.log();
  }
  return 0;
}
