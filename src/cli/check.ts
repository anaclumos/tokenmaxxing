import { evaluateAndMaybeSwap } from "../lib/decide.ts";
import { log } from "../lib/log.ts";
import { c, emitError, emitJson, fmtReset } from "./render.ts";

export async function cmdCheck(json = false): Promise<number> {
  let d;
  try {
    d = await evaluateAndMaybeSwap(Date.now());
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    log("check.error", { err: detail });
    emitError({ json, message: `check failed: ${detail}` });
    return 1;
  }
  if (json) {
    emitJson({
      ok: true,
      swapped: d.swapped,
      account: d.account?.label ?? null,
      reason: d.reason,
      waitUntil: d.waitUntil ?? null,
    });
    return 0;
  }
  if (d.swapped && d.account) {
    console.log(`${c.green("↻")} switched to ${c.bold(d.account.label)}`);
  } else if (d.waitUntil !== undefined && d.account) {
    console.log(c.yellow(`all accounts at limit - staying on ${c.bold(d.account.label)} (${fmtReset(d.waitUntil)})`));
  } else {
    console.log(c.dim(`no switch (${d.reason})`));
  }
  return 0;
}
