import { chunk, sortBy } from "es-toolkit";
import { claude } from "../lib/claude.ts";
import { codex } from "../lib/codex.ts";
import { grok } from "../lib/grok.ts";
import { opencodeGo } from "../lib/opencodego.ts";
import { loadAccounts, loadConfig, saveAccounts } from "../lib/state.ts";
import { withLock } from "../lib/lock.ts";
import { codexPool, grokPool, opencodeGoPool } from "../lib/paths.ts";
import { earliestReset, gatedWindows, isExhausted, isSessionWindow, limitWindows, liveUsed, nextWeeklyReset, sessionWindow, thresholdBars, weeklyWindow } from "../lib/picker.ts";
import type { Provider, SampleReport } from "../lib/provider.ts";
import { bar, c, count, emitJson, fmtAgo } from "./render.ts";
import type { Account, Config, Thresholds, Window } from "../lib/types.ts";

export type WindowReport = { usedPercentage: number; resetsAt: number | null; windowSeconds: number | null };

export type UsageReport = { fiveHour: WindowReport | null; week: WindowReport | null; limits: (WindowReport & { name: string })[] };

type StatusAccount = {
  label: string;
  email: string | null;
  id: string;
  tier: string | null;
  active: boolean;
  sessions: number;
  needsReauth: boolean;
  exhausted: boolean;
  usage: UsageReport | null;
  usageAt: number | null;
  limitsAt: number | null;
  sample: SampleReport | { ok: true; source: "cached" };
};

type PoolReport = {
  thresholds: Thresholds;
  bars: Thresholds;
  projectionMargin: number;
  gatedNote: string | null;
  accounts: StatusAccount[];
};

export type StatusReport = { now: number; claude: PoolReport; codex: PoolReport; grok: PoolReport; opencodeGo: PoolReport };

function currentWindow(w: Window, now: number): WindowReport {
  const passed = w.resetsAt != null && w.resetsAt <= now;
  return {
    usedPercentage: passed ? 0 : w.usedPercentage,
    resetsAt: isSessionWindow(w) ? (passed ? null : w.resetsAt) : nextWeeklyReset(w.resetsAt, now),
    windowSeconds: w.windowSeconds,
  };
}

export function usageReport(a: Account, now: number): UsageReport | null {
  if (a.lastUsageAt == null) return null;
  const session = sessionWindow(a);
  const week = weeklyWindow(a);
  return {
    fiveHour: session ? currentWindow(session, now) : null,
    week: week ? currentWindow(week, now) : null,
    limits: limitWindows(a).map((w) => ({ name: w.name ?? "", ...currentWindow(w, now) })),
  };
}

function gatedNote(accounts: Account[], families: string[] | null, weeklyBar: number, now: number): string | null {
  const groups = new Map<string, { carriers: number; capped: number }>();
  for (const a of accounts) {
    if (a.needsReauth === true) continue;
    for (const w of gatedWindows(a, families)) {
      const key = (w.name ?? "").toLowerCase();
      const g = groups.get(key) ?? { carriers: 0, capped: 0 };
      g.carriers++;
      if (liveUsed(w, now) >= weeklyBar) g.capped++;
      groups.set(key, g);
    }
  }
  const capped = [...groups.entries()].filter(([, g]) => g.capped === g.carriers).map(([name]) => name);
  if (capped.length === 0) return null;
  const headroom = accounts.filter((a) => {
    if (a.needsReauth === true) return false;
    const w = weeklyWindow(a);
    return w != null && liveUsed(w, now) < weeklyBar;
  }).length;
  if (headroom === 0) return null;
  return `every ${capped.join(", ")} cap is at the weekly bar, but ${count({ n: headroom, noun: "account" })} still ha${headroom === 1 ? "s" : "ve"} weekly aggregate headroom for other models`;
}

