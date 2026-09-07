import { z } from "zod";
import { evaluateAndMaybeSwap } from "../lib/decide.ts";
import { errorMessage } from "../lib/errors.ts";
import { tryParseJson } from "../lib/json.ts";
import { log } from "../lib/log.ts";

const SessionStartStdin = z.looseObject({
  source: z.string().optional(),
  session_id: z.string().optional(),
});

export async function runSessionStart(): Promise<number> {
  if (process.env.TOKENMAXXING_PROBE) return 0;

  const source = tryParseJson(SessionStartStdin, await Bun.stdin.text())?.source;

  try {
    const decision = await evaluateAndMaybeSwap();
    if (decision.swapped && decision.account) {
      log("sessionstart.swapped", { source, account: decision.account.accountUuid.slice(0, 8) });
    }
  } catch (e) {
    log("sessionstart.error", { err: errorMessage(e) });
  }
  return 0;
}
