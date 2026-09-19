import { clamp } from "es-toolkit";

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

export function statuslineColor(): { color: boolean; truecolor: boolean } {
  const colorterm = process.env.COLORTERM ?? "";
  return { color: !process.env.NO_COLOR, truecolor: colorterm.includes("truecolor") || colorterm.includes("24bit") };
}

function rampRgb(usedPct: number): { r: number; g: number } {
  const u = clamp(usedPct, 0, 100);
  if (u >= 95) return { r: 255, g: 0 };
  if (u >= 75) return { r: 255, g: Math.round(255 * (1 - (u - 75) / 20)) };
  return { r: Math.round((255 * u) / 75), g: 255 };
}

export function makeUsagePaint(input: { enabled: boolean; truecolor: boolean }) {
  return (usedPct: number) =>
    (s: string): string => {
      if (!input.enabled) return s;
      const { r, g } = rampRgb(usedPct);
      const code = input.truecolor
        ? `38;2;${r};${g};0`
        : `38;5;${16 + 36 * Math.round(r / 51) + 6 * Math.round(g / 51)}`;
      return `\x1b[${code}m${s}\x1b[0m`;
    };
}

export function count(input: { n: number; noun: string }): string {
  return `${input.n} ${input.noun}${input.n === 1 ? "" : "s"}`;
}

export function bar(pct: number, width = 16): string {
  const clamped = clamp(pct, 0, 100);
  const filled = Math.round((clamped / 100) * width);
  const body = "█".repeat(filled) + "░".repeat(width - filled);
  const label = `${clamped.toFixed(0).padStart(3)}%`;
  const paint = clamped >= 95 ? c.red : clamped >= 75 ? c.yellow : c.green;
  return `${paint(body)} ${label}`;
}

function splitDuration(ms: number): { dsec: number; d: number; h: number; m: number } {
  const dsec = Math.round(ms / 1000);
  return { dsec, d: Math.floor(dsec / 86400), h: Math.floor((dsec % 86400) / 3600), m: Math.floor((dsec % 3600) / 60) };
}

export function fmtReset(epochMs: number | null | undefined, now = Date.now()): string {
  if (epochMs == null) return "";
  const { dsec, d, h, m } = splitDuration(epochMs - now);
  if (dsec <= 0) return "reset now";
  const hours = d * 24 + h;
  if (hours > 24) return `resets in ${d}d${h}h`;
  if (hours > 0) return `resets in ${hours}h${m}m`;
  return `resets in ${m}m`;
}

export function fmtResetShort(epochMs: number | null | undefined, now = Date.now()): string {
  if (epochMs == null) return "";
  const { dsec, d, h, m } = splitDuration(epochMs - now);
  if (dsec <= 0) return "";
  if (d > 0) return `${d}d`;
  if (h > 0) return `${h}h`;
  return `${Math.max(m, 1)}m`;
}

export function fmtAgo(epochMs: number, now = Date.now()): string {
  const { dsec, d, h, m } = splitDuration(now - epochMs);
  if (dsec < 60) return "just now";
  if (d > 0) return `${d}d ago`;
  if (h > 0) return `${h}h ago`;
  return `${m}m ago`;
}

export const plain = (s: string): string => s;

export function emitJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export function emitError(input: {
  json?: boolean;
  message: string;
  notes?: string[];
  extra?: Record<string, unknown>;
  paint?: (s: string) => string;
}): void {
  if (input.json) {
    emitJson({ ok: false, error: input.message, ...input.extra });
    return;
  }
  console.error((input.paint ?? c.red)(input.message));
  for (const note of input.notes ?? []) console.error(c.dim(note));
}
