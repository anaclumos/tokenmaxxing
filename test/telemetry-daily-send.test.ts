import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { freshHome, HOUR_MS } from "./fixtures.ts";

const SentSchema = z.object({ batch: z.array(z.looseObject({ event: z.string(), distinct_id: z.string(), properties: z.record(z.string(), z.unknown()) })) });

delete process.env.CI;
const home = freshHome();
const spool = join(home, "telemetry.jsonl");
const stateFile = join(home, "telemetry.json");
const configFile = join(home, "config.json");

let mode: "ok" | "fail" | "hang" = "ok";
let attempts = 0;
const bodies: string[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  async fetch(req) {
    attempts += 1;
    const raw = new Uint8Array(await req.arrayBuffer());
    bodies.push(new TextDecoder().decode(req.headers.get("content-encoding") === "gzip" ? Bun.gunzipSync(raw) : raw));
    if (mode === "hang") return new Promise<Response>(() => {});
    return mode === "ok" ? Response.json({ status: 1 }) : new Response("down", { status: 500 });
  },
});
process.env.TOKENMAXXING_POSTHOG_HOST = server.url.href.replace(/\/$/, "");
const telemetry = await import("../src/lib/telemetry.ts");

const installId = crypto.randomUUID();
const sent = () => bodies.map((b) => SentSchema.parse(JSON.parse(b)));
const noticed = (agoMs: number | null) =>
  writeFileSync(stateFile, JSON.stringify({ installId, noticeAt: agoMs == null ? null : Date.now() - agoMs, attemptedAt: null }));
const spoolLines = () => readFileSync(spool, "utf8").split("\n").filter((l) => l !== "");

beforeEach(() => {
  mode = "ok";
  attempts = 0;
  bodies.length = 0;
  delete process.env.DO_NOT_TRACK;
  delete process.env.TOKENMAXXING_TELEMETRY;
  writeFileSync(configFile, "{}");
  writeFileSync(spool, "");
  noticed(25 * HOUR_MS);
});

afterAll(() => server.stop(true));

describe("telemetry", () => {
  test("a due send carries the spooled events and the daily summary under the install ID, with only allowlisted fields", async () => {
    telemetry.record({ event: "command", command: "status", pool: "claude", flags: ["--cached"], exit_code: 0, duration_ms: 42 });
    const renamed: Parameters<typeof telemetry.record>[0] & { label: string; path: string } = { event: "account_renamed", pool: "codex", label: "alice@example.com", path: home };
    telemetry.record(renamed);

    await telemetry.flushTelemetry(Date.now());

    const events = sent().flatMap((b) => b.batch);
    expect(events.map((e) => e.event).sort()).toEqual(["account_renamed", "command", "install_daily"]);
    expect(events.every((e) => e.distinct_id === installId && !("$process_person_profile" in e.properties))).toBe(true);
    expect(bodies.join("\n")).not.toContain("alice@example.com");
    expect(bodies.join("\n")).not.toContain(home);
    expect(spoolLines()).toEqual([]);
  });

  test("nothing goes out until a day after the notice was shown", async () => {
    telemetry.record({ event: "uninstall" });
    noticed(null);
    await telemetry.flushTelemetry(Date.now());
    noticed(HOUR_MS);
    await telemetry.flushTelemetry(Date.now());
    expect(attempts).toBe(0);

    noticed(25 * HOUR_MS);
    await telemetry.flushTelemetry(Date.now());
    expect(sent().flatMap((b) => b.batch.map((e) => e.event))).toContain("uninstall");
  });

  test("turning it off, by command or by DO_NOT_TRACK, drops the spool and sends nothing", async () => {
    telemetry.record({ event: "account_renamed", pool: "claude" });
    await telemetry.setTelemetry(false);
    await telemetry.flushTelemetry(Date.now());
    expect(attempts).toBe(0);

    writeFileSync(configFile, "{}");
    telemetry.record({ event: "account_renamed", pool: "claude" });
    process.env.DO_NOT_TRACK = "1";
    telemetry.record({ event: "account_removed", pool: "claude", pool_size: "1" });
    delete process.env.DO_NOT_TRACK;
    await telemetry.flushTelemetry(Date.now());

    expect(attempts).toBe(0);
    expect(JSON.parse(readFileSync(configFile, "utf8")).telemetry).toBe(false);
  });

  test("a failed send keeps the spool and waits a day before trying again", async () => {
    mode = "fail";
    telemetry.record({ event: "account_renamed", pool: "claude" });
    await telemetry.flushTelemetry(Date.now());
    await telemetry.flushTelemetry(Date.now());

    expect(attempts).toBe(1);
    expect(spoolLines()).toHaveLength(1);
  });

  test("a host that never answers holds the send for about the request timeout, not longer", async () => {
    mode = "hang";
    telemetry.record({ event: "account_renamed", pool: "claude" });
    const started = Date.now();
    await telemetry.flushTelemetry(Date.now());

    expect(Date.now() - started).toBeLessThan(15_000);
    expect(spoolLines()).toHaveLength(1);
  }, 30_000);
});
