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

export function claudeTierLabel(input: { subscriptionType?: string; rateLimitTier?: string }): string | null {
  const segments = input.rateLimitTier?.split("_") ?? [];
  const multiplier = segments.find((seg) => seg.length > 1 && seg.endsWith("x") && Number.isInteger(Number(seg.slice(0, -1))));
  if (input.subscriptionType == null) return multiplier ?? null;
  return multiplier ? `${input.subscriptionType} ${multiplier}` : input.subscriptionType;
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

