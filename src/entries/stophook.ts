import { z } from "zod";
import { claude } from "../lib/claude.ts";
import { evaluateAndMaybeSwap } from "../lib/decide.ts";
import { readStdin } from "../lib/proc.ts";
import { supervisedSession, writeRespawnMarker } from "../lib/sessions.ts";
import { JsonTextSchema } from "../lib/types.ts";
import { errorMessage, log } from "../lib/log.ts";

const BoundaryStdin = z.looseObject({
  source: z.string().optional(),
  session_id: z.uuid().optional().catch(undefined),
});

export async function runBoundaryHook(event: "stop" | "sessionstart"): Promise<number> {
  if (process.env.TOKENMAXXING_PROBE) return 0;

  const parsed = BoundaryStdin.safeParse(JsonTextSchema.safeParse(await readStdin()).data);
  const stdin = parsed.success ? parsed.data : {};
  const session = supervisedSession();
  const nested = stdin.session_id != null && session != null && stdin.session_id !== session.sid;
  if (nested) {
    log(`${event}.nested_session`, { stdin: stdin.session_id?.slice(0, 8), supervised: session?.sid.slice(0, 8) });
    return 0;
  }

  try {
    const decision = await evaluateAndMaybeSwap(claude, Date.now(), session != null);
    if (session && decision.account && (decision.swapped || decision.waitUntil !== undefined)) {
      writeRespawnMarker({ session, sessionId: stdin.session_id ?? session.sid, accountId: decision.account.id, waitUntil: decision.waitUntil ?? Date.now(), compact: true });
      log(`${event}.${decision.waitUntil !== undefined ? "wait" : "move"}`, { source: stdin.source, account: decision.account.id.slice(0, 8), waitUntil: decision.waitUntil, session: session.sid.slice(0, 8) });
    }
  } catch (e) {
    log(`${event}.error`, { err: errorMessage(e) });
  }
  return 0;
}
