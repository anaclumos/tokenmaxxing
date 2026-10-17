import { once } from "node:events";
import type { Subprocess } from "bun";
import { pick } from "es-toolkit";
import { z } from "zod";
import { borrowCodexSeat, codexPickCtx, observeCodex } from "./codex.ts";
import { withLock } from "./lock.ts";
import { errorMessage, log } from "./log.ts";
import { codexPaths, codexPool } from "./paths.ts";
import { isExhausted } from "./picker.ts";
import { clearPresence, writePresence } from "./presence.ts";
import { readLines } from "./proc.ts";
import { loadAccounts, loadConfig, saveAccounts } from "./state.ts";
import { exitStatus } from "./supervise.ts";

const WATCH_MS = 60_000;
const REFUSED_HOLD_MS = 30 * 60 * 1000;
const REPLAY_TIMEOUT_MS = 30_000;
const STOP_GRACE_MS = 5_000;
const PENDING_STALE_MS = 10 * 60 * 1000;
const REPLAY_ID = "tokenmaxxing-replay-";
const THREAD_OPENERS = new Set(["thread/start", "thread/resume", "thread/fork"]);
const RESUME_KEYS = ["approvalPolicy", "approvalsReviewer", "baseInstructions", "config", "cwd", "developerInstructions", "model", "modelProvider", "personality", "sandbox", "serviceTier"];

const RpcSchema = z.looseObject({
  id: z.union([z.string(), z.number()]).nullish(),
  method: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  result: z.unknown().optional(),
});
type Rpc = z.infer<typeof RpcSchema>;

const OpenedSchema = z.looseObject({ thread: z.looseObject({ id: z.string() }) });
const ThreadParamsSchema = z.looseObject({ threadId: z.string() });
const RefusalSchema = z.looseObject({ codexErrorInfo: z.literal("usageLimitExceeded") });
const TurnRefusalSchema = z.looseObject({ turn: z.looseObject({ error: RefusalSchema }) });
const ErrorRefusalSchema = z.looseObject({ error: RefusalSchema, willRetry: z.literal(false).optional() });

function parseRpc(line: string): Rpc | null {
  try {
    return RpcSchema.safeParse(JSON.parse(line)).data ?? null;
  } catch {
    return null;
  }
}

const idKey = (id: string | number): string => `${typeof id}:${id}`;

export class AppServerState {
  initialize: Record<string, unknown> | null = null;
  initialized = false;
  readonly threads = new Map<string, Record<string, unknown>>();
  private readonly pending = new Map<string, { method: string; params: Record<string, unknown>; at: number }>();
  private readonly busy = new Set<string>();

  fromClient(msg: Rpc): void {
    if (msg.method === "initialize") this.initialize = msg.params ?? {};
    if (msg.method === "initialized") this.initialized = true;
    if (msg.method != null && msg.id != null) this.pending.set(idKey(msg.id), { method: msg.method, params: msg.params ?? {}, at: Date.now() });
  }

  fromServer(msg: Rpc): { refused: boolean; turnEnded: boolean } {
    if (msg.method == null && msg.id != null) {
      const asked = this.pending.get(idKey(msg.id));
      this.pending.delete(idKey(msg.id));
      const opened = asked && THREAD_OPENERS.has(asked.method) && asked.params.ephemeral !== true ? OpenedSchema.safeParse(msg.result).data : undefined;
      if (asked && opened) this.threads.set(opened.thread.id, pick(asked.params, RESUME_KEYS));
      return { refused: false, turnEnded: false };
    }
    const threadId = ThreadParamsSchema.safeParse(msg.params).data?.threadId;
    if (msg.method === "turn/started" && threadId != null) this.busy.add(threadId);
    if (msg.method === "turn/completed" && threadId != null) {
      this.busy.delete(threadId);
      return { refused: TurnRefusalSchema.safeParse(msg.params).success, turnEnded: true };
    }
    if (msg.method === "thread/closed" && threadId != null) {
      this.busy.delete(threadId);
      this.threads.delete(threadId);
    }
    return { refused: msg.method === "error" && ErrorRefusalSchema.safeParse(msg.params).success, turnEnded: false };
  }

  idle(now = Date.now()): boolean {
    return this.busy.size === 0 && [...this.pending.values()].every((p) => now - p.at > PENDING_STALE_MS);
  }

  replay(): Rpc[] {
    if (this.initialize == null) return [];
    return [
      { method: "initialize", params: this.initialize },
      ...(this.initialized ? [{ method: "initialized" }] : []),
      ...[...this.threads].map(([threadId, params]) => ({ method: "thread/resume", params: { ...params, threadId, excludeTurns: true } })),
    ];
  }
}

async function heldExhausted(accountId: string): Promise<boolean> {
  const now = Date.now();
  const account = loadAccounts(codexPool).accounts.find((a) => a.id === accountId);
  if (!account) return false;
  await observeCodex(account, loadConfig(), now, { probe: true, refresh: false });
  const current = loadAccounts(codexPool).accounts.find((a) => a.id === accountId) ?? account;
  return current.needsReauth === true || isExhausted(current, codexPickCtx(now, null));
}

async function holdRefused(accountId: string): Promise<void> {
  await withLock(codexPool.lockFile, () => {
    const idx = loadAccounts(codexPool);
    const a = idx.accounts.find((x) => x.id === accountId);
    if (!a) return;
    a.enforcedUntil = Math.max(a.enforcedUntil ?? 0, Date.now() + REFUSED_HOLD_MS);
    saveAccounts(codexPool, idx);
  });
}

async function writeOut(line: string): Promise<void> {
  if (!process.stdout.write(`${line}\n`)) await once(process.stdout, "drain");
}

