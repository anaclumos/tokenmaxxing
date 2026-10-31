import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Account, Window } from "../src/lib/types.ts";

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
export const SESSION_SECONDS = 5 * 3600;
export const WEEK_SECONDS = 7 * 24 * 3600;

export function freshHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "tokenmaxxing-test-"));
  process.env.TOKENMAXXING_HOME = dir;
  return dir;
}

export function sessionWindow(usedPercentage: number, resetsAt: number, now: number): Window {
  return { name: null, usedPercentage, resetsAt, windowSeconds: SESSION_SECONDS, sampledAt: now };
}

export function weeklyWindow(usedPercentage: number, resetsAt: number, now: number): Window {
  return { name: null, usedPercentage, resetsAt, windowSeconds: WEEK_SECONDS, sampledAt: now };
}

export function account(id: string, tier: string, windows: Window[]): Account {
  return { id, label: id, email: `${id}@example.com`, tier, addedAt: new Date(0).toISOString(), windows };
}

export async function claudePickCtx(now: number, seats: Map<string, number> | null = null) {
  const { thresholdBars } = await import("../src/lib/picker.ts");
  const { claudePlanWeight } = await import("../src/lib/claude.ts");
  const { ConfigSchema } = await import("../src/lib/types.ts");
  return {
    now,
    thresholds: thresholdBars(ConfigSchema.parse({})),
    currentId: null,
    families: null,
    seats,
    planWeight: claudePlanWeight,
  };
}

export function serveJson(bodies: unknown[]): { url: string; stop: () => void } {
  let next = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      const body = bodies[Math.min(next, bodies.length - 1)];
      next += 1;
      return Response.json(body);
    },
  });
  return { url: new URL("/api/oauth/usage", server.url).href, stop: () => void server.stop(true) };
}
