import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { minBy } from "es-toolkit";
import { z } from "zod";
import { paths } from "./paths.ts";
import { writeFileAtomic } from "./atomic.ts";
import { UNMANAGED_ENV, resolveRealClaude } from "./claudebin.ts";
import { pidExists } from "./proc.ts";
import { CloudTokenSchema, CloudTokensSchema, type CloudToken } from "./setuptokens.ts";
import { normalizeResetsAt, parseErrorBody, readTranscriptTail, scrubCredentialEnv } from "./usage.ts";

export const TOKENS_ENV = "TOKENMAXXING_TOKENS";
export const FALLBACK_WALL_MS = 5 * 3_600_000;
const RESERVATION_PREFIX = "pending:";

export function readCloudTokens(): CloudToken[] {
  const raw = process.env[TOKENS_ENV];
  if (raw == null || raw === "") {
    throw new Error(`${TOKENS_ENV} is not set - add it as a user-scoped Runtime Secret with the value \`tokenmaxxing setup-token --print\` prints`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`${TOKENS_ENV} is not valid JSON`);
  }
  const parsed = CloudTokensSchema.safeParse(json);
  if (!parsed.success) throw new Error(`${TOKENS_ENV} must be a non-empty JSON array of {label, token} objects`);
  const labels = parsed.data.map((t) => t.label);
  if (new Set(labels).size !== labels.length) throw new Error(`${TOKENS_ENV} carries a duplicate label`);
  const reserved = labels.find((label) => label in {});
  if (reserved != null) throw new Error(`${TOKENS_ENV} carries the label "${reserved}", which is a reserved object property name`);
  return parsed.data;
}

const SessionsSchema = z.record(z.string(), z.string());
const WalledSchema = z.record(z.string(), z.number());

