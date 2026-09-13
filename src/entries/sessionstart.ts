import { z } from "zod";
import { claude } from "../lib/claude.ts";
import { evaluateAndMaybeSwap } from "../lib/decide.ts";
import { supervisedSession, writeRespawnMarker } from "../lib/sessions.ts";
import { log } from "../lib/log.ts";
import { readStdin } from "./statusline.ts";
import { JsonTextSchema } from "../lib/types.ts";

const SessionStartStdin = z.looseObject({
  source: z.string().optional(),
  session_id: z.uuid().optional().catch(undefined),
});

export async function runSessionStart(): Promise<number> {
  if (process.env.TOKENMAXXING_PROBE) return 0;

  const raw = await readStdin();
  const parsed = SessionStartStdin.safeParse(JsonTextSchema.safeParse(raw).data);
  const source = parsed.success ? parsed.data.source : undefined;
  const stdinSid = parsed.success ? parsed.data.session_id : undefined;
  const session = supervisedSession();

  try {
    const decision = await evaluateAndMaybeSwap(claude, Date.now(), session != null);
    if (session && decision.account && (decision.swapped || decision.waitUntil !== undefined)) {
      writeRespawnMarker({ session, sessionId: stdinSid ?? session.sid, accountId: decision.account.id, waitUntil: decision.waitUntil ?? Date.now() });
      log("sessionstart.marker", { source, account: decision.account.id.slice(0, 8), waitUntil: decision.waitUntil });
    }
  } catch (e) {
    log("sessionstart.error", { err: e instanceof Error ? e.message : String(e) });
  }
  return 0;
}
