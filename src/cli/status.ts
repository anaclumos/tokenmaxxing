import { sampleSize, sortBy } from "es-toolkit";
import { z } from "zod";
import { loadAccounts, loadConfig, loadUsage, loadUsageSnapshot, loadModelUsage, saveAccounts } from "../lib/state.ts";
import { readOAuthAccount } from "../lib/claudejson.ts";
import { ensureLiveTokenFresh, probeActiveUsage, probeParkedUsage, type SampleOutcome } from "../lib/sample.ts";
import { withLock } from "../lib/lock.ts";
import { codexPaths, paths } from "../lib/paths.ts";
import { earliestReset, effectiveBars, isExhausted, nextWeeklyReset, terminalBars } from "../lib/picker.ts";
import { loadCodexAccounts, saveCodexAccounts } from "../lib/codexstate.ts";
import { liveCodexAccountId, sampleCodexAccount, type CodexSampleOutcome } from "../lib/codexsample.ts";
import { isCodexExhausted } from "../lib/codexpick.ts";
import { codexLimitLabel, isSessionWindow } from "../lib/codexusage.ts";
import { bar, c, claudeTierLabel, count, emitJson, fmtAgo, fmtReset } from "./render.ts";
import { gatedFamilies, type FullUsage } from "../lib/usage.ts";
import { ThresholdsSchema, UsageWindowSchema, type Account, type CodexWindow, type Config, type UsageWindow } from "../lib/types.ts";

const SampleReportSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), source: z.enum(["statusline", "probe"]) }),
  z.object({ ok: z.literal(false), reason: z.string() }),
]);

const ClaudeStatusAccountSchema = z.object({
  label: z.string(),
  email: z.string(),
  accountUuid: z.string(),
  organizationUuid: z.string(),
  tier: z.string().nullable(),
  active: z.boolean(),
  needsReauth: z.boolean(),
  exhausted: z.boolean(),
  usage: z.object({ fiveHour: UsageWindowSchema, week: UsageWindowSchema }).nullable(),
  perModel: z.record(z.string(), UsageWindowSchema),
  usageAt: z.number().nullable(),
  sample: SampleReportSchema,
  pingError: z.string().nullable(),
  pingRejected: z.boolean(),
  pinged: z.boolean(),
});
type ClaudeStatusAccount = z.infer<typeof ClaudeStatusAccountSchema>;

const CodexWindowReportSchema = UsageWindowSchema.extend({ windowSeconds: z.number().nullable() });

const CodexStatusAccountSchema = z.object({
  label: z.string(),
  email: z.string().nullable(),
  accountId: z.string(),
  planType: z.string().nullable(),
  active: z.boolean(),
  needsReauth: z.boolean(),
  exhausted: z.boolean(),
  usage: z
    .object({
      aggregate: z.array(CodexWindowReportSchema),
      perLimit: z.record(z.string(), z.array(CodexWindowReportSchema)),
    })
    .nullable(),
  usageAt: z.number().nullable(),
  sample: SampleReportSchema,
});
type CodexStatusAccount = z.infer<typeof CodexStatusAccountSchema>;

const StatusReportSchema = z.object({
  now: z.number(),
  claude: z.object({
    thresholds: z.object({ session: z.array(z.number()), weekly: z.number() }),
    bars: ThresholdsSchema,
    projectionMargin: z.number(),
    accounts: z.array(ClaudeStatusAccountSchema),
  }),
  codex: z.object({
    bars: ThresholdsSchema,
    accounts: z.array(CodexStatusAccountSchema),
  }),
});
export type StatusReport = z.infer<typeof StatusReportSchema>;

function currentWindow(w: UsageWindow, weekly: boolean, now: number): UsageWindow {
  const passed = w.resetsAt != null && w.resetsAt <= now;
  return {
    usedPercentage: passed ? 0 : w.usedPercentage,
    resetsAt: weekly ? nextWeeklyReset(w.resetsAt, now) : passed ? null : w.resetsAt,
  };
}

function currentCodexWindow(w: CodexWindow, now: number): CodexWindow {
  return { ...currentWindow(w, !isSessionWindow({ window: w }), now), windowSeconds: w.windowSeconds };
}

function pickForPing(accounts: Account[], pingCount: number | undefined): Account[] {
  if (pingCount == null) return accounts;
  const usable = accounts.filter((a) => a.needsReauth !== true);
  return sampleSize(usable, Math.min(pingCount, usable.length));
}

