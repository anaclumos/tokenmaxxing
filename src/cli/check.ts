import { CHECK_DELAY_FLOOR_MS, checkDelayMs, evaluateAndMaybeSwap } from "../lib/decide.ts";
import { readOAuthAccount } from "../lib/claudejson.ts";
import { log } from "../lib/log.ts";
import { loadConfig, loadNextCheckDueAt, saveNextCheckDueAt } from "../lib/state.ts";
import { c, fmtReset } from "./render.ts";

const TICK_SLACK_MS = CHECK_DELAY_FLOOR_MS / 2;

export async function cmdCheck(args: string[] = []): Promise<number> {
  const now = Date.now();
  const dueAt = args.includes("--if-due") ? loadNextCheckDueAt(now) : null;
  if (dueAt != null && now + TICK_SLACK_MS < dueAt) {
    console.log(c.dim(`not due (${Math.ceil((dueAt - now) / 1000)}s)`));
    return 0;
  }
  let d;
  try {
    d = await evaluateAndMaybeSwap(now);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    log("check.error", { err: detail });
    console.error(c.red(`check failed: ${detail}`));
    return 1;
  }
  const delayMs = checkDelayMs({ cfg: loadConfig(), org: readOAuthAccount()?.organizationUuid ?? null, now, decision: d });
  saveNextCheckDueAt({ dueAt: now + delayMs, ts: now });
  const next = c.dim(`next in ${Math.round(delayMs / 1000)}s`);
  if (d.swapped && d.account) {
    console.log(`${c.green("↻")} switched to ${c.bold(d.account.label)} ${next}`);
  } else if (d.waitUntil !== undefined && d.account) {
    console.log(c.yellow(`all accounts at limit - staying on ${c.bold(d.account.label)} (${fmtReset(d.waitUntil)})`) + ` ${next}`);
  } else {
    console.log(c.dim(`no switch (${d.reason}) `) + next);
  }
  return 0;
}
