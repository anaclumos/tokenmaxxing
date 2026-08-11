// relay turn: ensure session, send prompt, wait until turn-done OR permission-needed.

import { delay } from "es-toolkit";
import { loadRelayConfig } from "./config.ts";
import {
  clearPendingRequest,
  clearTurnDoneMarker,
  listPendingRequests,
  readTurnDoneMarker,
} from "./markers.ts";
import { permissionPingsEnabled, type ClaudePermissionMode } from "./modes.ts";
import { formatRelayStdout, type RelayStdout } from "./protocol.ts";
import { readEntry, touchEntry, withSessionLock } from "./registry.ts";
import { getTmux } from "./tmux.ts";
import { ensureSession, sendPrompt } from "./worker.ts";
import type { RelayWorker } from "./config.ts";

const POLL_MS = 50;

export type TurnParams = {
  sessionId?: string;
  worker?: RelayWorker;
  permissionMode?: ClaudePermissionMode;
  cwd: string;
  prompt?: string;
  /** When true, do not send a prompt; only wait for the next marker. */
  waitOnly?: boolean;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export type TurnResult = {
  exitCode: number;
  stdout: string;
  payload: RelayStdout;
  entrySessionId: string;
};

export async function runTurn(input: TurnParams): Promise<TurnResult> {
  const cfg = loadRelayConfig();
  const sleep = input.sleep ?? delay;
  const now = input.now ?? Date.now;
  const timeoutMs = input.timeoutMs ?? cfg.turnTimeoutMs;

  const entry = await ensureSession({
    sessionId: input.sessionId,
    worker: input.worker,
    permissionMode: input.permissionMode,
    cwd: input.cwd,
    now: now(),
  });

  if (!input.waitOnly) {
    const prompt = input.prompt ?? "";
    if (prompt.trim() === "") throw new Error("relay turn requires a prompt (argv or stdin)");
    await sendPrompt({ sessionId: entry.sessionId, prompt });
  } else {
    await withSessionLock({
      sessionId: entry.sessionId,
      fn: () => touchEntry({ sessionId: entry.sessionId, state: "running", now: now() }),
    });
  }

  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const pending = listPendingRequests({ sessionId: entry.sessionId });
    const live = readEntry({ sessionId: entry.sessionId });
    const mode = live?.permissionMode ?? entry.permissionMode;
    if (pending.length > 0 && permissionPingsEnabled({ mode })) {
      const req = pending[0]!;
      await withSessionLock({
        sessionId: entry.sessionId,
        fn: () => touchEntry({
          sessionId: entry.sessionId,
          state: "permission-needed",
          pendingRequestId: req.requestId,
          now: now(),
        }),
      });
      const payload: RelayStdout = {
        kind: "permission-needed",
        sessionId: entry.sessionId,
        permissionMode: mode,
        requestId: req.requestId,
        summary: req.summary,
        detail: req.detail,
      };
      return {
        exitCode: 0,
        stdout: formatRelayStdout({ payload }),
        payload,
        entrySessionId: entry.sessionId,
      };
    }
    // Under bypassPermissions, auto-clear any stray pending (should not fire).
    if (pending.length > 0 && !permissionPingsEnabled({ mode })) {
      for (const req of pending) {
        clearPendingRequest({ sessionId: entry.sessionId, requestId: req.requestId });
      }
    }

    const done = readTurnDoneMarker({ sessionId: entry.sessionId });
    if (done != null) {
      const text = getTmux().capturePane({ name: entry.tmuxName });
      clearTurnDoneMarker({ sessionId: entry.sessionId });
      await withSessionLock({
        sessionId: entry.sessionId,
        fn: () => touchEntry({
          sessionId: entry.sessionId,
          state: "idle",
          pendingRequestId: null,
          now: now(),
        }),
      });
      const payload: RelayStdout = {
        kind: "turn-done",
        sessionId: entry.sessionId,
        permissionMode: mode,
        text,
      };
      return {
        exitCode: 0,
        stdout: formatRelayStdout({ payload }),
        payload,
        entrySessionId: entry.sessionId,
      };
    }

    await sleep(POLL_MS);
  }

  throw new Error(`relay turn timed out after ${timeoutMs}ms (session ${entry.sessionId})`);
}

// re-export for callers that type worker from turn
export type { RelayWorker };
