import { join } from "node:path";
import { z } from "zod";
import { paths } from "../lib/paths.ts";
import { writeFileAtomic } from "../lib/atomic.ts";
import { evaluateAndMaybeSwap } from "../lib/decide.ts";
import { errorMessage } from "../lib/errors.ts";
import { tryParseJson } from "../lib/json.ts";
import type { RespawnMarker } from "../lib/types.ts";
import { log } from "../lib/log.ts";

const StopStdin = z.looseObject({ session_id: z.uuid().optional().catch(undefined) });

const LaunchedAtSchema = z.coerce.number().finite().optional();

export async function runStopHook(): Promise<number> {
  if (process.env.TOKENMAXXING_PROBE) return 0;

  const stdinSid = tryParseJson(StopStdin, await Bun.stdin.text())?.session_id;
  const pinnedSid = process.env.TOKENMAXXING_SESSION_ID;

  try {
    const canPause = process.env.TOKENMAXXING_SUPERVISED === "1" && pinnedSid != null;
    const decision = await evaluateAndMaybeSwap(Date.now(), canPause);
    if (decision.account && (decision.swapped || decision.waitUntil !== undefined)) {
      log(decision.swapped ? "stop.swapped" : "stop.wait", { account: decision.account.accountUuid.slice(0, 8), waitUntil: decision.waitUntil });
      if (decision.waitUntil !== undefined && canPause && pinnedSid) {
        const marker = join(paths.respawnDir, pinnedSid);
        const launchedAt = LaunchedAtSchema.parse(process.env.TOKENMAXXING_LAUNCHED_AT);
        const payload: RespawnMarker = {
          account: decision.account.label,
          ts: Date.now(),
          waitUntil: decision.waitUntil,
          sessionId: stdinSid ?? pinnedSid,
          ...(launchedAt != null ? { launchedAt } : {}),
        };
        writeFileAtomic(marker, JSON.stringify(payload));
        log("stop.marker", { session: (stdinSid ?? pinnedSid).slice(0, 8) });
      }
    }
  } catch (e) {
    log("stop.error", { err: errorMessage(e) });
  }
  return 0;
}
