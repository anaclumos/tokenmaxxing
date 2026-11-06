import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Account, Window } from "../src/lib/types.ts";

export const HOUR_MS = 3_600_000;
const SESSION_SECONDS = 5 * 3600;
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

export function serveJson(bodies: unknown[]): { url: string; hits: () => number; stop: () => void } {
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
  return { url: new URL("/api/oauth/usage", server.url).href, hits: () => next, stop: () => void server.stop(true) };
}

export function barrier(keys: readonly string[]): { arrive: (key: string) => Promise<void>; arrived: string[] } {
  const arrived: string[] = [];
  const all = Promise.withResolvers<void>();
  return {
    arrived,
    arrive(key) {
      arrived.push(key);
      if (keys.every((k) => arrived.includes(k))) all.resolve();
      return all.promise;
    },
  };
}

export function serveTogether(input: { keys: readonly string[]; respond: (req: Request) => unknown; keyOf?: (req: Request) => string }): { base: string; arrived: string[]; stop: () => void } {
  const keyOf = input.keyOf ?? ((req: Request) => new URL(req.url).pathname);
  const gate = barrier(input.keys);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      await gate.arrive(keyOf(req));
      return Response.json(input.respond(req));
    },
  });
  return { base: `http://127.0.0.1:${server.port}`, arrived: gate.arrived, stop: () => void server.stop(true) };
}

export function claudeCredentials(accessToken: string, expiresAt: number): string {
  return JSON.stringify({ claudeAiOauth: { accessToken, refreshToken: `refresh-${accessToken}`, expiresAt, scopes: [], subscriptionType: "max" } });
}

export function pooledClaude(id: string): Account {
  return { ...account(id, "max", []), oauthAccount: { accountUuid: id, emailAddress: `${id}@example.com`, organizationUuid: "org-test" } };
}

export function claudeUsageBody(now: number): unknown {
  return {
    five_hour: { utilization: 10, resets_at: new Date(now + 2 * HOUR_MS).toISOString() },
    seven_day: { utilization: 20, resets_at: new Date(now + 4 * 24 * HOUR_MS).toISOString() },
  };
}

export function installFakeClaude(home: string): void {
  const dir = join(mkdtempSync(join(tmpdir(), "claude-stub-")), "versions", "2.1.0");
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, "claude");
  writeFileSync(bin, '#!/bin/sh\necho "2.1.0 (Claude Code)"\n');
  chmodSync(bin, 0o755);
  writeFileSync(join(home, "config.json"), JSON.stringify({ claudeBin: bin }));
}

export function describeFailedRead(home: string, read: unknown): string {
  const files = readdirSync(home, { recursive: true, encoding: "utf8" })
    .map((name) => join(home, name))
    .filter((path) => statSync(path).isFile())
    .map((path) => `--- ${path}\n${readFileSync(path, "utf8").slice(-4000)}`);
  return [`read: ${JSON.stringify(read)}`, ...files].join("\n");
}
