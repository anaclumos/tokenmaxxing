import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { readLines } from "../src/lib/proc.ts";

const SELF = import.meta.path;
export const THREAD_ID = "thread-1";
export const RATE_LIMITS_UPDATED = "account/rateLimits/updated";
export const START_RECEIVED = "test/turnStartReceived";
const SLOW_ACK_MS = 300;
const APPROVAL_ID = 0;
const OVERLOAD = { message: "Selected model is at capacity. Please try a different model.", codexErrorInfo: "serverOverloaded" };
const CONTEXT_FULL = { message: "Your input exceeds the context window of this model.", codexErrorInfo: "contextWindowExceeded", additionalDetails: null };

const OutcomeSchema = z.enum(["answer", "params", "overload", "overloadUnflagged", "retriedOverload", "contextFull", "approval", "hang", "slowHang"]);
const ScriptSchema = z.tuple([OutcomeSchema], OutcomeSchema);
type Outcome = z.infer<typeof OutcomeSchema>;
type Script = z.infer<typeof ScriptSchema>;
const ProxyConfigSchema = z.object({ script: ScriptSchema, windowMs: z.number(), delaysMs: z.tuple([z.number(), z.number()]) });
type ProxyConfig = z.infer<typeof ProxyConfigSchema>;

const RequestSchema = z.looseObject({ id: z.union([z.string(), z.number()]).optional(), method: z.string().optional(), params: z.record(z.string(), z.unknown()).optional(), result: z.unknown().optional() });
const TurnStartSchema = z.looseObject({ input: z.array(z.looseObject({ text: z.string() })), toolOutput: z.unknown().optional() });
const InterruptSchema = z.looseObject({ turnId: z.string() });
const SteerSchema = z.looseObject({ expectedTurnId: z.string(), input: z.array(z.looseObject({ text: z.string() })) });
const ApprovalSchema = z.looseObject({ decision: z.string() });

const send = (msg: unknown): void => void process.stdout.write(`${JSON.stringify(msg)}\n`);
const notify = (method: string, params: Record<string, unknown>): void => send({ method, params: { threadId: THREAD_ID, ...params } });
const turn = (id: string, status: string, error: unknown = null) => ({ id, items: [], status, error });

