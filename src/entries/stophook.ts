import { z } from "zod";
import { claude } from "../lib/claude.ts";
import { evaluateAndMaybeSwap } from "../lib/decide.ts";
import { supervisedSession, writeRespawnMarker } from "../lib/sessions.ts";
import { JsonTextSchema } from "../lib/types.ts";
import { log } from "../lib/log.ts";
import { readStdin } from "./statusline.ts";

const StopStdin = z.looseObject({ session_id: z.uuid().optional().catch(undefined) });

export async function runStopHook(): Promise<number> {
  if (process.env.TOKENMAXXING_PROBE) return 0;

  const raw = await readStdin();
  const parsed = StopStdin.safeParse(JsonTextSchema.safeParse(raw).data);
  const stdinSid = parsed.success ? parsed.data.session_id : undefined;
  const session = supervisedSession();

  try {
    const decision = await evaluateAndMaybeSwap(claude, Date.now(), session != null);
    if (session && decision.account && (decision.swapped || decision.waitUntil !== undefined)) {
      writeRespawnMarker({ session, sessionId: stdinSid ?? session.sid, accountId: decision.account.id, waitUntil: decision.waitUntil ?? Date.now() });
      log(decision.waitUntil !== undefined ? "stop.wait" : "stop.move", { account: decision.account.id.slice(0, 8), waitUntil: decision.waitUntil, session: session.sid.slice(0, 8) });
    }
  } catch (e) {
    log("stop.error", { err: e instanceof Error ? e.message : String(e) });
  }
  return 0;
}
