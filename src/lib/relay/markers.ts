// Additive turn-done and permission-needed markers under relayDir.
// Never writes into respawn/.

import { existsSync, mkdirSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { z } from "zod";
import { writeFileAtomic } from "../atomic.ts";
import {
  decisionPath,
  pendingRequestPath,
  relayDecisionsDir,
  relayPendingDir,
  relayTurnDoneDir,
  turnDonePath,
} from "./registry.ts";

export const TurnDoneMarkerSchema = z.object({
  sessionId: z.uuid(),
  ts: z.number().int().nonnegative(),
  source: z.enum(["claude-stop", "codex-stop", "test"]).default("claude-stop"),
});
export type TurnDoneMarker = z.infer<typeof TurnDoneMarkerSchema>;

export const PendingRequestSchema = z.object({
  requestId: z.string().min(1),
  sessionId: z.uuid(),
  summary: z.string(),
  detail: z.string(),
  ts: z.number().int().nonnegative(),
});
export type PendingRequest = z.infer<typeof PendingRequestSchema>;

export const DecisionSchema = z.object({
  requestId: z.string().min(1),
  sessionId: z.uuid(),
  approve: z.boolean(),
  ts: z.number().int().nonnegative(),
});
export type Decision = z.infer<typeof DecisionSchema>;

/** Write a turn-done marker for a relay session. Additive; never touches respawn/. */
export function writeTurnDoneMarker(input: {
  sessionId: string;
  source?: TurnDoneMarker["source"];
  now?: number;
}): void {
  mkdirSync(relayTurnDoneDir(), { recursive: true });
  const payload = TurnDoneMarkerSchema.parse({
    sessionId: input.sessionId,
    ts: input.now ?? Date.now(),
    source: input.source ?? "claude-stop",
  });
  writeFileAtomic(turnDonePath({ sessionId: input.sessionId }), JSON.stringify(payload) + "\n");
}

export function readTurnDoneMarker(input: { sessionId: string }): TurnDoneMarker | null {
  const path = turnDonePath(input);
  if (!existsSync(path)) return null;
  return TurnDoneMarkerSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export function clearTurnDoneMarker(input: { sessionId: string }): void {
  rmSync(turnDonePath(input), { force: true });
}

export function writePendingRequest(input: {
  sessionId: string;
  requestId: string;
  summary: string;
  detail: string;
  now?: number;
}): PendingRequest {
  const payload = PendingRequestSchema.parse({
    requestId: input.requestId,
    sessionId: input.sessionId,
    summary: input.summary,
    detail: input.detail,
    ts: input.now ?? Date.now(),
  });
  writeFileAtomic(
    pendingRequestPath({ sessionId: input.sessionId, requestId: input.requestId }),
    JSON.stringify(payload, null, 2) + "\n",
  );
  return payload;
}

export function readPendingRequest(input: { sessionId: string; requestId: string }): PendingRequest | null {
  const path = pendingRequestPath(input);
  if (!existsSync(path)) return null;
  return PendingRequestSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export function listPendingRequests(input: { sessionId: string }): PendingRequest[] {
  const dir = `${relayPendingDir()}/${input.sessionId}`;
  if (!existsSync(dir)) return [];
  const out: PendingRequest[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      out.push(PendingRequestSchema.parse(JSON.parse(readFileSync(`${dir}/${name}`, "utf8"))));
    } catch {
      // skip
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}

export function clearPendingRequest(input: { sessionId: string; requestId: string }): void {
  rmSync(pendingRequestPath(input), { force: true });
}

export function writeDecision(input: {
  sessionId: string;
  requestId: string;
  approve: boolean;
  now?: number;
}): Decision {
  mkdirSync(`${relayDecisionsDir()}/${input.sessionId}`, { recursive: true });
  const payload = DecisionSchema.parse({
    requestId: input.requestId,
    sessionId: input.sessionId,
    approve: input.approve,
    ts: input.now ?? Date.now(),
  });
  writeFileAtomic(
    decisionPath({ sessionId: input.sessionId, requestId: input.requestId }),
    JSON.stringify(payload, null, 2) + "\n",
  );
  return payload;
}

export function readDecision(input: { sessionId: string; requestId: string }): Decision | null {
  const path = decisionPath(input);
  if (!existsSync(path)) return null;
  return DecisionSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export function clearDecision(input: { sessionId: string; requestId: string }): void {
  rmSync(decisionPath(input), { force: true });
}

/** Clear all marker artifacts for a session (destroy/gc). Does not touch respawn/. */
export function clearSessionMarkers(input: { sessionId: string }): void {
  clearTurnDoneMarker(input);
  const pendingDir = `${relayPendingDir()}/${input.sessionId}`;
  const decisionsDir = `${relayDecisionsDir()}/${input.sessionId}`;
  rmSync(pendingDir, { recursive: true, force: true });
  rmSync(decisionsDir, { recursive: true, force: true });
}
