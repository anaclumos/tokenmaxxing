import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifyEnforcedLimit, findEnforcedRow, readTranscriptTail, transcriptRowText, type TranscriptRow } from "../src/lib/usage.ts";
import { paths } from "../src/lib/paths.ts";

const NOW = 1_784_400_000_000;
const iso = (ms: number) => new Date(ms).toISOString();

function errorRow(over: Partial<TranscriptRow> & { text: string; at?: number }): TranscriptRow {
  const { text, at, ...rest } = over;
  return {
    type: "assistant",
    timestamp: iso(at ?? NOW),
    isApiErrorMessage: true,
    error: "rate_limit",
    message: { content: [{ type: "text", text }] },
    ...rest,
  };
}

const userRow = (at: number): TranscriptRow => ({ type: "user", timestamp: iso(at), message: { content: "do the thing" } });

describe("classifyEnforcedLimit", () => {
  const families = ["fable"];

  test("five_hour quotaLimits is the session window with the server's reset (epoch seconds)", () => {
    const row = errorRow({ text: "You've hit your session limit · resets 3pm (Asia/Seoul)", quotaLimits: { rateLimitType: "five_hour", resetsAt: 1_784_403_600 } });
    expect(classifyEnforcedLimit(row, families)).toEqual({ kind: "session", resetsAt: 1_784_403_600_000 });
  });

  test("seven_day quotaLimits is the weekly aggregate", () => {
    const row = errorRow({ text: "You've hit your weekly limit", quotaLimits: { rateLimitType: "seven_day", resetsAt: 1_784_900_000 } });
    expect(classifyEnforcedLimit(row, families)).toEqual({ kind: "weekly", resetsAt: 1_784_900_000_000 });
  });

  test("a per-model quotaLimits type matches the family by substring (underscore glue)", () => {
    const row = errorRow({ text: "You've hit your Sonnet limit", quotaLimits: { rateLimitType: "seven_day_sonnet", resetsAt: 1_784_900_000 } });
    expect(classifyEnforcedLimit(row, ["fable", "sonnet"])).toEqual({ kind: "model", family: "sonnet", resetsAt: 1_784_900_000_000 });
  });

  test("an unrecognized quotaLimits window stamps nothing rather than the aggregate", () => {
    const row = errorRow({ text: "You've hit your usage credit limit", quotaLimits: { rateLimitType: "overage", resetsAt: 1_784_900_000 } });
    expect(classifyEnforcedLimit(row, families)).toBeNull();
  });

  test("the credits branch (no quotaLimits, a typed rate_limit_error body) is the credits-gated family's cap", () => {
    const row = errorRow({ text: "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.", errorDetails: '429 {"error":{"type":"rate_limit_error","message":"..."},"request_id":"req_1"}' });
    expect(classifyEnforcedLimit(row, families)).toEqual({ kind: "model", family: "fable", resetsAt: null });
    expect(classifyEnforcedLimit(errorRow({ text: "", errorDetails: '429 {"error":{"type":"rate_limit_error"}}' }), families)).toEqual({ kind: "model", family: "fable", resetsAt: null });
  });

  test("a body of another error type, an unparsable body, or no body is not exhaustion", () => {
    expect(classifyEnforcedLimit(errorRow({ text: "You've reached your Fable 5 limit.", errorDetails: '429 {"error":{"type":"overloaded_error"}}' }), families)).toBeNull();
    expect(classifyEnforcedLimit(errorRow({ text: "You've reached your Fable 5 limit.", errorDetails: "429 not json" }), families)).toBeNull();
    expect(classifyEnforcedLimit(errorRow({ text: "You've reached your Fable 5 limit." }), families)).toBeNull();
  });

  test("a credits_required body is the same credits branch", () => {
    const row = errorRow({ text: "Fable 5 requires usage credits.", errorDetails: '429 {"error":{"type":"rate_limit_error","details":{"error_code":"credits_required"}}}' });
    expect(classifyEnforcedLimit(row, families)).toEqual({ kind: "model", family: "fable", resetsAt: null });
  });

  test("high load and transient 429s are not exhaustion", () => {
    expect(classifyEnforcedLimit(errorRow({ text: "Fable is experiencing high load, please use /model to switch to Sonnet" }), families)).toBeNull();
    expect(classifyEnforcedLimit(errorRow({ text: "Server is temporarily limiting requests (not your usage limit)", apiErrorIsTransient: true }), families)).toBeNull();
    expect(classifyEnforcedLimit(errorRow({ text: "You've reached your Fable 5 limit.", apiErrorIsTransient: true }), families)).toBeNull();
  });

  test("the credits branch stamps nothing when its family is not a switch family", () => {
    const row = errorRow({ text: "You've reached your Fable 5 limit.", errorDetails: '429 {"error":{"type":"rate_limit_error"}}' });
    expect(classifyEnforcedLimit(row, ["sonnet"])).toBeNull();
    expect(classifyEnforcedLimit(row, [])).toBeNull();
  });
});

