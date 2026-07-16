// `tokenmaxxing watch [seconds]`: native live status (issue #3) - re-render
// `status` on an interval instead of `watch -n 120 'tokenmaxxing status'`.
// Plain `status` per tick, never `--force`: a ping meters real quota and starts
// 5h session windows, so watching must stay free; each refresh costs only the
// parked accounts' `/usage` probes the one-shot status already does.

import { clamp, delay } from "es-toolkit";
import { loadAccounts } from "../lib/state.ts";
import { cmdStatus } from "./status.ts";
import { c } from "./render.ts";

const DEFAULT_INTERVAL_S = 120;
/** Floor: each tick spawns a `/usage` probe per parked account (seconds each,
 *  under the flock); anything faster than this just queues probes. */
const MIN_INTERVAL_S = 30;
/** Cap: past ~24.8 days the setTimeout ms overflow collapses the sleep to ~1ms
 *  and the loop runs hot; a day is already beyond any sane watch cadence. */
const MAX_INTERVAL_S = 86_400;

/** Seconds between refreshes, clamped; null when the argument is not a positive number. */
export function resolveWatchInterval(arg?: string): number | null {
  if (arg === undefined) return DEFAULT_INTERVAL_S;
  const n = Number(arg);
  if (!Number.isFinite(n) || n <= 0) return null;
  return clamp(n, MIN_INTERVAL_S, MAX_INTERVAL_S);
}

/** Home + clear screen + clear scrollback. Written only once the fresh frame is
 *  ready to paint (cmdStatus preRender), so the previous frame stays readable
 *  through the multi-second sample instead of blanking - watch(1) semantics. */
const CLEAR = "\x1b[H\x1b[2J\x1b[3J";

export async function cmdWatch(intervalArg?: string): Promise<number> {
  const intervalS = resolveWatchInterval(intervalArg);
  if (intervalS === null) {
    console.error(c.red(`watch interval must be a positive number of seconds, got: ${intervalArg}`));
    return 2;
  }
  if (loadAccounts().accounts.length === 0) return cmdStatus();

  const paintHeader = () => {
    process.stdout.write(process.stdout.isTTY ? CLEAR : "\n");
    console.log(c.dim(`watch: every ${intervalS}s, ${new Date().toLocaleTimeString()}, ctrl-c to quit`));
  };
  while (true) {
    // One failed tick (a mid-write ~/.claude.json read, a transient probe or
    // lock error) must not kill an hours-long monitor: report it and keep the
    // cadence, exactly like watch(1) showing a failing command's output.
    try {
      await cmdStatus(false, paintHeader);
    } catch (e) {
      paintHeader();
      console.error(c.red(`status failed this tick: ${e instanceof Error ? e.message : String(e)}`));
    }
    await delay(intervalS * 1000);
  }
}
