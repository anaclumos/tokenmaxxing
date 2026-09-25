import { z } from "zod";
import { claude } from "../lib/claude.ts";
import { evaluateAndMaybeSwap } from "../lib/decide.ts";
import { readStdin } from "../lib/proc.ts";
import { adoptLiveSession, refusedAccounts, supervisedSession, writeRespawnMarker } from "../lib/sessions.ts";
import { loadConfig } from "../lib/state.ts";
import { classifyEnforcedLimit, findEnforcedRow, parseErrorBody, readTranscriptTail, type TranscriptRow } from "../lib/usage.ts";
import { paths } from "../lib/paths.ts";
import { JsonTextSchema, type EnforcedLimit } from "../lib/types.ts";
import { errorMessage, log } from "../lib/log.ts";

const StopFailureStdin = z.looseObject({
  session_id: z.uuid().optional().catch(undefined),
  transcript_path: z.string().optional().catch(undefined),
  error: z.string().optional().catch(undefined),
  agent_id: z.string().optional().catch(undefined),
  last_assistant_message: z.string().optional().catch(undefined),
});

const ROW_WAIT_MS = 3_000;
const ROW_POLL_MS = 200;

async function awaitEnforcedRow(input: { transcriptPath: string; lastAssistantMessage: string | undefined; now: number }): Promise<TranscriptRow | null> {
  const deadline = Date.now() + ROW_WAIT_MS;
  while (true) {
    const row = findEnforcedRow({ rows: readTranscriptTail(input.transcriptPath), lastAssistantMessage: input.lastAssistantMessage, now: input.now });
    if (row || Date.now() >= deadline) return row;
    await Bun.sleep(ROW_POLL_MS);
  }
}

export async function runStopFailureHook(): Promise<number> {
  if (process.env.TOKENMAXXING_PROBE) return 0;

  const account = claude.liveId();
  const now = Date.now();
  const parsed = StopFailureStdin.safeParse(JsonTextSchema.safeParse(await readStdin()).data);
  const stdin = parsed.success ? parsed.data : {};
  if (stdin.error !== undefined && stdin.error !== "rate_limit") return 0;

  const stdinSid = stdin.session_id;
  const mainLoop = stdin.agent_id === undefined;

  try {
    const supervised = supervisedSession();
    const session = supervised == null ? null : adoptLiveSession(supervised, stdinSid);
    if (supervised != null && session == null) {
      log("stopfailure.nested_session", { stdin: stdinSid?.slice(0, 8), supervised: supervised.live.slice(0, 8) });
      return 0;
    }
    const canRespawn = session != null && mainLoop;
    const cfg = loadConfig();
    const row = stdin.transcript_path
      ? await awaitEnforcedRow({ transcriptPath: stdin.transcript_path, lastAssistantMessage: stdin.last_assistant_message, now })
      : null;
    const limit = row ? classifyEnforcedLimit(row, cfg.policy.switchModels) : null;

    let enforced: EnforcedLimit | null = null;
    if (limit && account) {
      enforced = { account, kind: limit.kind, family: limit.kind === "model" || limit.kind === "credits" ? limit.family : null, resetsAt: limit.resetsAt, blind: !mainLoop && limit.kind !== "model" };
      log("stopfailure.enforced", { kind: limit.kind, family: enforced.family ?? undefined, resetsAt: limit.resetsAt, subagent: !mainLoop });
    } else {
      log("stopfailure.unclassified", {
        seat: account != null,
        subagent: !mainLoop,
        row: row != null,
        type: row?.quotaLimits?.rateLimitType,
        transient: row?.apiErrorIsTransient,
        body: row ? parseErrorBody(row.errorDetails)?.error?.type : undefined,
      });
    }

    if (session == null && limit != null) {
      const shim = `${paths.binDir}/claude`;
      log("stopfailure.unsupervised_hint", { sid: stdinSid });
      process.stdout.write(
        `${JSON.stringify({
          systemMessage: `tokenmaxxing: this session runs outside the supervisor, so it cannot move to another account at the limit. Move it yourself: ${stdinSid ? `${shim} --resume ${stdinSid}` : `resume it through ${shim}`}`,
        })}\n`,
      );
    }

    const refused = enforced?.kind === "credits" ? [...new Set([...refusedAccounts(), enforced.account])] : undefined;
    const decision = await evaluateAndMaybeSwap(claude, now, canRespawn, enforced, { waiterId: canRespawn ? session?.sid : undefined, exclude: refused });
    if (session && canRespawn && decision.account && (decision.swapped || decision.waitUntil !== undefined)) {
      writeRespawnMarker({ session, accountId: decision.account.id, waitUntil: decision.waitUntil ?? now, compact: false, origin: "stopfailure", refused });
      log("stopfailure.marker", { session: session.sid.slice(0, 8), live: session.live.slice(0, 8), account: decision.account.id.slice(0, 8), waitUntil: decision.waitUntil ?? now });
    } else {
      log("stopfailure.decision", { reason: decision.reason, swapped: decision.swapped, account: decision.account?.id.slice(0, 8), waitUntil: decision.waitUntil });
    }
  } catch (e) {
    log("stopfailure.error", { err: errorMessage(e) });
  }
  return 0;
}