async function fakeAppServer(script: Script): Promise<void> {
  const inputs: string[] = [];
  const starts: unknown[] = [];
  let turns = 0;
  const last = script.at(-1) ?? script[0];
  const running: { turnId: string | null } = { turnId: null };
  const overloaded = () => ({ ...OVERLOAD, additionalDetails: JSON.stringify(inputs) });
  const answer = (turnId: string, text: string): void => {
    notify("item/completed", { turnId, item: { type: "agentMessage", id: `msg-${turnId}`, text } });
    notify("turn/completed", { turn: turn(turnId, "completed") });
  };
  const fail = (turnId: string, error: Record<string, unknown>, retry: { willRetry?: boolean }): void => {
    notify("error", { error, ...retry, turnId });
    notify("turn/completed", { turn: turn(turnId, "failed", error) });
    send({ method: RATE_LIMITS_UPDATED, params: { rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: null }, secondary: null } } });
  };
  const plays: Record<Outcome, (turnId: string) => void> = {
    answer: (turnId) => answer(turnId, JSON.stringify(inputs)),
    params: (turnId) => answer(turnId, JSON.stringify(starts)),
    overload: (turnId) => fail(turnId, overloaded(), { willRetry: false }),
    overloadUnflagged: (turnId) => fail(turnId, overloaded(), {}),
    retriedOverload: (turnId) => {
      notify("error", { error: overloaded(), willRetry: true, turnId });
      answer(turnId, JSON.stringify(inputs));
    },
    contextFull: (turnId) => fail(turnId, CONTEXT_FULL, { willRetry: false }),
    approval: (turnId) => {
      notify("item/started", { turnId, item: { type: "agentMessage", id: `msg-${turnId}`, text: "" } });
      notify("item/agentMessage/delta", { turnId, itemId: `msg-${turnId}`, delta: "Running the tests." });
      notify("thread/tokenUsage/updated", { turnId, tokenUsage: { total: { inputTokens: 1200, outputTokens: 80 } } });
      notify("turn/diff/updated", { turnId, diff: "" });
      send({ id: APPROVAL_ID, method: "item/commandExecution/requestApproval", params: { threadId: THREAD_ID, turnId, itemId: `cmd-${turnId}`, command: "bun test", cwd: "/repo", reason: null } });
      running.turnId = turnId;
    },
    hang: (turnId) => {
      notify("item/started", { turnId, item: { type: "agentMessage", id: `msg-${turnId}`, text: "" } });
      running.turnId = turnId;
    },
    slowHang: (turnId) => plays.hang(turnId),
  };
  for await (const line of readLines(Bun.stdin.stream())) {
    const msg = RequestSchema.parse(JSON.parse(line));
    if (msg.method === "initialize") send({ id: msg.id, result: { userAgent: "fake-codex" } });
    if (msg.method === "thread/start") send({ id: msg.id, result: { thread: { id: THREAD_ID } } });
    if (msg.method === undefined && msg.id === APPROVAL_ID && running.turnId != null) {
      const { decision } = ApprovalSchema.parse(msg.result);
      notify("item/completed", { turnId: running.turnId, item: { type: "commandExecution", id: `cmd-${running.turnId}`, command: "bun test", status: decision === "accept" ? "completed" : "declined" } });
      answer(running.turnId, JSON.stringify(inputs));
      running.turnId = null;
    }
    if (msg.method === "turn/interrupt") {
      const { turnId } = InterruptSchema.parse(msg.params);
      if (turnId === running.turnId) {
        send({ id: msg.id, result: {} });
        notify("turn/completed", { turn: turn(turnId, "interrupted") });
        running.turnId = null;
      } else send({ id: msg.id, error: { code: -32600, message: `no running turn ${turnId}` } });
    }
    if (msg.method === "turn/steer") {
      const { expectedTurnId, input } = SteerSchema.parse(msg.params);
      if (expectedTurnId === running.turnId) {
        send({ id: msg.id, result: { turnId: expectedTurnId } });
        answer(expectedTurnId, JSON.stringify([...inputs, ...input.map((i) => i.text)]));
        running.turnId = null;
      } else send({ id: msg.id, error: { code: -32600, message: `expected turn ${expectedTurnId} is not running` } });
    }
    if (msg.method !== "turn/start") continue;
    const params = TurnStartSchema.parse(msg.params);
    if (params.toolOutput != null && params.input.length > 0) {
      send({ id: msg.id, error: { code: -32600, message: "`toolOutput` cannot be combined with nonempty `input`" } });
      continue;
    }
    starts.push(params);
    inputs.push(params.input.map((i) => i.text).join(""));
    if (running.turnId != null) {
      send({ id: msg.id, result: { turn: turn(running.turnId, "inProgress") } });
      answer(running.turnId, JSON.stringify(inputs));
      running.turnId = null;
      continue;
    }
    const outcome = script[turns] ?? last;
    const turnId = `turn-${++turns}`;
    if (outcome === "slowHang") {
      notify(START_RECEIVED, { turnId });
      await Bun.sleep(SLOW_ACK_MS);
    }
    send({ id: msg.id, result: { turn: turn(turnId, "inProgress") } });
    notify("turn/started", { turn: turn(turnId, "inProgress") });
    plays[outcome](turnId);
  }
}

async function proxy(config: ProxyConfig): Promise<void> {
  const { runCodexAppServer } = await import("../src/lib/codexappserver.ts");
  const [firstDelayMs, laterDelayMs] = config.delaysMs;
  const code = await runCodexAppServer({
    real: process.execPath,
    argv: [SELF, "fake", JSON.stringify(config.script)],
    env: { ...process.env },
    seat: { store: mkdtempSync(join(tmpdir(), "tokenmaxxing-store-")), id: "acct-test" },
    onSpawn: () => {},
    overload: { windowMs: config.windowMs, delayMs: (attempt) => (attempt === 0 ? firstDelayMs : laterDelayMs) },
  });
  process.exit(code);
}

