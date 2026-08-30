import { z } from "zod";
import { evaluateAndMaybeSwap } from "../lib/decide.ts";
import { log } from "../lib/log.ts";

const SessionStartStdin = z.looseObject({
  source: z.string().optional(),
  session_id: z.string().optional(),
});

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const c of Bun.stdin.stream()) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

export async function runSessionStart(): Promise<number> {
  if (process.env.TOKENMAXXING_PROBE) return 0;

  const raw = await readStdin();
  const parsed = SessionStartStdin.safeParse((() => { try { return JSON.parse(raw); } catch { return {}; } })());
  const source = parsed.success ? parsed.data.source : undefined;

  try {
    const decision = await evaluateAndMaybeSwap();
    if (decision.swapped && decision.account) {
      log("sessionstart.swapped", { source, account: decision.account.accountUuid.slice(0, 8) });
    }
  } catch (e) {
    log("sessionstart.error", { err: e instanceof Error ? e.message : String(e) });
  }
  return 0;
}
