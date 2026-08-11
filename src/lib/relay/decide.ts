// relay decide: approve/deny a pending permission ping and resume the wait.

import { delay } from "es-toolkit";
import { loadRelayConfig } from "./config.ts";
import {
  clearPendingRequest,
  listPendingRequests,
  readPendingRequest,
  writeDecision,
} from "./markers.ts";
import { runTurn, type TurnResult } from "./turn.ts";
import { readEntry, touchEntry, withSessionLock } from "./registry.ts";

export type DecideParams = {
  sessionId: string;
  requestId?: string;
  approve: boolean;
  /** After writing the decision, wait for turn-done or the next ping. */
  wait?: boolean;
  cwd?: string;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export async function runDecide(input: DecideParams): Promise<{
  decisionWritten: boolean;
  requestId: string;
  turn?: TurnResult;
}> {
  const entry = readEntry({ sessionId: input.sessionId });
  if (entry == null) throw new Error(`relay session not found: ${input.sessionId}`);

  let requestId = input.requestId ?? entry.pendingRequestId;
  if (requestId == null) {
    const pending = listPendingRequests({ sessionId: input.sessionId });
    requestId = pending[0]?.requestId;
  }
  if (requestId == null) throw new Error(`no pending permission request for session ${input.sessionId}`);

  const pending = readPendingRequest({ sessionId: input.sessionId, requestId });
  if (pending == null) throw new Error(`pending request not found: ${requestId}`);

  writeDecision({
    sessionId: input.sessionId,
    requestId,
    approve: input.approve,
    now: (input.now ?? Date.now)(),
  });
  clearPendingRequest({ sessionId: input.sessionId, requestId });
  await withSessionLock({
    sessionId: input.sessionId,
    fn: () => touchEntry({
      sessionId: input.sessionId,
      state: "running",
      pendingRequestId: null,
      now: (input.now ?? Date.now)(),
    }),
  });

  if (input.wait === false) {
    return { decisionWritten: true, requestId };
  }

  const cfg = loadRelayConfig();
  const turn = await runTurn({
    sessionId: input.sessionId,
    cwd: input.cwd ?? entry.cwd,
    waitOnly: true,
    timeoutMs: input.timeoutMs ?? cfg.decideTimeoutMs,
    now: input.now,
    sleep: input.sleep ?? delay,
  });
  return { decisionWritten: true, requestId, turn };
}
