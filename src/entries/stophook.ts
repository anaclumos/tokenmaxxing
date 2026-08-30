import { join } from "node:path";
import { z } from "zod";
import { paths } from "../lib/paths.ts";
import { writeFileAtomic } from "../lib/atomic.ts";
import { evaluateAndMaybeSwap } from "../lib/decide.ts";
import { RespawnMarkerSchema } from "../lib/types.ts";
import { log } from "../lib/log.ts";

const StopStdin = z.looseObject({ session_id: z.uuid().optional().catch(undefined) });

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const c of Bun.stdin.stream()) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

export async function runStopHook(): Promise<number> {
  if (process.env.TOKENMAXXING_PROBE) return 0;

  const raw = await readStdin();
  const parsed = StopStdin.safeParse((() => { try { return JSON.parse(raw); } catch { return {}; } })());
  const stdinSid = parsed.success ? parsed.data.session_id : undefined;
  const pinnedSid = process.env.TOKENMAXXING_SESSION_ID;

  try {
    const canPause = process.env.TOKENMAXXING_SUPERVISED === "1" && pinnedSid != null;
    const decision = await evaluateAndMaybeSwap(Date.now(), canPause);
    if (decision.account && (decision.swapped || decision.waitUntil !== undefined)) {
      log(decision.swapped ? "stop.swapped" : "stop.wait", { account: decision.account.accountUuid.slice(0, 8), waitUntil: decision.waitUntil });
      if (decision.waitUntil !== undefined && canPause && pinnedSid) {
        const marker = join(paths.respawnDir, pinnedSid);
        const launchedAt = z.coerce.number().finite().optional().catch(undefined).parse(process.env.TOKENMAXXING_LAUNCHED_AT);
        const payload = RespawnMarkerSchema.parse({
          account: decision.account.label,
          ts: Date.now(),
          waitUntil: decision.waitUntil,
          sessionId: stdinSid ?? pinnedSid,
          ...(launchedAt != null ? { launchedAt } : {}),
        });
        writeFileAtomic(marker, JSON.stringify(payload));
        log("stop.marker", { session: (stdinSid ?? pinnedSid).slice(0, 8) });
      }
    }
  } catch (e) {
    log("stop.error", { err: e instanceof Error ? e.message : String(e) });
  }
  return 0;
}
