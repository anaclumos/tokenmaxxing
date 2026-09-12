import { join } from "node:path";
import { z } from "zod";
import { paths } from "../lib/paths.ts";
import { writeFileAtomic } from "../lib/atomic.ts";
import { readOAuthAccount } from "../lib/claudejson.ts";
import { enforcedWindowMs, evaluateAndMaybeSwap, recordEnforcedLimit } from "../lib/decide.ts";
import { POST_SWAP_COOLDOWN_MS, loadConfig, loadLastSwapAt } from "../lib/state.ts";
import { classifyEnforcedLimit, findEnforcedRow, parseErrorBody, readTranscriptTail } from "../lib/usage.ts";
import { RespawnMarkerSchema, type EnforcedLimit } from "../lib/types.ts";
import { log } from "../lib/log.ts";

const StopFailureStdin = z.looseObject({
  session_id: z.uuid().optional().catch(undefined),
  transcript_path: z.string().optional().catch(undefined),
  error: z.string().optional().catch(undefined),
  agent_id: z.string().optional().catch(undefined),
  last_assistant_message: z.string().optional().catch(undefined),
});

const LaunchedAtSchema = z.coerce.number().finite().optional().catch(undefined);

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const c of Bun.stdin.stream()) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

export async function runStopFailureHook(): Promise<number> {
  if (process.env.TOKENMAXXING_PROBE) return 0;

  const account = readOAuthAccount()?.accountUuid ?? null;
  const now = Date.now();
  const raw = await readStdin();
  const parsed = StopFailureStdin.safeParse((() => { try { return JSON.parse(raw); } catch { return {}; } })());
  const stdin = parsed.success ? parsed.data : {};
  if (stdin.error !== undefined && stdin.error !== "rate_limit") return 0;

  const stdinSid = stdin.session_id;
  const pinnedSid = process.env.TOKENMAXXING_SESSION_ID;
  const launchedAt = LaunchedAtSchema.parse(process.env.TOKENMAXXING_LAUNCHED_AT) ?? null;
  const mainLoop = stdin.agent_id === undefined;
  const canPause = process.env.TOKENMAXXING_SUPERVISED === "1" && pinnedSid != null && mainLoop;

  try {
    const lastSwapAt = loadLastSwapAt();
    if (lastSwapAt != null && now - lastSwapAt < POST_SWAP_COOLDOWN_MS) {
      log("stopfailure.cooldown", { sinceSwapMs: now - lastSwapAt });
      return 0;
    }
    const cfg = loadConfig();
    const row = stdin.transcript_path
      ? findEnforcedRow({ rows: readTranscriptTail(stdin.transcript_path), lastAssistantMessage: stdin.last_assistant_message, now })
      : null;
    const limit = row ? classifyEnforcedLimit(row, cfg.policy.switchModels) : null;

    let enforced: EnforcedLimit | null = null;
    if (limit && account) {
      const stamp = await recordEnforcedLimit({ limit, account, now });
      log("stopfailure.enforced", { kind: limit.kind, family: limit.kind === "model" ? limit.family : undefined, outcome: stamp.outcome, resetsAt: stamp.resetsAt, subagent: !mainLoop });
      if (stamp.outcome === "stamped") {
        enforced = { account, family: limit.kind === "model" ? limit.family : null, resetsAt: stamp.resetsAt, windowMs: enforcedWindowMs(limit), subagent: !mainLoop };
      }
    } else {
      log("stopfailure.unclassified", {
        row: row != null,
        type: row?.quotaLimits?.rateLimitType,
        transient: row?.apiErrorIsTransient,
        body: row ? parseErrorBody(row.errorDetails)?.error?.type : undefined,
      });
    }

    const decision = await evaluateAndMaybeSwap(now, canPause && enforced != null, enforced);
    if (enforced && canPause && pinnedSid && decision.account && (decision.swapped || decision.waitUntil !== undefined)) {
      const marker = join(paths.respawnDir, pinnedSid);
      const payload = RespawnMarkerSchema.parse({
        account: decision.account.label,
        ts: Date.now(),
        waitUntil: decision.waitUntil ?? now,
        sessionId: stdinSid ?? pinnedSid,
        ...(launchedAt != null ? { launchedAt } : {}),
      });
      writeFileAtomic(marker, JSON.stringify(payload));
      log("stopfailure.marker", { session: (stdinSid ?? pinnedSid).slice(0, 8), account: decision.account.accountUuid.slice(0, 8), waitUntil: payload.waitUntil });
    } else {
      log("stopfailure.decision", { reason: decision.reason, swapped: decision.swapped, account: decision.account?.accountUuid.slice(0, 8), waitUntil: decision.waitUntil });
    }
  } catch (e) {
    log("stopfailure.error", { err: e instanceof Error ? e.message : String(e) });
  }
  return 0;
}