function loadState<T>(file: string, schema: z.ZodType<T>, empty: T): T {
  if (!existsSync(file)) return empty;
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${file} is corrupt (unparsable JSON) - repair or remove the file`);
  }
  return schema.parse(json);
}

export function loadCloudSessions(): Record<string, string> {
  const sessions = loadState(paths.cloudSessionsJson, SessionsSchema, {});
  for (const key of Object.keys(sessions)) {
    if (!key.startsWith(RESERVATION_PREFIX)) continue;
    const pid = Number(key.slice(RESERVATION_PREFIX.length).split(":")[0]);
    if (!Number.isInteger(pid) || !pidExists(pid)) delete sessions[key];
  }
  return sessions;
}

export function saveCloudSessions(sessions: Record<string, string>): void {
  writeFileAtomic(paths.cloudSessionsJson, JSON.stringify(SessionsSchema.parse(sessions), null, 2) + "\n");
}

export function newReservationKey(): string {
  return `${RESERVATION_PREFIX}${process.pid}:${crypto.randomUUID().slice(0, 8)}`;
}

export function loadCloudWalled(): Record<string, number> {
  return loadState(paths.cloudWalledJson, WalledSchema, {});
}

export function saveCloudWalled(walled: Record<string, number>): void {
  writeFileAtomic(paths.cloudWalledJson, JSON.stringify(WalledSchema.parse(walled), null, 2) + "\n");
}

const PickSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), token: CloudTokenSchema }),
  z.object({ ok: z.literal(false), earliestReset: z.number() }),
]);
export type Pick = z.infer<typeof PickSchema>;

export function pickToken(input: {
  tokens: CloudToken[];
  sessions: Record<string, string>;
  walled: Record<string, number>;
  sessionId: string | null;
  now: number;
}): Pick {
  const walled = new Map(Object.entries(input.walled));
  const sessions = new Map(Object.entries(input.sessions));
  const open = (label: string) => (walled.get(label) ?? 0) <= input.now;
  if (input.sessionId != null) {
    const pinned = sessions.get(input.sessionId);
    const token = input.tokens.find((t) => t.label === pinned);
    if (token && open(token.label)) return { ok: true, token };
  }
  const candidates = input.tokens.filter((t) => open(t.label));
  if (candidates.length === 0) {
    return { ok: false, earliestReset: Math.min(...input.tokens.map((t) => walled.get(t.label) ?? input.now)) };
  }
  const load = new Map<string, number>();
  for (const label of sessions.values()) load.set(label, (load.get(label) ?? 0) + 1);
  return { ok: true, token: minBy(candidates, (t) => load.get(t.label) ?? 0) ?? candidates[0]! };
}

const ResultBase = {
  type: z.literal("result"),
  session_id: z.string(),
  is_error: z.boolean(),
  num_turns: z.number(),
  total_cost_usd: z.number(),
};
const CloudResultSchema = z.discriminatedUnion("subtype", [
  z.looseObject({ ...ResultBase, subtype: z.literal("success"), result: z.string(), api_error_status: z.number().nullish() }),
  z.looseObject({
    ...ResultBase,
    subtype: z.enum(["error_max_turns", "error_during_execution", "error_max_budget_usd", "error_max_structured_output_retries"]),
    errors: z.array(z.string()),
  }),
]);
export type CloudResult = z.infer<typeof CloudResultSchema>;

export async function spawnCloudClaude(input: {
  token: string;
  prompt: string;
  resume: string | null;
  maxTurns: number | null;
}): Promise<{ exitCode: number | null; result: CloudResult }> {
  const args = [
    "-p", "--output-format", "json", "--dangerously-skip-permissions",
    ...(input.resume ? ["--resume", input.resume] : []),
    ...(input.maxTurns != null ? ["--max-turns", String(input.maxTurns)] : []),
    "--", input.prompt,
  ];
  const env: Record<string, string> = { ...scrubCredentialEnv({ ...process.env, [UNMANAGED_ENV]: "1" }), CLAUDE_CODE_OAUTH_TOKEN: input.token };
  delete env[TOKENS_ENV];
  const child = Bun.spawn([resolveRealClaude(), ...args], { env, stdin: "ignore", stdout: "pipe", stderr: "inherit" });
  const stdout = await new Response(child.stdout).text();
  await child.exited;
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    throw new Error(`claude exited ${child.exitCode ?? "on signal"} without a JSON result: ${stdout.trim().slice(0, 200)}`);
  }
  const parsed = CloudResultSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`claude exited ${child.exitCode ?? "on signal"} with a result that does not match the documented result message: ${stdout.trim().slice(0, 200)}`);
  }
  return { exitCode: child.exitCode, result: parsed.data };
}

export function cloudTranscriptPath(sessionId: string): string | null {
  const projects = join(paths.claudeDir, "projects");
  if (!existsSync(projects)) return null;
  for (const dir of readdirSync(projects)) {
    const candidate = join(projects, dir, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function transcriptBytes(sessionId: string | null): number {
  const transcript = sessionId ? cloudTranscriptPath(sessionId) : null;
  return transcript ? statSync(transcript).size : 0;
}

export function limitWallUntil(input: { sessionId: string; sinceBytes: number; now: number }): number | null {
  const transcript = cloudTranscriptPath(input.sessionId);
  const rows = transcript ? readTranscriptTail(transcript, statSync(transcript).size - input.sinceBytes + 1) : [];
  const row = rows.findLast((r) => r.isApiErrorMessage === true);
  if (!row || row.error !== "rate_limit" || row.apiErrorIsTransient === true) return null;
  if ((row.quotaLimits?.rateLimitType ?? "") === "" && parseErrorBody(row.errorDetails)?.error?.type !== "rate_limit_error") return null;
  const resetsAt = row.quotaLimits?.resetsAt != null ? normalizeResetsAt(row.quotaLimits.resetsAt) : null;
  return resetsAt != null && resetsAt > input.now ? resetsAt : input.now + FALLBACK_WALL_MS;
}
