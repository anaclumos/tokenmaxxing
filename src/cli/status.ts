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

import { sortBy } from "es-toolkit";
import { loadAccounts, loadConfig, loadUsage, loadModelUsage, saveAccounts } from "../lib/state.ts";
import { readOAuthAccount } from "../lib/claudejson.ts";
import { ensureLiveTokenFresh, probeActiveUsage, probeParkedUsage, type SampleOutcome } from "../lib/sample.ts";
import { withLock } from "../lib/lock.ts";
import { codexPaths, paths } from "../lib/paths.ts";
import { earliestReset, effectiveBars, isExhausted, nextWeeklyReset } from "../lib/picker.ts";
import { loadCodexAccounts, saveCodexAccounts } from "../lib/codexstate.ts";
import { liveCodexAccountId, sampleCodexAccount, type CodexSampleOutcome } from "../lib/codexsample.ts";
import { isCodexExhausted } from "../lib/codexpick.ts";
import { codexLimitLabel, isSessionWindow } from "../lib/codexusage.ts";
import { bar, c, claudeTierLabel, count, fmtAgo, fmtReset } from "./render.ts";
import type { FullUsage } from "../lib/usage.ts";
import type { Account, Config, CodexWindow, UsageWindow } from "../lib/types.ts";

/** `preRender` runs after sampling, right before the first output line: `watch`
 *  keeps the previous frame on screen through the multi-second sample and
 *  clears only when the fresh frame is ready to paint (watch(1) semantics). */
export async function cmdStatus(force = false, preRender?: () => void): Promise<number> {
  let idx = loadAccounts();
  const cfg = loadConfig();
  const now = Date.now();

  // A window whose cached reset has passed is empty again; weekly windows recur
  // on a fixed per-account anchor, so a stale weekly reset extrapolates forward.
  // Fresh samples pass through unchanged (their resets are in the future).
  const row = (name: string, w: UsageWindow, weekly: boolean) => {
    const passed = w.resetsAt != null && w.resetsAt <= now;
    const pct = passed ? 0 : w.usedPercentage;
    const resetsAt = weekly ? nextWeeklyReset(w.resetsAt, now) : passed ? null : w.resetsAt;
    console.log(`    ${name.padEnd(5)} ${bar(pct)}  ${c.dim(fmtReset(resetsAt, now))}`);
  };

  if (idx.accounts.length === 0) {
    // A codex-only pool is a documented standalone flow: the empty-claude
    // early return must still render it, and only a fully empty install gets
    // the init hint (closing-review catch: bare `xx` claimed "no accounts"
    // over a populated codex pool and pointed at the wrong init).
    if (loadCodexAccounts().accounts.length > 0) {
      console.log(c.dim("no claude accounts (run `tokenmaxxing init` to pool claude too)"));
      console.log();
      await renderCodexSection({ cfg, now, row });
      return 0;
    }
    console.log(c.dim("no accounts yet, run `tokenmaxxing init` (or `tokenmaxxing init --codex`)"));
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
    const probeOne = async (a: Account) => {
        // Active = the org claude's own oauthAccount names, NOT the stored
        // label conjunction: after a manual /login the label lags, and routing
        // the genuinely-live account through the parked prober would refresh
        // its stale parked grant and could flag a healthy account needs-reauth.
        // probeActiveUsage's own roles check still fail-fasts on residual drift.
        const isActive = activeOrg != null && activeOrg === a.organizationUuid;
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
          // so it serves ONLY as the fallback for the fail-silent `/usage`
          // case (the probe got past every guard and claude printed no limit
          // lines). Any other failure - identity mismatch, dead refresh, a
          // refused ping - must stay VISIBLE: the old unconditional fallback
          // masked pre-ping failures as healthy tee data, silently skipping
          // the ping with no warning (closing-review catch).
          outcome = isActive ? await probeActiveUsage(a, { ping: true }) : await probeParkedUsage(a, { ping: true });
          if (!outcome.ok && fromStatusLine && outcome.reason.includes("no limit data")) {
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
        // stamp when the figures were actually measured: the statusLine tee's
        // own write time for the push-fed active account, else the probe time.
        a.lastUsageAt = viaTee && live ? live.ts : Date.now();
        if (Object.keys(outcome.usage.perModel).length > 0) {
          a.lastPerModel = outcome.usage.perModel;
          // via the tee, the per-model rows come from model-usage.json whose
          // own sample time may be DAYS older than the aggregate tee - dating
          // them by the tee's timestamp inflated the null-reset self-bound
          // (closing-review catch). A fresh probe's rows date by the probe.
          a.lastPerModelAt = viaTee && modelUsage ? (modelUsage.sampledAt ?? modelUsage.ts) : a.lastUsageAt;
        }
    };
    // The ACTIVE probe runs FIRST, alone: it refreshes an expired live access
    // token under claude's refresh lock, and every parked probe's fail-closed
    // live-owner check reads that same live token - run concurrently they
    // raced the refresh and, after the machine idled past the token lifetime,
    // every parked sample 401'd on the first `xx status` (closing-review
    // catch). Parked probes then run concurrently as before.
    const activeAccount = idx.accounts.find((a) => activeOrg != null && activeOrg === a.organizationUuid) ?? null;
    if (activeAccount) await probeOne(activeAccount);
    // even when the active account's usage came from the TEE (no active
    // probe, no refresh side effect), the parked probes still need a fresh
    // live token for their fail-closed live-owner checks (cubic review
    // catch, PR #35). A dead live grant is deliberately not fatal here: each
    // parked probe reports its own honest failure reason.
    try {
      await ensureLiveTokenFresh();
    } catch {
      // per-account guards surface the failure per probe
    }
    await Promise.all(idx.accounts.filter((a) => a !== activeAccount).map(probeOne));
    saveAccounts(idx);
  });

  preRender?.();
  console.log(c.dim(`thresholds 5h ${cfg.thresholds.session}% weekly ${cfg.thresholds.weekly}%  (${count({ n: idx.accounts.length, noun: "claude account" })})`));
  console.log();

  // Display order (user decision 2026-07-18): earliest upcoming reset first
  // (5h or extrapolated weekly, from the just-refreshed samples), needs-reauth
  // last; the ● marker identifies the active account wherever it sorts.
  const displayAccounts = sortBy(idx.accounts, [(a) => (a.needsReauth ? 1 : 0), (a) => earliestReset(a, now)]);
  // The marker matches the probe routing above: active = the org claude's own
  // oauthAccount names (the swap label can lag after a manual /login).
  const displayActiveOrg = readOAuthAccount()?.organizationUuid ?? null;
  for (const a of displayAccounts) {
    const active = displayActiveOrg != null && a.organizationUuid === displayActiveOrg;
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
  // Same display order as the claude pool: earliest upcoming reset first
  // across every cached window, needs-reauth last.
  const displayAccounts = sortBy(index.accounts, [
    (a) => (a.needsReauth ? 1 : 0),
    (a) => {
      const windows = [...(a.lastUsage?.aggregate ?? []), ...Object.values(a.lastUsage?.perLimit ?? {}).flat()];
      const resets = windows.flatMap((w) => (w.resetsAt != null && w.resetsAt > now ? [w.resetsAt] : []));
      return resets.length > 0 ? Math.min(...resets) : Number.POSITIVE_INFINITY;
    },
  ]);
  for (const account of displayAccounts) {
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