export async function runCodexAppServer(input: {
  real: string;
  argv: string[];
  env: Record<string, string | undefined>;
  seat: { store: string; id: string };
  onSpawn: (child: Subprocess<"pipe", "pipe", "inherit">) => void;
}): Promise<number> {
  const seatId = `seat-${process.pid}`;
  const state = new AppServerState();
  const retired = new Set<Subprocess>();
  const waiters = new Map<string, () => void>();
  const queued: string[] = [];
  let held = input.seat.id;
  let replays = 0;
  let replaying = false;
  let moving: Promise<void> | null = null;
  let wantMove = false;
  let checking = false;
  let holding: Promise<void> = Promise.resolve();
  let finish: (code: number) => void = () => {};
  const done = new Promise<number>((resolve) => { finish = resolve; });

  const toChild = (p: Subprocess<"pipe", "pipe", "inherit">, line: string): void => {
    try {
      p.stdin.write(`${line}\n`);
      p.stdin.flush();
    } catch (e) {
      log("codexappserver.write_failed", { err: errorMessage(e) });
    }
  };

  const spawn = (store: string): Subprocess<"pipe", "pipe", "inherit"> => {
    const p = Bun.spawn([input.real, ...input.argv], { stdin: "pipe", stdout: "pipe", stderr: "inherit", env: { ...input.env, CODEX_HOME: store } });
    input.onSpawn(p);
    void (async () => {
      for await (const line of readLines(p.stdout)) {
        const msg = parseRpc(line);
        if (typeof msg?.id === "string" && msg.id.startsWith(REPLAY_ID) && msg.method == null) {
          waiters.get(msg.id)?.();
          continue;
        }
        if (replaying && p === child) continue;
        if (msg) {
          const seen = state.fromServer(msg);
          if (seen.refused) {
            log("codexappserver.refused", { account: held.slice(0, 8) });
            const refusedId = held;
            holding = holding.then(() => holdRefused(refusedId)).catch((e: unknown) => log("codexappserver.hold_failed", { err: errorMessage(e) }));
            wantMove = true;
          }
          if (seen.turnEnded) void check();
        }
        await writeOut(line);
      }
    })().catch((e: unknown) => log("codexappserver.stdout_failed", { err: errorMessage(e) }));
    void p.exited.then(() => {
      if (!retired.has(p)) finish(exitStatus(p));
    });
    return p;
  };

  let child = spawn(input.seat.store);

  const send = async (p: Subprocess<"pipe", "pipe", "inherit">, msg: Rpc): Promise<void> => {
    if (msg.method === "initialized") return toChild(p, JSON.stringify(msg));
    const id = `${REPLAY_ID}${++replays}`;
    const answered = new Promise<void>((resolve) => waiters.set(id, resolve));
    toChild(p, JSON.stringify({ ...msg, id }));
    const timedOut = await Promise.race([answered.then(() => false), Bun.sleep(REPLAY_TIMEOUT_MS).then(() => true)]);
    waiters.delete(id);
    if (timedOut) log("codexappserver.replay_timeout", { method: msg.method });
  };

  const stop = async (p: Subprocess): Promise<void> => {
    retired.add(p);
    p.kill("SIGTERM");
    const exited = await Promise.race([p.exited.then(() => true), Bun.sleep(STOP_GRACE_MS).then(() => false)]);
    if (!exited) {
      p.kill("SIGKILL");
      await p.exited;
    }
  };

  const move = async (): Promise<void> => {
    await holding;
    clearPresence({ dir: codexPaths.presenceDir, id: seatId });
    const granted = await borrowCodexSeat(process.pid).catch((e: unknown) => {
      log("codexappserver.borrow_failed", { err: errorMessage(e) });
      return null;
    });
    wantMove = false;
    if (!granted || "denied" in granted || granted.id === held) {
      if (!granted || "denied" in granted) writePresence({ dir: codexPaths.presenceDir, id: seatId, accountId: held, pid: process.pid });
      log("codexappserver.move_none", { account: held.slice(0, 8), reason: granted && "denied" in granted ? granted.denied : granted ? "held account is still the best pick" : "no usable account" });
      return;
    }
    log("codexappserver.move", { from: held.slice(0, 8), to: granted.id.slice(0, 8), threads: state.threads.size });
    replaying = true;
    await stop(child);
    held = granted.id;
    child = spawn(granted.store);
    for (const msg of state.replay()) await send(child, msg);
    replaying = false;
  };

  const check = async (): Promise<void> => {
    if (checking || moving) return;
    checking = true;
    try {
      if (!wantMove && (await heldExhausted(held))) wantMove = true;
    } catch (e) {
      log("codexappserver.check_failed", { err: errorMessage(e) });
    } finally {
      checking = false;
    }
    if (!wantMove || moving || !state.idle()) return;
    moving = move()
      .catch((e: unknown) => log("codexappserver.move_failed", { err: errorMessage(e) }))
      .finally(() => {
        replaying = false;
        moving = null;
        for (const line of queued.splice(0)) forward(line);
      });
  };

  const forward = (line: string): void => {
    if (moving) {
      queued.push(line);
      return;
    }
    const msg = parseRpc(line);
    if (msg) state.fromClient(msg);
    toChild(child, line);
  };

  const timer = setInterval(() => void check(), WATCH_MS);
  void (async () => {
    for await (const line of readLines(Bun.stdin.stream())) forward(line);
    while (moving) await moving;
    child.stdin.end();
  })().catch((e: unknown) => log("codexappserver.stdin_failed", { err: errorMessage(e) }));

  const code = await done;
  clearInterval(timer);
  return code;
}
