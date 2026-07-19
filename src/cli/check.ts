// `tokenmaxxing check` - one auto-switch evaluation, the same decision the
// Stop/SessionStart hooks make (flocked, idempotent). Installed as a periodic
// launchd/systemd job so a limit crossed mid-turn, or with no session running,
// still switches within minutes; the hooks only ever see turn boundaries.
// Running claude sessions adopt the swapped credential in place (<=30s).

import { evaluateAndMaybeSwap } from "../lib/decide.ts";
import { log } from "../lib/log.ts";
import { c, fmtReset } from "./render.ts";

export async function cmdCheck(): Promise<number> {
  let d;
  try {
    d = await evaluateAndMaybeSwap();
  } catch (e) {
    // unattended under the timer: the log is the only place anyone will look.
    const detail = e instanceof Error ? e.message : String(e);
    log("check.error", { err: detail });
    console.error(c.red(`check failed: ${detail}`));
    return 1;
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