async function collect(p: Provider, cfg: Config, now: number, cached: boolean): Promise<PoolReport> {
  let idx = loadAccounts(p.pool);
  let reports = new Map<string, SampleReport>();
  let liveId: string | null = null;
  if (!cached && idx.accounts.length > 0) {
    await withLock(p.pool.lockFile, async () => {
      idx = loadAccounts(p.pool);
      const notice = process.stderr.isTTY;
      if (notice) process.stderr.write(c.dim(`sampling ${p.name} usage...`));
      try {
        liveId = p.liveId();
        reports = await p.samplePool(idx.accounts, liveId, now);
      } finally {
        if (notice) process.stderr.write("\r\x1b[2K");
      }
      saveAccounts(p.pool, idx);
    });
  }

  const bars = thresholdBars(cfg);
  const present = p.presence();
  const ctx = { now, thresholds: bars, currentId: null, families: p.gatedFamilies(cfg), seats: null };
  const ordered = sortBy(idx.accounts, [(a) => (a.needsReauth ? 1 : 0), (a) => earliestReset(a, now)]);
  const accounts = ordered.map((a): StatusAccount => {
    const limits = limitWindows(a);
    return {
      label: a.label,
      email: a.email,
      id: a.id,
      tier: a.tier,
      active: (liveId != null && a.id === liveId) || present.has(a.id),
      sessions: present.get(a.id) ?? 0,
      needsReauth: a.needsReauth === true,
      exhausted: isExhausted(a, ctx),
      usage: usageReport(a, now),
      usageAt: a.lastUsageAt ?? null,
      limitsAt: limits.length > 0 ? Math.max(...limits.map((w) => w.sampledAt)) : null,
      sample: reports.get(a.id) ?? (cached ? { ok: true, source: "cached" } : { ok: false, reason: "not sampled" }),
    };
  });
  return {
    thresholds: { session: cfg.thresholds.session, weekly: cfg.thresholds.weekly },
    bars,
    projectionMargin: cfg.policy.projectionMargin,
    gatedNote: gatedNote(idx.accounts, ctx.families, bars.weekly, now),
    accounts,
  };
}

const CARD_GAP = 3;
const NOTE_INDENT = "    ";

type Note = { paint: (s: string) => string; text: string };
type Card = { lines: string[]; notes: Note[] };

function renderGrid(cards: Card[]): void {
  const bodyWidth = Math.max(...cards.flatMap((card) => card.lines.map((line) => Bun.stringWidth(line))));
  const termWidth = process.stdout.isTTY ? process.stdout.columns : Number.POSITIVE_INFINITY;
  const columns = process.stdout.isTTY ? Math.min(cards.length, Math.max(1, Math.floor((termWidth + CARD_GAP) / (bodyWidth + CARD_GAP)))) : 1;
  const cellWidth = columns === 1 ? termWidth : Math.floor((termWidth + CARD_GAP) / columns) - CARD_GAP;
  const blocks = cards.map((card) => [
    ...card.lines,
    ...card.notes.flatMap((note) => Bun.wrapAnsi(note.text, cellWidth - NOTE_INDENT.length, { hard: true }).split("\n").map((line) => `${NOTE_INDENT}${note.paint(line)}`)),
  ]);
  const width = Math.max(...blocks.flat().map((line) => Bun.stringWidth(line)));
  for (const rowBlocks of chunk(blocks, columns)) {
    const height = Math.max(...rowBlocks.map((block) => block.length));
    for (let i = 0; i < height; i++) {
      const cells = rowBlocks.map((block) => block[i] ?? "");
      const padded = cells.map((cell, col) => (col === cells.length - 1 ? cell : cell + " ".repeat(Math.max(0, width + CARD_GAP - Bun.stringWidth(cell)))));
      console.log(padded.join("").trimEnd());
    }
    console.log();
  }
}

function usageRow(name: string, w: WindowReport): string {
  return `${NOTE_INDENT}${name.padEnd(5)} ${bar(w.usedPercentage)}`;
}

function sampleFailedNotes(input: { cached: boolean; usageAt: number | null; reason: string; now: number }): Note[] {
  const cached = input.cached ? `cached${input.usageAt != null ? ` ${fmtAgo(input.usageAt, input.now)}` : ""}, ` : "";
  return [
    { paint: c.yellow, text: `${cached}live sample failed:` },
    { paint: c.dim, text: input.reason },
  ];
}

function cachedNote(usageAt: number | null, now: number): Note {
  return { paint: c.dim, text: usageAt != null ? `cached ${fmtAgo(usageAt, now)}` : "never sampled" };
}

function headerLine(input: { active: boolean; sessions: number; needsReauth: boolean; exhausted: boolean; name: string; tier: string | null }): string {
  const marker = input.active ? c.green("●") : c.dim("○");
  const badges: string[] = [];
  if (input.active) badges.push(c.green("active"));
  if (input.sessions > 0) badges.push(c.green(count({ n: input.sessions, noun: "session" })));
  if (input.needsReauth) badges.push(c.red("needs-reauth"));
  if (input.exhausted) badges.push(c.yellow("exhausted"));
  return `${marker} ${c.bold(input.name)}${input.tier ? ` ${c.dim(input.tier)}` : ""}${badges.length ? ` ${badges.join(" ")}` : ""}`;
}

