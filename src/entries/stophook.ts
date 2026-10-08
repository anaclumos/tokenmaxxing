import { z } from "zod";
import { claude } from "../lib/claude.ts";
import { evaluateAndMaybeSwap, moveTarget } from "../lib/decide.ts";
import { readStdin } from "../lib/proc.ts";
import { adoptLiveSession, keyMovesSupported, refusedAccounts, supervisedSession, writeRespawnMarker } from "../lib/sessions.ts";
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

  try {
    const supervised = supervisedSession();
    const session = supervised == null ? null : adoptLiveSession(supervised, stdin.session_id);
    if (supervised != null && session == null) {
      log(`${event}.nested_session`, { stdin: stdin.session_id?.slice(0, 8), supervised: supervised.live.slice(0, 8), source: stdin.source });
      return 0;
    }
    const decision = await evaluateAndMaybeSwap(claude, Date.now(), session != null, null, { waiterId: session?.sid, refused: refusedAccounts(), apiKeys: session != null && keyMovesSupported() });
    const target = moveTarget(decision);
    if (session && target) {
      writeRespawnMarker({ session, ...target, waitUntil: target.waitUntil ?? Date.now(), compact: true, origin: event });
      log(`${event}.${target.waitUntil !== undefined ? "wait" : "move"}`, { source: stdin.source, account: target.accountId.slice(0, 8), key: target.apiKeyId, waitUntil: target.waitUntil, session: session.sid.slice(0, 8), live: session.live.slice(0, 8) });
    }
  } catch (e) {
    log(`${event}.error`, { err: errorMessage(e) });
  }
  return 0;
}
