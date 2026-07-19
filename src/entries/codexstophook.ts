// Codex Stop hook (installed in ~/.codex/hooks.json by `init --codex`). Fires
// when codex finishes a turn: the transcript is committed and the process is
// idle, the one boundary where killing it loses nothing. If the decision swaps
// accounts and this session runs under the codex supervisor, drop a respawn
// marker keyed by the supervisor's id; the supervisor SIGTERMs codex and
// relaunches `codex resume <session-id>` on the new account (a running codex
// never adopts a different account's credential: restart IS the switch).
//
// Contract with codex (verified against the 0.144.4 binary + hooks reference):
// stdin carries session_id, stdout `{}` on exit 0 is the documented no-op, and
// a hook failure must never block the stop - errors are logged, not thrown.

import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { z } from "zod";
import { codexPaths } from "../lib/paths.ts";
import { writeFileAtomic } from "../lib/atomic.ts";
import { evaluateAndMaybeSwapCodex } from "../lib/codexdecide.ts";
import { livingCodexPresences } from "../lib/codexpresence.ts";
import { liveCodexAccountId } from "../lib/codexsample.ts";
import { loadCodexAccounts } from "../lib/codexstate.ts";
import { CODEX_SUPERVISOR_ID_ENV } from "./codexsupervisor.ts";
import { CodexReconcileMarkerSchema, CodexRespawnMarkerSchema, CodexStopStdinSchema } from "../lib/types.ts";
import { log } from "../lib/log.ts";

const SupervisorIdSchema = z.string().min(1).optional().catch(undefined);

/** Consume a cross-session reconcile signal addressed to THIS supervisor
 *  (owner-approved option b, 2026-07-20): a deciding actor saw this session
 *  running on an exhausted/dead account and asked it to respawn onto the live
 *  seat. The Stop boundary is the only safe respawn point, and only THIS
 *  hook's stdin carries the session id a resume needs, so promotion happens
 *  here: the signal becomes a normal respawn marker the supervisor already
 *  consumes. Returns true when the respawn marker was written (the session is
 *  about to die - skip the normal decision). Runs UNLOCKED on purpose: it
 *  writes only this supervisor's own markers, and the staleness guards make a
 *  raced read merely drop the signal for the next boundary. */
function promoteReconcile(input: { supervisorId: string; sessionId: string | null }): boolean {
  const markerPath = join(codexPaths.reconcileDir, input.supervisorId);
  if (!existsSync(markerPath)) return false;
  const parsed = CodexReconcileMarkerSchema.safeParse((() => {
    try {
      return JSON.parse(readFileSync(markerPath, "utf8"));
    } catch {
      return null;
    }
  })());
  if (!parsed.success) {
    // unlike a presence file, a broken signal guards nothing: drop it loudly.
    rmSync(markerPath, { force: true });
    log("codexstop.reconcile_unparsable", {});
    return false;
  }
  // Staleness guard: the signal names the account this session was seen on;
  // if the session has since respawned onto another account the signal is
  // moot. Same when the live seat changed to (or still is) our own account -
  // a respawn would land right back where we are.
  const presence = livingCodexPresences().find((p) => p.supervisorId === input.supervisorId) ?? null;
  if (presence == null || presence.accountId !== parsed.data.accountId) {
    rmSync(markerPath, { force: true });
    log("codexstop.reconcile_stale", {});
    return false;
  }
  const liveId = liveCodexAccountId();
  if (liveId == null || liveId === presence.accountId) {
    rmSync(markerPath, { force: true });
    log("codexstop.reconcile_moot", {});
    return false;
  }
  if (input.sessionId == null) {
    // no session id on this stdin: keep the signal for the next boundary,
    // whose stdin will carry one - a resume without a sid could revive the
    // wrong transcript.
    log("codexstop.reconcile_no_session", {});
    return false;
  }
  const label = loadCodexAccounts().accounts.find((a) => a.accountId === liveId)?.label ?? "the live account";
  mkdirSync(codexPaths.respawnDir, { recursive: true });
  writeFileAtomic(
    join(codexPaths.respawnDir, input.supervisorId),
    JSON.stringify(CodexRespawnMarkerSchema.parse({ account: label, sessionId: input.sessionId, ts: Date.now() })),
  );
  rmSync(markerPath, { force: true });
  log("codexstop.reconcile_respawn", { supervisorId: input.supervisorId.slice(0, 8), account: liveId.slice(0, 8) });
  return true;
}

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/** The testable core: decide, and on a swap under a supervisor, drop the
 *  respawn marker. Never throws (a hook failure must not block the stop). */
export async function handleCodexStop(input: { rawStdin: string }): Promise<void> {
  const parsed = CodexStopStdinSchema.safeParse((() => {
    try {
      return JSON.parse(input.rawStdin);
    } catch {
      return {};
    }
  })());
  const sessionId = parsed.success ? (parsed.data.session_id ?? null) : null;

  try {
    // No supervisor = no decision AT ALL, checked before evaluate can swap:
    // hooks.json is global, so this hook also fires in sessions launched
    // around the PATH shim (IDE extension, absolute path), and a swap with
    // nobody to respawn strands that session - codex cannot hot-adopt, and
    // its guarded reload refuses a cross-account auth.json, so the session
    // dies on its stale token with "Please sign in again" (closing-review
    // catch). Restart IS the switch; without a restarter, do not switch.
    const supervisorId = SupervisorIdSchema.parse(process.env[CODEX_SUPERVISOR_ID_ENV]);
    if (supervisorId === undefined) {
      log("codexstop.unsupervised_skip", {});
      return;
    }
    // A pending reconcile signal outranks the normal decision: this session
    // is about to respawn onto the live seat, so evaluating it would waste a
    // sample (and could even swap the seat out from under the respawn).
    if (promoteReconcile({ supervisorId, sessionId })) return;
    const decision = await evaluateAndMaybeSwapCodex({ selfSupervisorId: supervisorId });
    if (decision.swapped && decision.account) {
      mkdirSync(codexPaths.respawnDir, { recursive: true });
      const payload = CodexRespawnMarkerSchema.parse({
        account: decision.account.label,
        sessionId,
        ts: Date.now(),
      });
      writeFileAtomic(join(codexPaths.respawnDir, supervisorId), JSON.stringify(payload));
      log("codexstop.marker", { supervisorId: supervisorId.slice(0, 8) });
    }
  } catch (e) {
    log("codexstop.error", { err: e instanceof Error ? e.message : String(e) });
  }
}

export async function runCodexStopHook(): Promise<number> {
  if (!process.env.TOKENMAXXING_PROBE) {
    await handleCodexStop({ rawStdin: await readStdin() });
  }
  process.stdout.write("{}"); // documented no-op hook output; never block the stop
  return 0;
}
