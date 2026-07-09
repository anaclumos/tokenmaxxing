// Terminal rendering helpers for the CLI (bars, colors, relative times).

import { clamp } from "es-toolkit";

const useColor = !process.env.NO_COLOR && process.stdout.isTTY;

export const c = {
  dim: (s: string) => (useColor ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string) => (useColor ? `\x1b[1m${s}\x1b[0m` : s),
  green: (s: string) => (useColor ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s: string) => (useColor ? `\x1b[33m${s}\x1b[0m` : s),
  red: (s: string) => (useColor ? `\x1b[31m${s}\x1b[0m` : s),
  cyan: (s: string) => (useColor ? `\x1b[36m${s}\x1b[0m` : s),
};

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
