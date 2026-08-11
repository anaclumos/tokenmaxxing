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
import { writeTurnDoneMarker } from "../lib/relay/markers.ts";
import { registryHas } from "../lib/relay/registry.ts";
import { RELAY_SESSION_ENV } from "../lib/relay/worker.ts";
import { RespawnMarkerSchema } from "../lib/types.ts";
import { log } from "../lib/log.ts";

// session_id must be a real transcript UUID: a malformed value would ride the
// respawn marker into `--resume <garbage>`, which claude treats as a picker
// search term (PR #36 review catch); non-UUID input drops to undefined and the
// marker falls back to the pinned sid.
const StopStdin = z.looseObject({ session_id: z.uuid().optional().catch(undefined) });

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
  // TWO session ids with different jobs (closing-review HIGH catch): the
  // PINNED id (env, set once by the supervisor) names the marker file the
  // supervisor actually watches and survives /clear; the STDIN id names the
  // CURRENT transcript to resume and drifts to a new value after /clear.
  // Keying the file by the stdin id orphaned every post-/clear marker.
  const stdinSid = parsed.success ? parsed.data.session_id : undefined;
  const pinnedSid = process.env.TOKENMAXXING_SESSION_ID;

  try {
    // Additive relay turn-done marker (never writes into respawn/). Only when
    // a registry entry exists for this relay session.
    const relaySid = process.env[RELAY_SESSION_ENV];
    if (relaySid != null && registryHas({ sessionId: relaySid })) {
      writeTurnDoneMarker({ sessionId: relaySid, source: "claude-stop" });
      log("stop.relay_turn_done", { session: relaySid.slice(0, 8) });
    }

    // Anticipatory depleted swaps are only sane when the respawn marker below
    // will actually pause the session until the reset.
    const canPause = process.env.TOKENMAXXING_SUPERVISED === "1" && pinnedSid != null;
    const decision = await evaluateAndMaybeSwap(Date.now(), canPause);
    if (decision.account && (decision.swapped || decision.waitUntil !== undefined)) {
      log(decision.swapped ? "stop.swapped" : "stop.wait", { account: decision.account.accountUuid.slice(0, 8), waitUntil: decision.waitUntil });
      // Respawn only for a depleted-pool wait: pausing until the reset requires
      // killing the child. A plain swap leaves the session running to adopt.
      if (decision.waitUntil !== undefined && canPause && pinnedSid) {
        const marker = join(paths.respawnDir, pinnedSid);
        const payload = RespawnMarkerSchema.parse({
          account: decision.account.label,
          ts: Date.now(),
          waitUntil: decision.waitUntil,
          sessionId: stdinSid ?? pinnedSid,
        });
        writeFileAtomic(marker, JSON.stringify(payload));
        log("stop.marker", { session: (stdinSid ?? pinnedSid).slice(0, 8) });
      }
    }
  } catch (e) {
    log("stop.error", { err: e instanceof Error ? e.message : String(e) });
  }
  return 0; // never block the stop
}
