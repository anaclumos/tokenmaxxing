import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { z } from "zod";
import { codexPaths } from "../lib/paths.ts";
import { withLock } from "../lib/lock.ts";
import { writeFileAtomic } from "../lib/atomic.ts";
import { evaluateAndMaybeSwapCodex } from "../lib/codexdecide.ts";
import { isCodexExhausted } from "../lib/codexpick.ts";
import { livingCodexPresences } from "../lib/codexpresence.ts";
import { liveCodexAccountId } from "../lib/codexsample.ts";
import { loadCodexAccounts } from "../lib/codexstate.ts";
import { loadConfig } from "../lib/state.ts";
import { effectiveBars } from "../lib/picker.ts";
import { CODEX_SUPERVISOR_ID_ENV } from "./codexsupervisor.ts";
import { CodexReconcileMarkerSchema, CodexRespawnMarkerSchema, CodexStopStdinSchema, type CodexAccount } from "../lib/types.ts";
import { log } from "../lib/log.ts";

const SupervisorIdSchema = z.string().min(1).optional().catch(undefined);

async function promoteReconcile(input: { supervisorId: string; sessionId: string | null }): Promise<boolean> {
  const markerPath = join(codexPaths.reconcileDir, input.supervisorId);
  if (!existsSync(markerPath)) return false;
  return withLock(codexPaths.lockFile, async () => promoteReconcileLocked(input));
}

function promoteReconcileLocked(input: { supervisorId: string; sessionId: string | null }): boolean {
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
    rmSync(markerPath, { force: true });
    log("codexstop.reconcile_unparsable", {});
    return false;
  }
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
  const now = Date.now();
  const bars = effectiveBars(loadConfig());
  const index = loadCodexAccounts();
  const unusable = (account: CodexAccount): boolean =>
    account.needsReauth === true || isCodexExhausted({ account, thresholds: bars, now });
  const liveAccount = index.accounts.find((a) => a.accountId === liveId);
  if (!liveAccount || unusable(liveAccount)) {
    rmSync(markerPath, { force: true });
    log("codexstop.reconcile_blocked_target", {});
    return false;
  }
  if (input.sessionId == null || input.sessionId.trim() === "") {
    log("codexstop.reconcile_no_session", {});
    return false;
  }
  mkdirSync(codexPaths.respawnDir, { recursive: true });
  writeFileAtomic(
    join(codexPaths.respawnDir, input.supervisorId),
    JSON.stringify(CodexRespawnMarkerSchema.parse({ account: liveAccount.label, sessionId: input.sessionId, ts: now })),
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
    const supervisorId = SupervisorIdSchema.parse(process.env[CODEX_SUPERVISOR_ID_ENV]);
    if (supervisorId === undefined) {
      log("codexstop.unsupervised_skip", {});
      return;
    }
    if (await promoteReconcile({ supervisorId, sessionId })) return;
    const decision = await evaluateAndMaybeSwapCodex({});
    if (decision.swapped && decision.account) {
      mkdirSync(codexPaths.respawnDir, { recursive: true });
      const payload = CodexRespawnMarkerSchema.parse({
        account: decision.account.label,
        sessionId,
        ts: Date.now(),
      });
      writeFileAtomic(join(codexPaths.respawnDir, supervisorId), JSON.stringify(payload));
      log("codexstop.marker", { supervisorId: supervisorId.slice(0, 8) });
      return;
    }
    await promoteReconcile({ supervisorId, sessionId });
  } catch (e) {
    log("codexstop.error", { err: e instanceof Error ? e.message : String(e) });
  }
}

export async function runCodexStopHook(): Promise<number> {
  if (!process.env.TOKENMAXXING_PROBE) {
    await handleCodexStop({ rawStdin: await readStdin() });
  }
  process.stdout.write("{}");
  return 0;
}
