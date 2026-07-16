// Stop hook. Fires when claude finishes a turn (transcript already committed).
// A plain swap needs no respawn: the running session adopts the swapped
// credential on its own (<=30s on macOS, next request on Linux). Only a
// depleted-pool wait - when running under the supervisor - drops a respawn
// marker keyed by this session id: the supervisor SIGTERMs its child at this
// clean boundary, counts down to the reset, then relaunches `--resume`. We
// never kill claude ourselves.

import { join } from "node:path";
import { z } from "zod";
import { paths } from "../lib/paths.ts";
import { writeFileAtomic } from "../lib/atomic.ts";
import { evaluateAndMaybeSwap } from "../lib/decide.ts";
import { RespawnMarkerSchema } from "../lib/types.ts";
import { log } from "../lib/log.ts";

const StopStdin = z.looseObject({ session_id: z.string().optional() });

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const c of Bun.stdin.stream()) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

export async function runStopHook(): Promise<number> {
  // recursion guard - our own `-p '/usage'` probe re-enters hooks.
  if (process.env.TOKENMAXXING_PROBE) return 0;

  const raw = await readStdin();
  const parsed = StopStdin.safeParse((() => { try { return JSON.parse(raw); } catch { return {}; } })());
  const sessionId =
    (parsed.success ? parsed.data.session_id : undefined) ?? process.env.TOKENMAXXING_SESSION_ID;

  try {
    // Anticipatory depleted swaps are only sane when the respawn marker below
    // will actually pause the session until the reset.
    const canPause = process.env.TOKENMAXXING_SUPERVISED === "1" && sessionId != null;
    const decision = await evaluateAndMaybeSwap(Date.now(), canPause);
    if (decision.account && (decision.swapped || decision.waitUntil !== undefined)) {
      log(decision.swapped ? "stop.swapped" : "stop.wait", { account: decision.account.accountUuid.slice(0, 8), waitUntil: decision.waitUntil });
      // Respawn only for a depleted-pool wait: pausing until the reset requires
      // killing the child. A plain swap leaves the session running to adopt.
      if (decision.waitUntil !== undefined && process.env.TOKENMAXXING_SUPERVISED === "1" && sessionId) {
        const marker = join(paths.respawnDir, sessionId);
        const payload = RespawnMarkerSchema.parse({ account: decision.account.label, ts: Date.now(), waitUntil: decision.waitUntil });
        writeFileAtomic(marker, JSON.stringify(payload));
        log("stop.marker", { session: sessionId.slice(0, 8) });
      }
    }
  } catch (e) {
    log("stop.error", { err: String((e as Error).message ?? e) });
  }
  return 0; // never block the stop
}
