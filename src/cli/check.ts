import { checkDelayMs, evaluateAndMaybeSwap } from "../lib/decide.ts";
import { readOAuthAccount } from "../lib/claudejson.ts";
import { log } from "../lib/log.ts";
import { loadConfig, loadNextCheckDueAt, saveNextCheckDueAt } from "../lib/state.ts";
import { c, emitError, emitJson, fmtReset } from "./render.ts";

export async function cmdCheck(args: string[] = [], json = false): Promise<number> {
  const now = Date.now();
  let cfg;
  let d;
  try {
    cfg = loadConfig();
    const dueAt = args.includes("--if-due") ? loadNextCheckDueAt({ now, cfg }) : null;
    if (dueAt != null && now + cfg.policy.checkIntervalMs / 2 < dueAt) {
      if (json) emitJson({ ok: true, due: false, nextCheckAt: dueAt });
      else console.log(c.dim(`not due (${Math.ceil((dueAt - now) / 1000)}s)`));
      return 0;
    }
    d = await evaluateAndMaybeSwap(now);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    log("check.error", { err: detail });
    emitError({ json, message: `check failed: ${detail}` });
    return 1;
  }
  const delayMs = checkDelayMs({ cfg, account: readOAuthAccount()?.accountUuid ?? null, now, decision: d });
  saveNextCheckDueAt({ dueAt: now + delayMs, ts: now });
  if (json) {
    emitJson({
      ok: true,
      due: true,
      swapped: d.swapped,
      account: d.account?.label ?? null,
      reason: d.reason,
      waitUntil: d.waitUntil ?? null,
      nextCheckAt: now + delayMs,
    });
    return 0;
  }
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