function progressNote(input: { ping: boolean; pingCount: number | undefined; picked: Account[]; total: number }): string {
  const { ping, pingCount, picked, total } = input;
  if (!ping) return "sampling live usage...";
  if (pingCount == null) return "pinging every account (starts each 5h session timer) + sampling live usage...";
  if (picked.length === 0) return "no account to ping (every account needs reauth), sampling live usage...";
  return `pinging ${picked.length} of ${count({ n: total, noun: "account" })} (${picked.map((a) => a.label || a.email).join(", ")}) so their 5h session timers start now + sampling live usage...`;
}

async function collectClaude(input: { cfg: Config; ping: boolean; pingCount: number | undefined; now: number }): Promise<StatusReport["claude"]> {
  const { cfg, ping, pingCount, now } = input;
  let idx = loadAccounts();
  const samples = new Map<string, { outcome: SampleOutcome; viaTee: boolean }>();
  const picked = ping ? pickForPing(idx.accounts, pingCount) : [];
  const pings = new Set(picked.map((a) => a.accountUuid));
  if (idx.accounts.length > 0) {
    console.error(c.dim(progressNote({ ping, pingCount, picked, total: idx.accounts.length })));
    await withLock(paths.lockFile, async () => {
      idx = loadAccounts();
      const tee = loadUsageSnapshot();
      const live = tee?.state ?? null;
      const teeAt = tee?.at ?? null;
      const modelUsage = loadModelUsage();
      const liveOAuth = readOAuthAccount();
      const activeOrg = liveOAuth?.organizationUuid ?? null;
      const probeOne = async (a: Account) => {
        const isActive = activeOrg != null && activeOrg === a.organizationUuid;
        if (isActive && liveOAuth?.organizationRateLimitTier != null) a.rateLimitTier = liveOAuth.organizationRateLimitTier;
        const teeCurrent = teeAt != null && (a.lastUsageAt == null || teeAt >= a.lastUsageAt);
        const fromStatusLine: FullUsage | null =
          isActive && live && teeCurrent && live.org === a.organizationUuid
            ? {
                session: live.fiveHour,
                weekAll: live.sevenDay,
                perModel: modelUsage && modelUsage.org === a.organizationUuid ? modelUsage.perModel : {},
              }
            : null;
        let viaTee = false;
        let outcome: SampleOutcome;
        if (pings.has(a.accountUuid)) {
          outcome = isActive ? await probeActiveUsage(a, { ping: true }) : await probeParkedUsage(a, { ping: true });
          if (!outcome.ok && fromStatusLine && outcome.reason.includes("no limit data")) {
            const failed = outcome;
            outcome = { ok: true, usage: fromStatusLine };
            if (failed.pingError != null) {
              outcome.pingError = failed.pingError;
              outcome.pingRejected = failed.pingRejected;
            }
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
        samples.set(a.accountUuid, { outcome, viaTee });
        if (!outcome.ok) return;
        a.lastUsage = { fiveHour: outcome.usage.session, sevenDay: outcome.usage.weekAll };
        a.lastUsageAt = viaTee && teeAt != null ? teeAt : Date.now();
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
  }

  const families = gatedFamilies(loadUsage()?.model ?? null, cfg.policy.switchModels);
  const bars = effectiveBars(cfg, { accounts: idx.accounts, now, switchFamilies: families });
  const activeOrg = readOAuthAccount()?.organizationUuid ?? null;
  const ordered = sortBy(idx.accounts, [(a) => (a.needsReauth ? 1 : 0), (a) => earliestReset(a, now)]);
  const accounts = ordered.map((a): ClaudeStatusAccount => {
    const sampled = samples.get(a.accountUuid) ?? { outcome: { ok: false, reason: "not sampled" }, viaTee: false };
    const usage = sampled.outcome.ok ? sampled.outcome.usage : undefined;
    const aggregate = usage ? { fiveHour: usage.session, sevenDay: usage.weekAll } : a.lastUsage;
    const perModel = usage ? usage.perModel : (a.lastPerModel ?? {});
    return {
      label: a.label,
      email: a.email,
      accountUuid: a.accountUuid,
      organizationUuid: a.organizationUuid,
      tier: claudeTierLabel(a),
      active: activeOrg != null && a.organizationUuid === activeOrg,
      needsReauth: a.needsReauth === true,
      exhausted: isExhausted(a, { now, thresholds: bars, currentAccountUuid: idx.activeAccountUuid, switchFamilies: families }),
      usage: aggregate ? { fiveHour: currentWindow(aggregate.fiveHour, false, now), week: currentWindow(aggregate.sevenDay, true, now) } : null,
      perModel: Object.fromEntries(Object.entries(perModel).map(([name, w]) => [name, currentWindow(w, true, now)])),
      usageAt: a.lastUsageAt ?? null,
      sample: sampled.outcome.ok ? { ok: true, source: sampled.viaTee ? "statusline" : "probe" } : { ok: false, reason: sampled.outcome.reason },
      pingError: sampled.outcome.pingError ?? null,
      pingRejected: sampled.outcome.pingRejected === true,
      pinged: pings.has(a.accountUuid) && sampled.outcome.ok && sampled.outcome.pingError == null && aggregate != null && aggregate.fiveHour.resetsAt == null,
    };
  });
  return {
    thresholds: { session: cfg.thresholds.session, weekly: cfg.thresholds.weekly },
    bars,
    projectionMargin: cfg.policy.projectionMargin,
    accounts,
  };
}

async function collectCodex(input: { cfg: Config; now: number }): Promise<StatusReport["codex"]> {
  const { cfg, now } = input;
  const bars = terminalBars(cfg);
  let index = loadCodexAccounts();
  if (index.accounts.length === 0) return { bars, accounts: [] };

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

  const ordered = sortBy(index.accounts, [
    (a) => (a.needsReauth ? 1 : 0),
    (a) => {
      const windows = [...(a.lastUsage?.aggregate ?? []), ...Object.values(a.lastUsage?.perLimit ?? {}).flat()];
      const resets = windows.flatMap((w) => (w.resetsAt != null && w.resetsAt > now ? [w.resetsAt] : []));
      return resets.length > 0 ? Math.min(...resets) : Number.POSITIVE_INFINITY;
    },
  ]);
  const accounts = ordered.map((account): CodexStatusAccount => {
    const outcome = outcomes.get(account.accountId) ?? { ok: false, reason: "not sampled", deadGrant: false };
    const usage = account.lastUsage;
    return {
      label: account.label,
      email: account.email,
      accountId: account.accountId,
      planType: account.planType,
      active: account.accountId === liveId,
      needsReauth: account.needsReauth === true,
      exhausted: isCodexExhausted({ account, thresholds: bars, now }),
      usage: usage
        ? {
            aggregate: usage.aggregate.map((w) => currentCodexWindow(w, now)),
            perLimit: Object.fromEntries(
              Object.entries(usage.perLimit).map(([name, windows]) => [name, windows.map((w) => currentCodexWindow(w, now))]),
            ),
          }
        : null,
      usageAt: account.lastUsageAt ?? null,
      sample: outcome.ok ? { ok: true, source: "probe" } : { ok: false, reason: outcome.reason },
    };
  });
  return { bars, accounts };
}

function renderCodex(input: { codex: StatusReport["codex"]; now: number; row: (name: string, w: UsageWindow) => void }): void {
  const { codex, now, row } = input;
  if (codex.accounts.length === 0) return;
  console.log(c.dim(`codex  (${count({ n: codex.accounts.length, noun: "account" })})`));
  console.log();
  const windowLabel = (window: CodexWindow) =>
    isSessionWindow({ window }) ? `${Math.round((window.windowSeconds ?? 0) / 3600)}h` : "week";
  for (const account of codex.accounts) {
    const marker = account.active ? c.green("●") : c.dim("○");
    const badges: string[] = [];
    if (account.active) badges.push(c.green("active"));
    if (account.needsReauth) badges.push(c.red("needs-reauth"));
    if (account.exhausted) badges.push(c.yellow("exhausted"));
    console.log(`${marker} ${c.bold(account.label)}${account.planType ? ` ${c.dim(account.planType)}` : ""}${badges.length ? ` ${badges.join(" ")}` : ""}`);
    if (account.usage) {
      for (const window of account.usage.aggregate) row(windowLabel(window), window);
      for (const [name, windows] of Object.entries(account.usage.perLimit)) {
        for (const window of windows) row(codexLimitLabel({ limitName: name }), window);
      }
    }
    if (!account.sample.ok) {
      const cached = account.usage ? `cached${account.usageAt != null ? ` ${fmtAgo(account.usageAt, now)}` : ""}, ` : "";
      console.log(`    ${c.yellow(`${cached}live sample failed`)}: ${c.dim(account.sample.reason)}`);
    }
    console.log();
  }
}

function rowPrinter(now: number): (name: string, w: UsageWindow) => void {
  return (name, w) => {
    console.log(`    ${name.padEnd(5)} ${bar(w.usedPercentage)}  ${c.dim(fmtReset(w.resetsAt, now))}`);
  };
}

function renderClaude(input: {
  claude: StatusReport["claude"];
  codexPooled: boolean;
  now: number;
  staleAfterMs: number;
  row: (name: string, w: UsageWindow) => void;
}): void {
  const { claude, codexPooled, now, staleAfterMs, row } = input;
  if (claude.accounts.length === 0) {
    if (!codexPooled) {
      console.log(c.dim("no accounts yet, run `tokenmaxxing init` (or `tokenmaxxing init --codex`)"));
      return;
    }
    console.log(c.dim("no claude accounts (run `tokenmaxxing init` to pool claude too)"));
    console.log();
    return;
  }

  console.log(c.dim(`thresholds 5h ${claude.thresholds.session.join("/")}% (at ${claude.bars.session + claude.projectionMargin}%) weekly ${claude.thresholds.weekly}%  (${count({ n: claude.accounts.length, noun: "claude account" })})`));
  console.log();
  for (const a of claude.accounts) {
    const marker = a.active ? c.green("●") : c.dim("○");
    const badges: string[] = [];
    if (a.active) badges.push(c.green("active"));
    if (a.needsReauth) badges.push(c.red("needs-reauth"));
    if (a.exhausted) badges.push(c.yellow("exhausted"));
    console.log(`${marker} ${c.bold(a.label || a.email)}${a.tier ? ` ${c.dim(a.tier)}` : ""}${badges.length ? ` ${badges.join(" ")}` : ""}`);
    if (a.usage) {
      row("5h", a.usage.fiveHour);
      row("week", a.usage.week);
    }
    for (const [name, w] of Object.entries(a.perModel)) row(name.toLowerCase(), w);
    if (a.sample.ok && a.sample.source === "statusline") {
      const stale = a.usageAt == null || now - a.usageAt > staleAfterMs;
      const age = a.usageAt != null ? fmtAgo(a.usageAt, now) : "age unknown";
      console.log(`    ${(stale ? c.yellow : c.dim)(`statusline tee ${age}${stale ? " (stale)" : ""}`)}`);
    }
    if (!a.sample.ok) {
      const cached = a.usage || Object.keys(a.perModel).length > 0 ? `cached${a.usageAt != null ? ` ${fmtAgo(a.usageAt, now)}` : ""}, ` : "";
      console.log(`    ${c.yellow(`${cached}live sample failed`)}: ${c.dim(a.sample.reason)}`);
    }
    if (a.pingError != null && a.pingRejected) {
      const at = a.pingError.indexOf(": ");
      const head = at >= 0 ? a.pingError.slice(0, at) : a.pingError;
      const tail = at >= 0 ? a.pingError.slice(at + 2) : "";
      console.log(`    ${c.yellow(`ping ${head}`)}${tail ? `: ${c.dim(tail)}` : ""}`);
    } else if (a.pingError != null) {
      console.log(`    ${c.yellow("ping failed (5h timer may not have started)")}: ${c.dim(a.pingError)}`);
    }
    if (a.pinged) {
      console.log(`    ${c.dim("pinged - 5h timer started this run; the usage feed lags, re-run status shortly for the fresh window")}`);
    }
    console.log();
  }
}

export async function cmdStatus(opts: { ping?: boolean; pingCount?: number; json?: boolean; preRender?: () => void } = {}): Promise<number> {
  const { ping = false, pingCount, json = false } = opts;
  const cfg = loadConfig();
  const now = Date.now();
  const claude = await collectClaude({ cfg, ping, pingCount, now });
  if (!json) {
    opts.preRender?.();
    const at = Date.now();
    renderClaude({ claude, codexPooled: loadCodexAccounts().accounts.length > 0, now: at, staleAfterMs: cfg.policy.usagePollTtlMs, row: rowPrinter(at) });
  }
  const codex = await collectCodex({ cfg, now });
  if (json) {
    const report: StatusReport = { now, claude, codex };
    emitJson({ ok: true, ...report });
    return 0;
  }
  const at = Date.now();
  renderCodex({ codex, now: at, row: rowPrinter(at) });
  return 0;
}
