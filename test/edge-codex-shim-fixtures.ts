import { basename } from "node:path";
import { z } from "zod";
import { readLines } from "../src/lib/proc.ts";

const SELF = import.meta.path;
export const THREAD_ID = "thread-main";
const SIDE_THREAD_ID = "thread-side";
const REFUSAL = { message: "You've hit your usage limit. Try again later.", codexErrorInfo: "usageLimitExceeded" };

const MessageSchema = z.looseObject({
  id: z.union([z.string(), z.number()]).nullish(),
  method: z.string().optional(),
  params: z.record(z.string(), z.unknown()).nullish(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});
type Message = z.infer<typeof MessageSchema>;

export function objectOf(line: string): Message | null {
  try {
    return MessageSchema.safeParse(JSON.parse(line)).data ?? null;
  } catch {
    return null;
  }
}

export function messages(lines: string[]): Message[] {
  return lines.flatMap((line): Message[] => {
    const msg = objectOf(line);
    return msg == null ? [] : [msg];
  });
}

const turn = (id: string, status: string, error: unknown = null) => ({ id, items: [], status, error });

async function fakeAppServer(): Promise<void> {
  const home = process.env.CODEX_HOME ?? "";
  const refuses = home === process.env.EDGE_REFUSE_HOME;
  let turns = 0;
  const send = (msg: unknown): void => void process.stdout.write(`${JSON.stringify(msg)}\n`);
  const notify = (method: string, params: Record<string, unknown>): void => send({ method, params: { threadId: THREAD_ID, ...params } });
  for await (const line of readLines(Bun.stdin.stream())) {
    const msg = objectOf(line);
    if (msg == null) {
      send({ method: "test/fromClient", params: { line } });
      continue;
    }
    if (msg.method === "initialize") {
      send({ id: msg.id, result: { userAgent: "fake-codex" } });
      if (process.env.EDGE_NOISE === "1") process.stdout.write("fake-codex: warming up\n[1,2,3]\n");
    }
    if (msg.method === "thread/start") send({ id: msg.id, result: { thread: { id: msg.params?.ephemeral === true ? SIDE_THREAD_ID : THREAD_ID } } });
    if (msg.method === "thread/resume") send({ id: msg.id, result: { thread: { id: THREAD_ID } } });
    if (msg.method !== "turn/start") continue;
    const turnId = `${basename(home)}-turn-${++turns}`;
    send({ id: msg.id, result: { turn: turn(turnId, "inProgress") } });
    if (!refuses) await Bun.sleep(100);
    notify("turn/started", { turn: turn(turnId, "inProgress") });
    if (refuses) {
      notify("error", { error: REFUSAL, willRetry: false, turnId });
      notify("turn/completed", { turn: turn(turnId, "failed", REFUSAL) });
      continue;
    }
    notify("item/completed", { turnId, item: { type: "agentMessage", id: `msg-${turnId}`, text: home } });
    notify("turn/completed", { turn: turn(turnId, "completed") });
  }
}

const ProxyConfigSchema = z.object({ store: z.string(), seatId: z.string() });
type ProxyConfig = z.infer<typeof ProxyConfigSchema>;

async function proxy(config: ProxyConfig): Promise<void> {
  const { runCodexAppServer } = await import("../src/lib/codexappserver.ts");
  const code = await runCodexAppServer({
    real: process.execPath,
    argv: [SELF, "fake", "{}"],
    env: { ...process.env },
    seat: { store: config.store, id: config.seatId },
    onSpawn: () => {},
  });
  process.exit(code);
}

type Step = { send: string[]; until: (seen: string[]) => boolean };

export const rpc = (msg: Record<string, unknown>): string => JSON.stringify(msg);

export const opening = (cwd: string): string[] => [
  rpc({ id: 1, method: "initialize", params: { clientInfo: { name: "test", version: "1" } } }),
  rpc({ method: "initialized" }),
  rpc({ id: 2, method: "thread/start", params: { cwd } }),
];

export const replied = (id: number) => (seen: string[]): boolean => messages(seen).some((m) => m.method === undefined && m.id === id);

export const turnEnded = (seen: string[]): boolean => messages(seen).some((m) => m.method === "turn/completed");

export async function drive(input: { store: string; seatId: string; env?: Record<string, string>; steps: Step[] }): Promise<string[]> {
  const proc = Bun.spawn([process.execPath, SELF, "proxy", JSON.stringify({ store: input.store, seatId: input.seatId })], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    env: { ...process.env, ...input.env },
    timeout: 25_000,
  });
  const write = (line: string): void => {
    proc.stdin.write(`${line}\n`);
    proc.stdin.flush();
  };
  const lines = readLines(proc.stdout);
  const seen: string[] = [];
  for (const step of input.steps) {
    for (const line of step.send) write(line);
    while (!step.until(seen)) {
      const next = await lines.next();
      if (next.done) throw new Error(`the shim closed its stdout after ${JSON.stringify(seen)}`);
      seen.push(next.value);
    }
  }
  proc.stdin.end();
  for await (const line of lines) seen.push(line);
  await proc.exited;
  return seen;
}

const TimelineSchema = z.looseObject({
  turnId: z.string().optional(),
  error: z.looseObject({ codexErrorInfo: z.string() }).optional(),
  turn: z.looseObject({ id: z.string(), status: z.string() }).optional(),
});

export function timeline(seen: string[]): string[] {
  return messages(seen).flatMap((m) => {
    const p = TimelineSchema.safeParse(m.params).data;
    if (m.method === "error") return [`error ${p?.turnId} ${p?.error?.codexErrorInfo}`];
    if (m.method === "turn/started" || m.method === "turn/completed") return [`${m.method} ${p?.turn?.id} ${p?.turn?.status}`];
    return [];
  });
}

const AnswerSchema = z.looseObject({ item: z.looseObject({ text: z.string() }) });

export function answerText(seen: string[]): string | null {
  return AnswerSchema.safeParse(messages(seen).findLast((m) => m.method === "item/completed")?.params).data?.item.text ?? null;
}

if (import.meta.main) {
  const [mode, config] = z.tuple([z.enum(["fake", "proxy"]), z.string()]).parse(Bun.argv.slice(2));
  if (mode === "fake") await fakeAppServer();
  else await proxy(ProxyConfigSchema.parse(JSON.parse(config)));
}
