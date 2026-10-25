import { once } from "node:events";
import type { Subprocess } from "bun";
import { pick, pickBy } from "es-toolkit";
import { z } from "zod";
import { borrowCodexSeat, codexPickCtx, codexPlanOrderOpen, observeCodex } from "./codex.ts";
import { ensureCodexStoreHome } from "./codexauth.ts";
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
const EPHEMERAL_IDLE_MS = 15 * 60 * 1000;
const PLAN_ORDER_RETRY_MS = 15 * 60 * 1000;
const REPLAY_ID = "tokenmaxxing-replay-";
const THREAD_OPENERS = new Set(["thread/start", "thread/resume", "thread/fork"]);
const RESUME_KEYS = ["approvalPolicy", "approvalsReviewer", "baseInstructions", "config", "cwd", "developerInstructions", "model", "modelProvider", "personality", "sandbox", "serviceTier"];
const TURN_KEYS = ["approvalPolicy", "approvalsReviewer", "cwd", "model", "personality", "serviceTier"];
const SANDBOX_MODES: Record<string, string> = { readOnly: "read-only", workspaceWrite: "workspace-write", dangerFullAccess: "danger-full-access" };
const TRACKED_NOTIFICATIONS = new Set(["turn/started", "turn/completed", "error", "thread/closed"]);

