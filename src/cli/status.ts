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

export async function cmdStatus(force = false, preRender?: () => void): Promise<number> {
  let idx = loadAccounts();
  const cfg = loadConfig();
  const now = Date.now();

  const row = (name: string, w: UsageWindow, weekly: boolean) => {
    const passed = w.resetsAt != null && w.resetsAt <= now;
    const pct = passed ? 0 : w.usedPercentage;
    const resetsAt = weekly ? nextWeeklyReset(w.resetsAt, now) : passed ? null : w.resetsAt;
    console.log(`    ${name.padEnd(5)} ${bar(pct)}  ${c.dim(fmtReset(resetsAt, now))}`);
  };

  if (idx.accounts.length === 0) {
    if (loadCodexAccounts().accounts.length > 0) {
      console.log(c.dim("no claude accounts (run `tokenmaxxing init` to pool claude too)"));
      console.log();
      await renderCodexSection({ cfg, now, row });
      return 0;
    }
    console.log(c.dim("no accounts yet, run `tokenmaxxing init` (or `tokenmaxxing init --codex`)"));
    return 0;
  }

  console.error(c.dim(force ? "pinging every account (starts each 5h session timer) + sampling live usage..." : "sampling live usage..."));
  const outcomes = new Map<string, SampleOutcome>();
  await withLock(paths.lockFile, async () => {
    idx = loadAccounts();
    const live = loadUsage();
    const modelUsage = loadModelUsage();
    const liveOAuth = readOAuthAccount();
    const activeOrg = liveOAuth?.organizationUuid ?? null;
    const probeOne = async (a: Account) => {
        const isActive = activeOrg != null && activeOrg === a.organizationUuid;
        if (isActive && liveOAuth?.organizationRateLimitTier != null) a.rateLimitTier = liveOAuth.organizationRateLimitTier;
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
        a.lastUsageAt = viaTee && live ? live.ts : Date.now();
        if (Object.keys(outcome.usage.perModel).length > 0) {
          a.lastPerModel = outcome.usage.perModel;
          a.lastPerModelAt = viaTee && modelUsage ? (modelUsage.sampledAt ?? modelUsage.ts) : a.lastUsageAt;
        }
    };
    const activeAccount = idx.accounts.find((a) => activeOrg != null && activeOrg === a.organizationUuid) ?? null;
    if (activeAccount) await probeOne(activeAccount);
    try {
      await ensureLiveTokenFresh();
    } catch {
    }
    await Promise.all(idx.accounts.filter((a) => a !== activeAccount).map(probeOne));
    saveAccounts(idx);
  });

  preRender?.();
  console.log(c.dim(`thresholds 5h ${cfg.thresholds.session}% weekly ${cfg.thresholds.weekly}%  (${count({ n: idx.accounts.length, noun: "claude account" })})`));
  console.log();

  const displayAccounts = sortBy(idx.accounts, [(a) => (a.needsReauth ? 1 : 0), (a) => earliestReset(a, now)]);
  const displayActiveOrg = readOAuthAccount()?.organizationUuid ?? null;
  for (const a of displayAccounts) {
    const active = displayActiveOrg != null && a.organizationUuid === displayActiveOrg;
    const outcome = outcomes.get(a.accountUuid);
    const failed = outcome ? !outcome.ok : false;
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
    if (force && outcome?.ok && outcome.pingError == null && aggregate && aggregate.fiveHour.resetsAt == null) {
      console.log(`    ${c.dim("pinged - 5h timer started this run; the usage feed lags, re-run status shortly for the fresh window")}`);
    }
    console.log();
  }

  await renderCodexSection({ cfg, now, row });
  return 0;
}

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
