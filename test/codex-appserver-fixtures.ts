import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { readLines } from "../src/lib/proc.ts";

const SELF = import.meta.path;
const THREAD_ID = "thread-1";
const OVERLOAD = { message: "Selected model is at capacity. Please try a different model.", codexErrorInfo: "serverOverloaded", additionalDetails: null };

const RequestSchema = z.looseObject({ id: z.union([z.string(), z.number()]).optional(), method: z.string(), params: z.record(z.string(), z.unknown()).optional() });
const TurnStartSchema = z.looseObject({ input: z.array(z.looseObject({ text: z.string() })) });

const send = (msg: unknown): void => void process.stdout.write(`${JSON.stringify(msg)}\n`);

async function fakeAppServer(failures: number): Promise<void> {
  const inputs: string[] = [];
  for await (const line of readLines(Bun.stdin.stream())) {
    const msg = RequestSchema.parse(JSON.parse(line));
    if (msg.method === "initialize") send({ id: msg.id, result: { userAgent: "fake-codex" } });
    if (msg.method === "thread/start") send({ id: msg.id, result: { thread: { id: THREAD_ID } } });
    if (msg.method !== "turn/start") continue;
    inputs.push(TurnStartSchema.parse(msg.params).input.map((i) => i.text).join(""));
    const turnId = `turn-${inputs.length}`;
    send({ id: msg.id, result: { turn: { id: turnId, items: [], status: "inProgress", error: null } } });
    send({ method: "turn/started", params: { threadId: THREAD_ID, turn: { id: turnId, items: [], status: "inProgress", error: null } } });
    if (inputs.length <= failures) {
      send({ method: "error", params: { error: OVERLOAD, willRetry: false, threadId: THREAD_ID, turnId } });
      send({ method: "turn/completed", params: { threadId: THREAD_ID, turn: { id: turnId, items: [], status: "failed", error: OVERLOAD } } });
      continue;
    }
    send({ method: "item/completed", params: { threadId: THREAD_ID, turnId, item: { type: "agentMessage", id: `msg-${turnId}`, text: JSON.stringify(inputs) } } });
    send({ method: "turn/completed", params: { threadId: THREAD_ID, turn: { id: turnId, items: [], status: "completed", error: null } } });
  }
}

async function proxy(failures: number, windowMs: number): Promise<void> {
  const { runCodexAppServer } = await import("../src/lib/codexappserver.ts");
  const code = await runCodexAppServer({
    real: process.execPath,
    argv: [SELF, "fake", String(failures)],
    env: { ...process.env },
    seat: { store: mkdtempSync(join(tmpdir(), "tokenmaxxing-store-")), id: "acct-test" },
    onSpawn: () => {},
    overload: { windowMs, delayMs: () => 5 },
  });
  process.exit(code);
}

export type ClientMessage = { id?: string | number; method?: string; params?: Record<string, unknown>; result?: unknown };
const ClientMessageSchema = z.looseObject({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  result: z.unknown().optional(),
});

export async function runTurnThroughProxy(input: { failures: number; windowMs: number }): Promise<ClientMessage[]> {
  const home = mkdtempSync(join(tmpdir(), "tokenmaxxing-test-"));
  const proc = Bun.spawn([process.execPath, SELF, "proxy", String(input.failures), String(input.windowMs)], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    env: { ...process.env, TOKENMAXXING_HOME: home },
  });
  const write = (msg: unknown): void => {
    proc.stdin.write(`${JSON.stringify(msg)}\n`);
    proc.stdin.flush();
  };
  write({ id: 1, method: "initialize", params: { clientInfo: { name: "test", version: "1" } } });
  write({ method: "initialized" });
  write({ id: 2, method: "thread/start", params: { cwd: home } });
  write({ id: 3, method: "turn/start", params: { threadId: THREAD_ID, input: [{ type: "text", text: "Review the diff." }] } });
  const seen: ClientMessage[] = [];
  for await (const line of readLines(proc.stdout)) {
    const msg = ClientMessageSchema.parse(JSON.parse(line));
    seen.push(msg);
    if (msg.method === "turn/completed") break;
  }
  proc.stdin.end();
  await proc.exited;
  return seen;
}

if (import.meta.main) {
  const [mode, a, b] = Bun.argv.slice(2);
  if (mode === "fake") await fakeAppServer(Number(a));
  if (mode === "proxy") await proxy(Number(a), Number(b));
}
