import { join } from "node:path";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { codexPaths, envOverride } from "../lib/paths.ts";
import { withLock } from "../lib/lock.ts";
import { writeFileAtomic } from "../lib/atomic.ts";
import { evaluateAndMaybeSwapCodex } from "../lib/codexdecide.ts";
import { isCodexExhausted } from "../lib/codexpick.ts";
import { livingCodexPresences } from "../lib/codexpresence.ts";
import { liveCodexAccountId } from "../lib/codexsample.ts";
import { loadCodexAccounts } from "../lib/codexstate.ts";
import { errorMessage } from "../lib/errors.ts";
import { tryParseJson, tryReadJson } from "../lib/json.ts";
import { loadConfig } from "../lib/state.ts";
import { terminalBars } from "../lib/picker.ts";
import { CODEX_SUPERVISOR_ID_ENV } from "./codexsupervisor.ts";
import { CodexReconcileMarkerSchema, CodexStopStdinSchema, type CodexAccount, type CodexRespawnMarker } from "../lib/types.ts";
import { log } from "../lib/log.ts";

async function promoteReconcile(input: { supervisorId: string; sessionId: string | null }): Promise<boolean> {
  const markerPath = join(codexPaths.reconcileDir, input.supervisorId);
  if (!existsSync(markerPath)) return false;
  return withLock(codexPaths.lockFile, async () => promoteReconcileLocked(input));
}

function promoteReconcileLocked(input: { supervisorId: string; sessionId: string | null }): boolean {
  const markerPath = join(codexPaths.reconcileDir, input.supervisorId);
  if (!existsSync(markerPath)) return false;
  const marker = tryReadJson(markerPath, CodexReconcileMarkerSchema);
  if (!marker) {
    rmSync(markerPath, { force: true });
    log("codexstop.reconcile_unparsable", {});
    return false;
  }
  const presence = livingCodexPresences().find((p) => p.supervisorId === input.supervisorId) ?? null;
  if (presence == null || presence.accountId !== marker.accountId) {
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
  const bars = terminalBars(loadConfig());
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
  const respawn: CodexRespawnMarker = { account: liveAccount.label, sessionId: input.sessionId, ts: now };
  writeFileAtomic(join(codexPaths.respawnDir, input.supervisorId), JSON.stringify(respawn));
  rmSync(markerPath, { force: true });
  log("codexstop.reconcile_respawn", { supervisorId: input.supervisorId.slice(0, 8), account: liveId.slice(0, 8) });
  return true;
}

export async function handleCodexStop(input: { rawStdin: string }): Promise<void> {
  const sessionId = tryParseJson(CodexStopStdinSchema, input.rawStdin)?.session_id ?? null;

  try {
    const supervisorId = envOverride(CODEX_SUPERVISOR_ID_ENV);
    if (supervisorId === undefined) {
      log("codexstop.unsupervised_skip", {});
      return;
    }
    if (await promoteReconcile({ supervisorId, sessionId })) return;
    const decision = await evaluateAndMaybeSwapCodex({});
    if (decision.swapped && decision.account) {
      mkdirSync(codexPaths.respawnDir, { recursive: true });
      const payload: CodexRespawnMarker = { account: decision.account.label, sessionId, ts: Date.now() };
      writeFileAtomic(join(codexPaths.respawnDir, supervisorId), JSON.stringify(payload));
      log("codexstop.marker", { supervisorId: supervisorId.slice(0, 8) });
      return;
    }
    await promoteReconcile({ supervisorId, sessionId });
  } catch (e) {
    log("codexstop.error", { err: errorMessage(e) });
  }
}

export async function runCodexStopHook(): Promise<number> {
  if (!process.env.TOKENMAXXING_PROBE) {
    await handleCodexStop({ rawStdin: await Bun.stdin.text() });
  }
  process.stdout.write("{}");
  return 0;
}