const ClientMessageSchema = z.looseObject({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
type Step ={ send: unknown[] | ((seen: ClientMessage[]) => unknown[]); until: (since: ClientMessage[]) => boolean };

export const turnStart = (id: number, text: string, params: Record<string, unknown> = {}) => ({ id, method: "turn/start", params: { threadId: THREAD_ID, input: [{ type: "text", text }], ...params } });
export const interrupt = (id: number, turnId: string) => ({ id, method: "turn/interrupt", params: { threadId: THREAD_ID, turnId } });
export const steer = (id: number, expectedTurnId: string, text: string) => ({ id, method: "turn/steer", params: { threadId: THREAD_ID, input: [{ type: "text", text }], expectedTurnId } });
export const endsTurn = (since: ClientMessage[]): boolean => since.at(-1)?.method === "turn/completed";

export async function converse(input: { script: Script; windowMs: number; delaysMs?: [number, number]; steps: Step[] }): Promise<ClientMessage[]> {
  const home = mkdtempSync(join(tmpdir(), "tokenmaxxing-test-"));
  const config: ProxyConfig = { script: input.script, windowMs: input.windowMs, delaysMs: input.delaysMs ?? [5, 5] };
  const proc = Bun.spawn([process.execPath, SELF, "proxy", JSON.stringify(config)], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    env: { ...process.env, TOKENMAXXING_HOME: home },
    timeout: 15_000,
  });
  const write = (msg: unknown): void => {
    proc.stdin.write(`${JSON.stringify(msg)}\n`);
    proc.stdin.flush();
  };
  write({ id: 1, method: "initialize", params: { clientInfo: { name: "test", version: "1" } } });
  write({ method: "initialized" });
  write({ id: 2, method: "thread/start", params: { cwd: home } });
  const lines = readLines(proc.stdout);
  const seen: ClientMessage[] = [];
  for (const step of input.steps) {
    for (const msg of typeof step.send === "function" ? step.send(seen) : step.send) write(msg);
    const since: ClientMessage[] = [];
    while (!step.until(since)) {
      const next = await lines.next();
      if (next.done) throw new Error(`the shim closed its stdout after ${JSON.stringify(seen)}`);
      const msg = ClientMessageSchema.parse(JSON.parse(next.value));
      since.push(msg);
      seen.push(msg);
    }
  }
  proc.stdin.end();
  for await (const line of lines) seen.push(ClientMessageSchema.parse(JSON.parse(line)));
  await proc.exited;
  return seen;
}

export const runTurnThroughProxy = (input: { script: Script; windowMs: number; delaysMs?: [number, number] }): Promise<ClientMessage[]> =>
  converse({ ...input, steps: [{ send: [turnStart(3, "Review the diff.")], until: endsTurn }] });

const TimelineSchema = z.looseObject({
  turnId: z.string().optional(),
  error: z.looseObject({ codexErrorInfo: z.string() }).optional(),
  turn: z.looseObject({ id: z.string(), status: z.string() }).optional(),
});

export function timeline(seen: ClientMessage[]): string[] {
  return seen.flatMap((m) => {
    const p = TimelineSchema.safeParse(m.params).data;
    if (m.method === "error") return [`error ${p?.turnId} ${p?.error?.codexErrorInfo}`];
    if (m.method === "turn/started" || m.method === "turn/completed") return [`${m.method} ${p?.turn?.id} ${p?.turn?.status}`];
    return [];
  });
}

export const answerOf = (seen: ClientMessage[]) => z.looseObject({ turnId: z.string(), item: z.looseObject({ text: z.string() }) }).parse(seen.findLast((m) => m.method === "item/completed")?.params);

if (import.meta.main) {
  const [mode, config] = z.tuple([z.enum(["fake", "proxy"]), z.string()]).parse(Bun.argv.slice(2));
  if (mode === "fake") await fakeAppServer(ScriptSchema.parse(JSON.parse(config)));
  else await proxy(ProxyConfigSchema.parse(JSON.parse(config)));
}