function card(p: Provider, a: StatusAccount, now: number, staleAfterMs: number): Card {
  const lines = [headerLine({ ...a, name: a.label })];
  if (a.usage) {
    if (a.usage.fiveHour) lines.push(usageRow(`${Math.round((a.usage.fiveHour.windowSeconds ?? 0) / 3600)}h`, a.usage.fiveHour));
    if (a.usage.week) lines.push(usageRow("week", a.usage.week));
    for (const w of a.usage.limits) lines.push(usageRow(p.windowLabel(w.name), w));
  }
  const notes: Note[] = [];
  if (a.sample.ok && a.sample.source === "statusline") {
    const stale = a.usageAt == null || now - a.usageAt > staleAfterMs;
    const age = a.usageAt != null ? fmtAgo(a.usageAt, now) : "age unknown";
    notes.push({ paint: stale ? c.yellow : c.dim, text: `statusline tee ${age}${stale ? " (stale)" : ""}` });
  }
  if (a.sample.ok && a.sample.source === "cached") {
    const note = cachedNote(a.usageAt, now);
    notes.push(a.limitsAt != null && a.limitsAt !== a.usageAt ? { ...note, text: `${note.text}, per-model ${fmtAgo(a.limitsAt, now)}` } : note);
  }
  if (!a.sample.ok) {
    notes.push(...sampleFailedNotes({ cached: a.usage != null, usageAt: a.usageAt, reason: a.sample.reason, now }));
  }
  return { lines, notes };
}

function renderPool(p: Provider, pool: PoolReport, header: string, now: number, staleAfterMs: number): void {
  console.log(c.dim(header));
  console.log();
  renderGrid(pool.accounts.map((a) => card(p, a, now, staleAfterMs)));
  if (pool.gatedNote) {
    console.log(c.yellow(pool.gatedNote));
    console.log();
  }
}

export async function cmdStatus(opts: { json?: boolean; cached?: boolean } = {}): Promise<number> {
  const { json = false, cached = false } = opts;
  const cfg = loadConfig();
  const now = Date.now();
  const claudeReport = await collect(claude, cfg, now, cached);
  if (!json) {
    const codexPooled = loadAccounts(codexPool).accounts.length > 0;
    const grokPooled = loadAccounts(grokPool).accounts.length > 0;
    const opencodeGoPooled = loadAccounts(opencodeGoPool).accounts.length > 0;
    if (claudeReport.accounts.length === 0) {
      if (!codexPooled && !grokPooled && !opencodeGoPooled) {
        console.log(c.dim("no accounts yet, run `tokenmaxxing init` (or `tokenmaxxing init --codex`, `--grok`, `--opencode-go`)"));
        return 0;
      }
      console.log(c.dim("no claude accounts (run `tokenmaxxing init` to pool claude too)"));
      console.log();
    } else {
      const header = `thresholds 5h ${claudeReport.thresholds.session}% weekly ${claudeReport.thresholds.weekly}%  (${count({ n: claudeReport.accounts.length, noun: "claude account" })})`;
      renderPool(claude, claudeReport, header, Date.now(), cfg.policy.usagePollTtlMs);
    }
  }
  const codexReport = await collect(codex, cfg, now, cached);
  const grokReport = await collect(grok, cfg, now, cached);
  const opencodeGoReport = await collect(opencodeGo, cfg, now, cached);
  if (json) {
    const report: StatusReport = { now, claude: claudeReport, codex: codexReport, grok: grokReport, opencodeGo: opencodeGoReport };
    emitJson({ ok: true, ...report });
    return 0;
  }
  if (codexReport.accounts.length > 0) {
    renderPool(codex, codexReport, `codex  (${count({ n: codexReport.accounts.length, noun: "account" })})`, Date.now(), cfg.policy.usagePollTtlMs);
  }
  if (grokReport.accounts.length > 0) {
    renderPool(grok, grokReport, `grok  (${count({ n: grokReport.accounts.length, noun: "account" })}, status-only)`, Date.now(), cfg.policy.usagePollTtlMs);
  }
  if (opencodeGoReport.accounts.length > 0) {
    renderPool(opencodeGo, opencodeGoReport, `opencode-go  (${count({ n: opencodeGoReport.accounts.length, noun: "account" })}, status-only)`, Date.now(), cfg.policy.usagePollTtlMs);
  }
  return 0;
}
