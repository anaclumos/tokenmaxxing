import { readFileSync } from "node:fs";
import { join } from "node:path";
import { delay } from "es-toolkit";
import { z } from "zod";
import { errorMessage, log } from "./log.ts";
import { readLines } from "./proc.ts";
import { JsonTextSchema } from "./types.ts";

export type CompactOutcome = { ok: true } | { ok: false; reason: string };

export const CLAUDE_COMPACT_KILL_MS = 300_000;
const PIPE_GRACE_MS = 2_000;

export async function compactClaudeSession(input: { real: string; sid: string; env: Record<string, string | undefined> }): Promise<CompactOutcome> {
  const p = Bun.spawn([input.real, "-p", "--resume", input.sid, "/compact"], {
    env: input.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: CLAUDE_COMPACT_KILL_MS,
    killSignal: "SIGKILL",
  });
  const reads = Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const settled = await Promise.race([reads, p.exited.then(() => delay(PIPE_GRACE_MS)).then(() => null)]);
  await p.exited;
  if (settled === null) return { ok: false, reason: "output pipes still open after child exit (leaked descendant)" };
  const [stdout, stderr] = settled;
  if (p.exitCode === 0) return { ok: true };
  if (p.exitCode === null) return { ok: false, reason: `killed after ${CLAUDE_COMPACT_KILL_MS / 1000}s` };
  return { ok: false, reason: `exit ${p.exitCode}: ${(stderr.trim() || stdout.trim()).slice(0, 200)}` };
}

export const CODEX_COMPACT_KILL_MS = 180_000;

const RpcLineSchema = z.looseObject({
  id: z.union([z.number(), z.string()]).optional(),
  method: z.string().optional(),
  error: z.looseObject({ message: z.string().optional() }).optional(),
  params: z.unknown().optional(),
});
const TurnCompletedSchema = z.looseObject({
  threadId: z.string(),
  turn: z.looseObject({ status: z.string(), error: z.looseObject({ message: z.string() }).nullable().optional() }),
});
const ErrorNotificationSchema = z.looseObject({ threadId: z.string().nullable().optional(), error: z.looseObject({ message: z.string().optional() }).optional() });

const INIT_ID = 1;
const RESUME_ID = 2;
const COMPACT_ID = 3;

const packageVersion = (): string =>
  z.object({ version: z.string().min(1) }).parse(JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8"))).version;

export async function compactCodexThread(input: { real: string; threadId: string; env: Record<string, string | undefined> }): Promise<CompactOutcome> {
  const p = Bun.spawn([input.real, "app-server"], {
    env: input.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    timeout: CODEX_COMPACT_KILL_MS,
    killSignal: "SIGKILL",
  });
  const send = (msg: Record<string, unknown>): void => {
    p.stdin.write(`${JSON.stringify(msg)}\n`);
    p.stdin.flush();
  };
  const stderrText = new Response(p.stderr).text();

  const outcome = await new Promise<CompactOutcome>((resolve) => {
    let finished = false;
    const finish = (o: CompactOutcome): void => {
      if (finished) return;
      finished = true;
      resolve(o);
    };
    const onLine = (line: string): void => {
      const parsed = RpcLineSchema.safeParse(JsonTextSchema.safeParse(line).data);
      if (!parsed.success) return;
      const msg = parsed.data;
      if (msg.id === INIT_ID) {
        if (msg.error) return finish({ ok: false, reason: `initialize failed: ${msg.error.message ?? "unknown error"}` });
        send({ method: "initialized" });
        send({ id: RESUME_ID, method: "thread/resume", params: { threadId: input.threadId } });
        return;
      }
      if (msg.id === RESUME_ID) {
        if (msg.error) return finish({ ok: false, reason: `thread/resume failed: ${msg.error.message ?? "unknown error"}` });
        send({ id: COMPACT_ID, method: "thread/compact/start", params: { threadId: input.threadId } });
        return;
      }
      if (msg.id === COMPACT_ID) {
        if (msg.error) return finish({ ok: false, reason: `thread/compact/start failed: ${msg.error.message ?? "unknown error"}` });
        return;
      }
      if (msg.method === "turn/completed") {
        const turn = TurnCompletedSchema.safeParse(msg.params);
        if (!turn.success || turn.data.threadId !== input.threadId) return;
        if (turn.data.turn.status === "completed") return finish({ ok: true });
        return finish({ ok: false, reason: `compaction turn ${turn.data.turn.status}: ${turn.data.turn.error?.message ?? "no error message"}` });
      }
      if (msg.method === "error") {
        const err = ErrorNotificationSchema.safeParse(msg.params);
        if (err.success && err.data.threadId != null && err.data.threadId !== input.threadId) return;
        return finish({ ok: false, reason: `app-server error: ${err.success ? (err.data.error?.message ?? "unknown error") : "unparsable error notification"}` });
      }
    };
    (async () => {
      for await (const line of readLines(p.stdout)) onLine(line);
      const err = (await stderrText).trim().slice(0, 200);
      finish({ ok: false, reason: p.exitCode === null ? `app-server killed after ${CODEX_COMPACT_KILL_MS / 1000}s` : `app-server exited ${p.exitCode}: ${err}` });
    })().catch((e) => finish({ ok: false, reason: errorMessage(e) }));
    send({ id: INIT_ID, method: "initialize", params: { clientInfo: { name: "tokenmaxxing", version: packageVersion() } } });
  });

  try {
    p.stdin.end();
  } catch {
  }
  p.kill();
  await p.exited;
  log("compact.codex", { thread: input.threadId.slice(0, 8), ok: outcome.ok, reason: outcome.ok ? undefined : outcome.reason });
  return outcome;
}