const RpcSchema = z.looseObject({
  id: z.union([z.string(), z.number()]).nullish(),
  method: z.string().optional(),
  params: z.record(z.string(), z.unknown()).nullish(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});
type Rpc = z.infer<typeof RpcSchema>;
type Child = Subprocess<"pipe", "pipe", "inherit">;

const OpenedSchema = z.looseObject({ thread: z.looseObject({ id: z.string() }) });
const ThreadParamsSchema = z.looseObject({ threadId: z.string() });
const SandboxPolicySchema = z.looseObject({ sandboxPolicy: z.looseObject({ type: z.string() }) });
const OptOutSchema = z.looseObject({ capabilities: z.looseObject({ optOutNotificationMethods: z.array(z.string()) }) });
const RefusalSchema = z.looseObject({ codexErrorInfo: z.literal("usageLimitExceeded") });
const TurnRefusalSchema = z.looseObject({ turn: z.looseObject({ error: RefusalSchema }) });
const ErrorRefusalSchema = z.looseObject({ error: RefusalSchema, willRetry: z.literal(false).optional() });
const TurnSchema = z.looseObject({ id: z.string(), rootTurnId: z.string().nullish() });
const TurnEnvelopeSchema = z.looseObject({ turn: TurnSchema });
const TurnIdSchema = z.looseObject({ turnId: z.string() });

function parseRpc(line: string): Rpc | null {
  try {
    return RpcSchema.safeParse(JSON.parse(line)).data ?? null;
  } catch {
    return null;
  }
}

const idKey = (id: string | number): string => `${typeof id}:${id}`;

type TurnMap = { from: string; to: string };
type Retry = { params: Record<string, unknown>; turnId: string; withheld: string[] };

function translateTurn(line: string, msg: Rpc, mapped: TurnMap): string {
  const params = msg.params ?? {};
  let out: Record<string, unknown> = params;
  if (TurnIdSchema.safeParse(params).data?.turnId === mapped.to) out = { ...out, turnId: mapped.from };
  const turn = TurnEnvelopeSchema.safeParse(params).data?.turn;
  if (turn != null && turn.id === mapped.to) out = { ...out, turn: { ...turn, id: mapped.from, ...(turn.rootTurnId === mapped.to ? { rootTurnId: mapped.from } : {}) } };
  return out === params ? line : JSON.stringify({ ...msg, params: out });
}

export class AppServerState {
  initialize: Record<string, unknown> | null = null;
  initialized = false;
  readonly threads = new Map<string, Record<string, unknown>>();
  readonly lastTurn = new Map<string, Record<string, unknown>>();
  private readonly ephemeral = new Map<string, number>();
  private readonly pending = new Map<string, { method: string; params: Record<string, unknown> }>();
  private readonly busy = new Set<string>();
  private readonly optedOut = new Set<string>();

  fromClient(msg: Rpc): Rpc {
    let sent = msg;
    if (msg.method === "initialize") {
      const declared = OptOutSchema.safeParse(msg.params).data;
      const optOut = declared?.capabilities.optOutNotificationMethods ?? [];
      if (declared && optOut.some((m) => TRACKED_NOTIFICATIONS.has(m))) {
        for (const m of optOut) if (TRACKED_NOTIFICATIONS.has(m)) this.optedOut.add(m);
        const capabilities = { ...declared.capabilities, optOutNotificationMethods: optOut.filter((m) => !TRACKED_NOTIFICATIONS.has(m)) };
        sent = { ...msg, params: { ...declared, capabilities } };
      }
      this.initialize = sent.params ?? {};
    }
    if (msg.method === "initialized") this.initialized = true;
    if (msg.method != null && msg.id != null) this.pending.set(idKey(msg.id), { method: msg.method, params: msg.params ?? {} });
    const threadId = msg.method === "turn/start" ? ThreadParamsSchema.safeParse(msg.params).data?.threadId : undefined;
    if (threadId != null) this.lastTurn.set(threadId, msg.params ?? {});
    return sent;
  }

  fromServer(msg: Rpc, now = Date.now()): { refused: boolean; turnEnded: boolean; forward: boolean; threadId?: string } {
    if (msg.method == null && msg.id != null) {
      const asked = this.pending.get(idKey(msg.id));
      this.pending.delete(idKey(msg.id));
      if (asked && msg.error == null) this.answered(asked, msg.result, now);
      return { refused: false, turnEnded: false, forward: true };
    }
    const forward = msg.method == null || !this.optedOut.has(msg.method);
    const threadId = ThreadParamsSchema.safeParse(msg.params).data?.threadId;
    if (threadId != null && this.ephemeral.has(threadId)) this.ephemeral.set(threadId, now);
    if (msg.method === "turn/started" && threadId != null) this.busy.add(threadId);
    if (msg.method === "turn/completed" && threadId != null) {
      this.busy.delete(threadId);
      return { refused: TurnRefusalSchema.safeParse(msg.params).success, turnEnded: true, forward, threadId };
    }
    if (msg.method === "thread/closed" && threadId != null) {
      this.busy.delete(threadId);
      this.threads.delete(threadId);
      this.lastTurn.delete(threadId);
      this.ephemeral.delete(threadId);
    }
    return { refused: msg.method === "error" && ErrorRefusalSchema.safeParse(msg.params).success, turnEnded: false, forward, threadId };
  }

  private answered(asked: { method: string; params: Record<string, unknown> }, result: unknown, now: number): void {
    const opened = THREAD_OPENERS.has(asked.method) ? OpenedSchema.safeParse(result).data : undefined;
    if (opened && asked.params.ephemeral === true) this.ephemeral.set(opened.thread.id, now);
    else if (opened) this.threads.set(opened.thread.id, pick(asked.params, RESUME_KEYS));
    if (asked.method !== "turn/start") return;
    const threadId = ThreadParamsSchema.safeParse(asked.params).data?.threadId;
    const tracked = threadId == null ? undefined : this.threads.get(threadId);
    if (!tracked) return;
    Object.assign(tracked, pickBy(pick(asked.params, TURN_KEYS), (v) => v != null));
    const policy = SandboxPolicySchema.safeParse(asked.params).data?.sandboxPolicy.type;
    if (policy != null) tracked.sandbox = SANDBOX_MODES[policy] ?? "read-only";
  }

  idle(now = Date.now()): boolean {
    return this.busy.size === 0 && this.pending.size === 0 && [...this.ephemeral.values()].every((at) => now - at > EPHEMERAL_IDLE_MS);
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
  onSpawn: (child: Child) => void;
}): Promise<number> {
  const seatId = `seat-${process.pid}`;
  const nextSeatId = `${seatId}-next`;
  const nonce = crypto.randomUUID();
  const state = new AppServerState();
  const retired = new Set<Child>();
  const waiters = new Map<string, (reply: Rpc) => void>();
  const queued: string[] = [];
  const retries = new Map<string, Retry>();
  const remaps = new Map<string, TurnMap>();
  const withheldErrors = new Map<string, string>();
  let held = input.seat.id;
  let replays = 0;
  let replaying = false;
  let moving: Promise<void> | null = null;
  let wantMove = false;
  let wantPlanOrder = false;
  let planOrderRetryAt = 0;
  let checking = false;
  let ended = false;
  let terminated = false;
  let holding: Promise<void> = Promise.resolve();
  let finish: (code: number) => void = () => {};
  const done = new Promise<number>((resolve) => { finish = resolve; });

  const toChild = (p: Child, line: string): void => {
    try {
      p.stdin.write(`${line}\n`);
      p.stdin.flush();
    } catch (e) {
      log("codexappserver.write_failed", { err: errorMessage(e) });
    }
  };

  const spawn = (store: string): Child => {
    const p = Bun.spawn([input.real, ...input.argv], { stdin: "pipe", stdout: "pipe", stderr: "inherit", env: { ...input.env, CODEX_HOME: store } });
    input.onSpawn(p);
    const reading = (async () => {
      for await (const line of readLines(p.stdout)) {
        if (retired.has(p)) continue;
        const msg = parseRpc(line);
        const waiter = msg?.method == null && typeof msg?.id === "string" ? waiters.get(msg.id) : undefined;
        if (msg && waiter) {
          waiter(msg);
          continue;
        }
        if (replaying) continue;
        if (!msg) {
          await writeOut(line);
          continue;
        }
        const seen = state.fromServer(msg);
        const { threadId } = seen;
        const retrying = threadId == null ? undefined : retries.get(threadId);
        const mapped = threadId == null ? undefined : remaps.get(threadId);
        if (msg.method === "turn/started" && threadId != null && (retrying || mapped)) {
          const started = TurnEnvelopeSchema.safeParse(msg.params).data;
          if (retrying && started) remaps.set(threadId, { from: retrying.turnId, to: started.turn.id });
          continue;
        }
        if (seen.refused) {
          const refusedId = held;
          log("codexappserver.refused", { account: refusedId.slice(0, 8) });
          holding = holding.then(() => holdRefused(refusedId)).catch((e: unknown) => log("codexappserver.hold_failed", { err: errorMessage(e) }));
          wantMove = true;
          const plan = threadId != null && !retrying && !mapped && !ended && !terminated ? state.lastTurn.get(threadId) : undefined;
          if (plan && threadId != null && msg.method === "error") {
            withheldErrors.set(threadId, line);
            continue;
          }
          const failed = plan && seen.turnEnded ? TurnEnvelopeSchema.safeParse(msg.params).data : undefined;
          if (plan && threadId != null && failed && state.idle()) {
            const withheld = withheldErrors.get(threadId);
            withheldErrors.delete(threadId);
            retries.set(threadId, { params: plan, turnId: failed.turn.id, withheld: withheld == null ? [line] : [withheld, line] });
            log("codexappserver.retry_planned", { account: refusedId.slice(0, 8), thread: threadId.slice(0, 8) });
            void check();
            continue;
          }
        }
        const out = mapped ? translateTurn(line, msg, mapped) : line;
        if ((seen.turnEnded || msg.method === "thread/closed") && threadId != null) {
          const withheld = withheldErrors.get(threadId);
          withheldErrors.delete(threadId);
          if (withheld != null) await writeOut(withheld);
          remaps.delete(threadId);
        }
        if (seen.turnEnded) void check();
        if (!seen.forward) continue;
        await writeOut(out);
      }
    })().catch((e: unknown) => log("codexappserver.stdout_failed", { err: errorMessage(e) }));
    void p.exited.then(async () => {
      if (retired.has(p)) return;
      await reading;
      finish(exitStatus(p));
    });
    return p;
  };

  let child = spawn(input.seat.store);

  const request = async (p: Child, method: string, params: Record<string, unknown>): Promise<Rpc | null> => {
    const id = `${REPLAY_ID}${nonce}-${++replays}`;
    const answered = new Promise<Rpc>((resolve) => waiters.set(id, resolve));
    toChild(p, JSON.stringify({ id, method, params }));
    const reply = await Promise.race([answered, Bun.sleep(REPLAY_TIMEOUT_MS).then(() => null), p.exited.then(() => null)]);
    waiters.delete(id);
    if (reply == null || reply.error != null) {
      log("codexappserver.replay_failed", { method, reply: reply == null ? "no reply" : JSON.stringify(reply.error).slice(0, 200) });
      return null;
    }
    return reply;
  };

  const restore = async (p: Child): Promise<boolean> => {
    if (state.initialize == null) return true;
    if ((await request(p, "initialize", state.initialize)) == null) return false;
    if (state.initialized) toChild(p, JSON.stringify({ method: "initialized" }));
    for (const [threadId, params] of [...state.threads]) {
      if ((await request(p, "thread/resume", { ...params, threadId, excludeTurns: true })) == null) state.threads.delete(threadId);
    }
    return true;
  };

  const stop = async (p: Child): Promise<void> => {
    retired.add(p);
    p.kill("SIGTERM");
    const exited = await Promise.race([p.exited.then(() => true), Bun.sleep(STOP_GRACE_MS).then(() => false)]);
    if (!exited) {
      p.kill("SIGKILL");
      await p.exited;
    }
  };

  const relaunch = async (accountId: string, store: string): Promise<boolean> => {
    writePresence({ dir: codexPaths.presenceDir, id: seatId, accountId, pid: process.pid });
    held = accountId;
    child = spawn(store);
    return restore(child);
  };

  const move = async (): Promise<boolean> => {
    await holding;
    const planOrder = wantPlanOrder;
    wantPlanOrder = false;
    const granted = await borrowCodexSeat(process.pid, nextSeatId, planOrder ? { betterThan: held } : {}).catch((e: unknown) => {
      log("codexappserver.borrow_failed", { err: errorMessage(e) });
      return null;
    });
    wantMove = false;
    const clearNext = (): void => clearPresence({ dir: codexPaths.presenceDir, id: nextSeatId });
    if (!granted || "denied" in granted || granted.id === held || terminated) {
      if (planOrder) planOrderRetryAt = Date.now() + PLAN_ORDER_RETRY_MS;
      clearNext();
      log("codexappserver.move_none", { account: held.slice(0, 8), reason: terminated ? "shutting down" : granted && "denied" in granted ? granted.denied : granted ? "held account is still the best pick" : "no usable account" });
      return false;
    }
    const from = held;
    const old = child;
    log("codexappserver.move", { from: from.slice(0, 8), to: granted.id.slice(0, 8), threads: state.threads.size });
    replaying = true;
    await stop(old);
    if (terminated) {
      clearNext();
      finish(exitStatus(old));
      return false;
    }
    const restored = await relaunch(granted.id, granted.store);
    clearNext();
    if (restored) {
      replaying = false;
      return true;
    }
    log("codexappserver.move_rollback", { from: granted.id.slice(0, 8), to: from.slice(0, 8) });
    await stop(child);
    if (terminated) {
      finish(exitStatus(child));
      return false;
    }
    if (!(await relaunch(from, ensureCodexStoreHome(from)))) log("codexappserver.rollback_failed", { account: from.slice(0, 8) });
    return false;
  };

  const retry = async (landed: boolean): Promise<void> => {
    for (const [threadId, planned] of [...retries]) {
      const reply = landed && !terminated && !ended ? await request(child, "turn/start", planned.params) : null;
      const started = reply ? TurnEnvelopeSchema.safeParse(reply.result).data : undefined;
      retries.delete(threadId);
      if (started) {
        remaps.set(threadId, { from: planned.turnId, to: started.turn.id });
        log("codexappserver.retry", { account: held.slice(0, 8), thread: threadId.slice(0, 8) });
        continue;
      }
      remaps.delete(threadId);
      log("codexappserver.retry_none", { thread: threadId.slice(0, 8), reason: landed ? "turn/start was not answered" : "no account to retry on" });
      for (const line of planned.withheld) await writeOut(line);
    }
  };

  const check = async (): Promise<void> => {
    if (checking || moving || ended || terminated) return;
    checking = true;
    try {
      if (!wantMove && (await heldExhausted(held))) wantMove = true;
      else if (!wantMove && Date.now() >= planOrderRetryAt && codexPlanOrderOpen(held, Date.now())) wantMove = wantPlanOrder = true;
    } catch (e) {
      log("codexappserver.check_failed", { err: errorMessage(e) });
    } finally {
      checking = false;
    }
    if (!wantMove || moving || ended || terminated || !state.idle()) return;
    moving = move()
      .then(retry)
      .catch((e: unknown) => {
        log("codexappserver.move_failed", { err: errorMessage(e) });
        if (retired.has(child)) finish(1);
      })
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
    if (!msg) return toChild(child, line);
    const sent = state.fromClient(msg);
    const threadId = ThreadParamsSchema.safeParse(sent.params).data?.threadId;
    const mapped = threadId == null ? undefined : remaps.get(threadId);
    const out = mapped && TurnIdSchema.safeParse(sent.params).data?.turnId === mapped.from ? { ...sent, params: { ...sent.params, turnId: mapped.to } } : sent;
    toChild(child, out === msg ? line : JSON.stringify(out));
  };

  process.on("SIGTERM", () => {
    terminated = true;
    child.kill("SIGTERM");
  });
  const timer = setInterval(() => void check(), WATCH_MS);
  void (async () => {
    for await (const line of readLines(Bun.stdin.stream())) forward(line);
    ended = true;
    while (moving) await moving;
    child.stdin.end();
  })().catch((e: unknown) => log("codexappserver.stdin_failed", { err: errorMessage(e) }));

  const code = await done;
  clearInterval(timer);
  return code;
}
