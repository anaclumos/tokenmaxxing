// `tokenmaxxing status`: accounts with 5h / weekly / per-model usage bars.
// Parked accounts are live-sampled in isolation (`claude -p /usage`); the active
// account is read off the free statusLine feed (usage.json) so we never poll its
// own busy token. A sample that fails falls back to the last-known values with a
// visible "(cached)" note - never a silent stale number. Fresh figures are
// persisted onto each account for the picker/switch logic.
//
// `--force` additionally PINGS every account (one minimal haiku request each)
// before sampling, so every account's 5h session window starts ticking NOW
// instead of lying dormant until first real use, and every bar is a live probe
// taken after the ping. The active account still prefers the tee only as a
// fallback: its own `/usage` fail-silents exactly when a live session is
// running it, and that session's tee is fresher than any cache.

import { loadAccounts, loadConfig, loadUsage, loadModelUsage, saveAccounts } from "../lib/state.ts";
import { readOAuthAccount } from "../lib/claudejson.ts";
import { probeActiveUsage, probeParkedUsage, type SampleOutcome } from "../lib/sample.ts";
import { withLock } from "../lib/lock.ts";
import { codexPaths, paths } from "../lib/paths.ts";
import { effectiveBars, isExhausted, nextWeeklyReset } from "../lib/picker.ts";
import { loadCodexAccounts, saveCodexAccounts } from "../lib/codexstate.ts";
import { liveCodexAccountId, sampleCodexAccount, type CodexSampleOutcome } from "../lib/codexsample.ts";
import { isCodexExhausted } from "../lib/codexpick.ts";
import { codexLimitLabel, isSessionWindow } from "../lib/codexusage.ts";
import { bar, c, claudeTierLabel, count, fmtAgo, fmtReset } from "./render.ts";
import type { FullUsage } from "../lib/usage.ts";
import type { Config, CodexWindow, UsageWindow } from "../lib/types.ts";

/** `preRender` runs after sampling, right before the first output line: `watch`
 *  keeps the previous frame on screen through the multi-second sample and
 *  clears only when the fresh frame is ready to paint (watch(1) semantics). */
export async function cmdStatus(force = false, preRender?: () => void): Promise<number> {
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
  console.error(c.dim(force ? "pinging every account (starts each 5h session timer) + sampling live usage..." : "sampling live usage..."));
  const outcomes = new Map<string, SampleOutcome>();
  await withLock(paths.lockFile, async () => {
    idx = loadAccounts();
    const live = loadUsage();
    const modelUsage = loadModelUsage();
    const liveOAuth = readOAuthAccount();
    const activeOrg = liveOAuth?.organizationUuid ?? null;
    await Promise.all(
      idx.accounts.map(async (a) => {
        const isActive = a.accountUuid === idx.activeAccountUuid && activeOrg === a.organizationUuid;
        // The tee path never opens the credential blob, so the active account's
        // tier comes from the live oauthAccount instead - it names this very org
        // (uuid-matched above), so the tier is attributed to its own identity.
        if (isActive && liveOAuth?.organizationRateLimitTier != null) a.rateLimitTier = liveOAuth.organizationRateLimitTier;
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
        let viaTee = false;
        let outcome: SampleOutcome;
        if (force) {
          // Force: ping + live probe for everyone. The tee predates the ping,
          // so it serves only as the active account's fallback when its own
          // `/usage` fail-silents (a running session's tee is still fresh).
          outcome = isActive ? await probeActiveUsage(a, { ping: true }) : await probeParkedUsage(a, { ping: true });
          if (!outcome.ok && fromStatusLine) {
            const failed = outcome;
            outcome = { ok: true, usage: fromStatusLine };
            if (failed.pingError != null) outcome.pingError = failed.pingError;
            viaTee = true;
          }
        } else {
          viaTee = fromStatusLine != null;
          outcome = fromStatusLine
            ? { ok: true, usage: fromStatusLine }
            : isActive
              ? await probeActiveUsage(a)
              : await probeParkedUsage(a);
        }
        outcomes.set(a.accountUuid, outcome);
        if (!outcome.ok) return;
        a.lastUsage = { fiveHour: outcome.usage.session, sevenDay: outcome.usage.weekAll };
        if (Object.keys(outcome.usage.perModel).length > 0) a.lastPerModel = outcome.usage.perModel;
        // stamp when the figures were actually measured: the statusLine tee's
        // own write time for the push-fed active account, else the probe time.
        a.lastUsageAt = viaTee && live ? live.ts : Date.now();
      }),
    );
    saveAccounts(idx);
  });

  preRender?.();
  console.log(c.dim(`thresholds 5h ${cfg.thresholds.session}% weekly ${cfg.thresholds.weekly}%  (${count({ n: idx.accounts.length, noun: "claude account" })})`));
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
    if (isExhausted(a, { now, thresholds: effectiveBars(cfg), currentAccountUuid: idx.activeAccountUuid, switchFamilies: cfg.policy.switchModels }))
      badges.push(c.yellow("exhausted"));

    const tier = claudeTierLabel(a);
    console.log(`${marker} ${c.bold(a.label || a.email)}${tier ? ` ${c.dim(tier)}` : ""}${badges.length ? ` ${badges.join(" ")}` : ""}`);
    // Chart label convention (user rule 2026-07-17): everything lowercase,
    // model names short ("fable", "spark").
    if (aggregate) {
      row("5h", aggregate.fiveHour, false);
      row("week", aggregate.sevenDay, true);
    }
    if (perModel) for (const [name, w] of Object.entries(perModel)) row(name.toLowerCase(), w, true);
    if (failed && outcome && !outcome.ok) {
      const cached = aggregate || perModel ? `cached${a.lastUsageAt != null ? ` ${fmtAgo(a.lastUsageAt, now)}` : ""}, ` : "";
      console.log(`    ${c.yellow(`${cached}live sample failed`)}: ${c.dim(outcome.reason)}`);
    }
    if (outcome?.pingError != null) {
      console.log(`    ${c.yellow("ping failed (5h timer may not have started)")}: ${c.dim(outcome.pingError)}`);
    }
    // A successful ping ALWAYS opens the 5h window (live-verified 2026-07-16),
    // but the server's usage feed reflects it with a lag of up to a few
    // minutes, so a probe taken seconds later can still show a dormant window.
    // Say so rather than looking like the ping did nothing.
    if (force && outcome?.ok && outcome.pingError == null && aggregate && aggregate.fiveHour.resetsAt == null) {
      console.log(`    ${c.dim("pinged - 5h timer started this run; the usage feed lags, re-run status shortly for the fresh window")}`);
    }
    console.log();
  }

  await renderCodexSection({ cfg, now, row });
  return 0;
}

