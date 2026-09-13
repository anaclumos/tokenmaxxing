import { z } from "zod";
import { claude } from "../lib/claude.ts";
import { evaluateAndMaybeSwap } from "../lib/decide.ts";
import { supervisedSession, writeRespawnMarker } from "../lib/sessions.ts";
import { loadConfig } from "../lib/state.ts";
import { classifyEnforcedLimit, findEnforcedRow, parseErrorBody, readTranscriptTail } from "../lib/usage.ts";
import { JsonTextSchema, type EnforcedLimit } from "../lib/types.ts";
import { log } from "../lib/log.ts";
import { readStdin } from "./statusline.ts";

const StopFailureStdin = z.looseObject({
  session_id: z.uuid().optional().catch(undefined),
  transcript_path: z.string().optional().catch(undefined),
  error: z.string().optional().catch(undefined),
  agent_id: z.string().optional().catch(undefined),
  last_assistant_message: z.string().optional().catch(undefined),
});

export async function runStopFailureHook(): Promise<number> {
  if (process.env.TOKENMAXXING_PROBE) return 0;

  const account = claude.liveId();
  const now = Date.now();
  const raw = await readStdin();
  const parsed = StopFailureStdin.safeParse(JsonTextSchema.safeParse(raw).data);
  const stdin = parsed.success ? parsed.data : {};
  if (stdin.error !== undefined && stdin.error !== "rate_limit") return 0;

  const stdinSid = stdin.session_id;
  const session = supervisedSession();
  const mainLoop = stdin.agent_id === undefined;
  const canRespawn = session != null && mainLoop;

  try {
    const cfg = loadConfig();
    const row = stdin.transcript_path
      ? findEnforcedRow({ rows: readTranscriptTail(stdin.transcript_path), lastAssistantMessage: stdin.last_assistant_message, now })
      : null;
    const limit = row ? classifyEnforcedLimit(row, cfg.policy.switchModels) : null;

    let enforced: EnforcedLimit | null = null;
    if (limit && account) {
      enforced = { account, kind: limit.kind, family: limit.kind === "model" ? limit.family : null, resetsAt: limit.resetsAt, blind: !mainLoop && limit.kind !== "model" };
      log("stopfailure.enforced", { kind: limit.kind, family: enforced.family ?? undefined, resetsAt: limit.resetsAt, subagent: !mainLoop });
    } else {
      log("stopfailure.unclassified", {
        seat: account != null,
        row: row != null,
        type: row?.quotaLimits?.rateLimitType,
        transient: row?.apiErrorIsTransient,
        body: row ? parseErrorBody(row.errorDetails)?.error?.type : undefined,
      });
    }

    const decision = await evaluateAndMaybeSwap(claude, now, canRespawn && enforced != null, enforced);
    if (enforced && session && canRespawn && decision.account && (decision.swapped || decision.waitUntil !== undefined)) {
      writeRespawnMarker({ session, sessionId: stdinSid ?? session.sid, accountId: decision.account.id, waitUntil: decision.waitUntil ?? now });
      log("stopfailure.marker", { session: session.sid.slice(0, 8), account: decision.account.id.slice(0, 8), waitUntil: decision.waitUntil ?? now });
    } else {
      log("stopfailure.decision", { reason: decision.reason, swapped: decision.swapped, account: decision.account?.id.slice(0, 8), waitUntil: decision.waitUntil });
    }
  } catch (e) {
    log("stopfailure.error", { err: e instanceof Error ? e.message : String(e) });
  }
  return 0;
}
