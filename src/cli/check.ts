import { refreshOpenRouterCredit } from "../lib/apikeys.ts";
import { claude } from "../lib/claude.ts";
import { codex } from "../lib/codex.ts";
import { evaluateAndMaybeSwap, useBankedResets } from "../lib/decide.ts";
import { sampleOldest } from "../lib/sample.ts";
import { pruneStaleSessions } from "../lib/sessions.ts";
import { loadConfig } from "../lib/state.ts";
import { flushTelemetry, record } from "../lib/telemetry.ts";
import { maybeAutoUpdate } from "../lib/update.ts";
import { errorMessage, log } from "../lib/log.ts";
import { c, emitError, emitJson, fmtReset } from "./render.ts";

export async function cmdCheck(json = false): Promise<number> {
  const now = Date.now();
  let d;
  try {
    pruneStaleSessions(now);
    const cfg = loadConfig();
    const steps = [
      evaluateAndMaybeSwap(claude, now).then(async (decision) => {
        await sampleOldest(cfg);
        return decision;
      }),
      useBankedResets(codex, cfg, now),
      refreshOpenRouterCredit(),
      maybeAutoUpdate().then((updated) => {
        if (updated != null) record({ event: "update", ...updated });
      }),
    ] as const;
    const failures = (await Promise.allSettled(steps)).flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
    for (const e of failures.slice(1)) log("check.error", { err: errorMessage(e) });
    if (failures.length > 0) throw failures[0];
    const [decision] = await Promise.all(steps);
    d = decision;
  } catch (e) {
    const detail = errorMessage(e);
    log("check.error", { err: detail });
    emitError({ json, message: `check failed: ${detail}` });
    return 1;
  } finally {
    await flushTelemetry(now);
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
