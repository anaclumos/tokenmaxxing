// Terminal rendering helpers for the CLI (bars, colors, relative times).

import { clamp } from "es-toolkit";

/** ANSI painters, no-ops when disabled. The statusLine renders through a pipe
 *  (never a TTY), so it needs its own enable gate; the CLI gates on stdout. */
export function makeColors(enabled: boolean) {
  const paint = (code: string) => (s: string) => (enabled ? `\x1b[${code}m${s}\x1b[0m` : s);
  return {
    dim: paint("2"),
    bold: paint("1"),
    green: paint("32"),
    yellow: paint("33"),
    red: paint("31"),
    cyan: paint("36"),
  };
}

export const c = makeColors(!process.env.NO_COLOR && !!process.stdout.isTTY);

/** "1 account" / "3 accounts": counted nouns always pluralize properly. */
export function count(input: { n: number; noun: string }): string {
  return `${input.n} ${input.noun}${input.n === 1 ? "" : "s"}`;
}

/** A fixed-width usage bar, colored by fill. */
export function bar(pct: number, width = 16): string {
  const clamped = clamp(pct, 0, 100);
  const filled = Math.round((clamped / 100) * width);
  const body = "█".repeat(filled) + "░".repeat(width - filled);
  const label = `${clamped.toFixed(0).padStart(3)}%`;
  const paint = clamped >= 95 ? c.red : clamped >= 75 ? c.yellow : c.green;
  return `${paint(body)} ${label}`;
}

/** Relative-time string for a reset epoch, e.g. "resets in 2h13m". */
export function fmtReset(epochMs: number | null | undefined, now = Date.now()): string {
  if (epochMs == null) return "";
  const dsec = Math.round((epochMs - now) / 1000);
  if (dsec <= 0) return "reset now";
  const h = Math.floor(dsec / 3600);
  const m = Math.floor((dsec % 3600) / 60);
  if (h > 24) return `resets in ${Math.floor(h / 24)}d${h % 24}h`;
  if (h > 0) return `resets in ${h}h${m}m`;
  return `resets in ${m}m`;
}

/** Age of a cached sample, largest unit only: "just now", "3m ago", "2h ago",
 *  "5d ago". */
export function fmtAgo(epochMs: number, now = Date.now()): string {
  const dsec = Math.max(0, Math.round((now - epochMs) / 1000));
  if (dsec < 60) return "just now";
  const d = Math.floor(dsec / 86400);
  const h = Math.floor((dsec % 86400) / 3600);
  const m = Math.floor((dsec % 3600) / 60);
  if (d > 0) return `${d}d ago`;
  if (h > 0) return `${h}h ago`;
  return `${m}m ago`;
}

/** Compact time-until-reset for the statusLine: the largest unit only ("6d",
 *  "2h", "45m"), floored to "1m" so a live window never reads as zero, and ""
 *  once the reset has passed (the window is simply empty again). Non-empty
 *  output always ends in a unit letter, so the digit-leading used-percent glued
 *  after it stays parseable. */
export function fmtResetShort(epochMs: number | null | undefined, now = Date.now()): string {
  if (epochMs == null) return "";
  const dsec = Math.round((epochMs - now) / 1000);
  if (dsec <= 0) return "";
  const d = Math.floor(dsec / 86400);
  const h = Math.floor((dsec % 86400) / 3600);
  const m = Math.floor((dsec % 3600) / 60);
  if (d > 0) return `${d}d`;
  if (h > 0) return `${h}h`;
  return `${Math.max(m, 1)}m`;
}