describe("findEnforcedRow", () => {
  test("pairs the row by content identity with last_assistant_message and anchors the turn at the preceding user row", () => {
    const rows = [userRow(NOW - 400_000), errorRow({ text: "old failure", at: NOW - 390_000 }), userRow(NOW - 30_000), errorRow({ text: "You've reached your Fable 5 limit.", at: NOW - 300_000 })];
    const found = findEnforcedRow({ rows, lastAssistantMessage: "You've reached your Fable 5 limit.", now: NOW });
    expect(transcriptRowText(found!.row)).toBe("You've reached your Fable 5 limit.");
    expect(found!.turnStartTs).toBe(NOW - 30_000);
  });

  test("without a content match only a recent row counts, so a previous turn's row cannot classify this failure", () => {
    const rows = [userRow(NOW - 400_000), errorRow({ text: "You've reached your Fable 5 limit.", at: NOW - 390_000 })];
    expect(findEnforcedRow({ rows, lastAssistantMessage: "Server is temporarily limiting requests", now: NOW })).toBeNull();
    expect(findEnforcedRow({ rows, lastAssistantMessage: undefined, now: NOW })).toBeNull();
    const recent = [...rows, userRow(NOW - 20_000), errorRow({ text: "You've hit your session limit", at: NOW - 5_000 })];
    expect(findEnforcedRow({ rows: recent, lastAssistantMessage: undefined, now: NOW })?.turnStartTs).toBe(NOW - 20_000);
  });

  test("skips non-error and non-rate_limit rows", () => {
    const rows = [userRow(NOW - 10_000), errorRow({ text: "auth", error: "authentication_failed", at: NOW - 1_000 }), { type: "assistant", timestamp: iso(NOW), message: { content: [{ type: "text", text: "fine" }] } }];
    expect(findEnforcedRow({ rows, lastAssistantMessage: "fine", now: NOW })).toBeNull();
  });
});

describe("readTranscriptTail", () => {
  test("reads the trailing rows of a large transcript and drops the torn first line", () => {
    mkdirSync(paths.home, { recursive: true });
    const file = join(paths.home, "tail-test.jsonl");
    const filler = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "x".repeat(2000) }] } });
    const lines = Array.from({ length: 300 }, () => filler);
    lines.push(JSON.stringify(userRow(NOW - 1_000)));
    lines.push(JSON.stringify(errorRow({ text: "You've reached your Fable 5 limit." })));
    writeFileSync(file, lines.join("\n") + "\n");
    const rows = readTranscriptTail(file, 64 * 1024);
    expect(rows.length).toBeGreaterThan(2);
    expect(rows.length).toBeLessThan(300);
    expect(rows.at(-1)?.isApiErrorMessage).toBe(true);
    expect(rows.at(-2)?.type).toBe("user");
  });

  test("an unreadable transcript yields no rows", () => {
    expect(readTranscriptTail(join(paths.home, "does-not-exist.jsonl"))).toEqual([]);
  });
});
