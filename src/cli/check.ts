import { checkDelayMs, evaluateAndMaybeSwap } from "../lib/decide.ts";
import { readOAuthAccount } from "../lib/claudejson.ts";
import { log } from "../lib/log.ts";
import { loadConfig, loadNextCheckDueAt, saveNextCheckDueAt } from "../lib/state.ts";
import { c, fmtReset } from "./render.ts";

export async function cmdCheck(): Promise<number> {
  const now = Date.now();
  const dueAt = loadNextCheckDueAt(now);
  if (dueAt != null && now < dueAt) {
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
  const after = Date.now();
  const delayMs = checkDelayMs({ cfg: loadConfig(), org: readOAuthAccount()?.organizationUuid ?? null, now: after, decision: d });
  saveNextCheckDueAt({ dueAt: after + delayMs, ts: after });
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