/** The codex pool, appended when it is non-empty. Every account samples via
 *  the free usage GET (nothing metered, no window started): the live account
 *  through the live auth.json, parked accounts through their parked blobs. */
async function renderCodexSection(input: {
  cfg: Config;
  now: number;
  row: (name: string, w: UsageWindow, weekly: boolean) => void;
}): Promise<void> {
  const { cfg, now, row } = input;
  let index = loadCodexAccounts();
  if (index.accounts.length === 0) return;

  console.error(c.dim("sampling codex usage..."));
  const outcomes = new Map<string, CodexSampleOutcome>();
  let liveId: string | null = null;
  await withLock(codexPaths.lockFile, async () => {
    index = loadCodexAccounts();
    liveId = liveCodexAccountId();
    await Promise.all(
      index.accounts.map(async (account) => {
        const outcome = await sampleCodexAccount({ account, liveAccountId: liveId, now });
        outcomes.set(account.accountId, outcome);
        if (outcome.ok) {
          account.lastUsage = { aggregate: outcome.usage.aggregate, perLimit: outcome.usage.perLimit };
          account.lastUsageAt = Date.now();
          if (outcome.usage.email != null) account.email = outcome.usage.email;
          if (outcome.usage.planType != null) account.planType = outcome.usage.planType;
        } else if (outcome.deadGrant) {
          account.needsReauth = true;
        }
      }),
    );
    saveCodexAccounts({ index });
  });

  console.log(c.dim(`codex  (${count({ n: index.accounts.length, noun: "account" })})`));
  console.log();
  const windowLabel = (window: CodexWindow) =>
    isSessionWindow({ window }) ? `${Math.round((window.windowSeconds ?? 0) / 3600)}h` : "week";
  for (const account of index.accounts) {
    const active = account.accountId === liveId;
    const marker = active ? c.green("●") : c.dim("○");
    const badges: string[] = [];
    if (active) badges.push(c.green("active"));
    if (account.needsReauth) badges.push(c.red("needs-reauth"));
    if (isCodexExhausted({ account, thresholds: effectiveBars(cfg), now })) badges.push(c.yellow("exhausted"));
    console.log(`${marker} ${c.bold(account.label)}${account.planType ? ` ${c.dim(account.planType)}` : ""}${badges.length ? ` ${badges.join(" ")}` : ""}`);

    const usage = account.lastUsage;
    if (usage) {
      for (const window of usage.aggregate) row(windowLabel(window), window, !isSessionWindow({ window }));
      for (const [name, windows] of Object.entries(usage.perLimit)) {
        for (const window of windows) row(codexLimitLabel({ limitName: name }), window, !isSessionWindow({ window }));
      }
    }
    const outcome = outcomes.get(account.accountId);
    if (outcome && !outcome.ok) {
      const cached = usage ? `cached${account.lastUsageAt != null ? ` ${fmtAgo(account.lastUsageAt, now)}` : ""}, ` : "";
      console.log(`    ${c.yellow(`${cached}live sample failed`)}: ${c.dim(outcome.reason)}`);
    }
    console.log();
  }
}
