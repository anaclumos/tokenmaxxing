import { clamp, delay } from "es-toolkit";
import { loadAccounts } from "../lib/state.ts";
import { loadCodexAccounts } from "../lib/codexstate.ts";
import { cmdStatus } from "./status.ts";
import { c, emitError, emitJson } from "./render.ts";

const DEFAULT_INTERVAL_S = 120;
const MIN_INTERVAL_S = 30;
const MAX_INTERVAL_S = 86_400;

export function resolveWatchInterval(arg?: string): number | null {
  if (arg === undefined) return DEFAULT_INTERVAL_S;
  const n = Number(arg);
  if (!Number.isFinite(n) || n <= 0) return null;
  return clamp(n, MIN_INTERVAL_S, MAX_INTERVAL_S);
}

const CLEAR = "\x1b[H\x1b[2J\x1b[3J";

export async function cmdWatch(intervalArg?: string, json = false): Promise<number> {
  const intervalS = resolveWatchInterval(intervalArg);
  if (intervalS === null) {
    emitError({ json, message: `watch interval must be a positive number of seconds, got: ${intervalArg}` });
    return 2;
  }
  if (loadAccounts().accounts.length === 0 && loadCodexAccounts().accounts.length === 0) return cmdStatus({ json });

  const paintHeader = () => {
    process.stdout.write(process.stdout.isTTY ? CLEAR : "\n");
    console.log(c.dim(`watch: every ${intervalS}s, ${new Date().toLocaleTimeString()}, ctrl-c to quit`));
  };
  while (true) {
    try {
      await cmdStatus(json ? { json } : { preRender: paintHeader });
    } catch (e) {
      const message = `status failed this tick: ${e instanceof Error ? e.message : String(e)}`;
      if (json) {
        emitJson({ ok: false, error: message });
      } else {
        paintHeader();
        console.error(c.red(message));
      }
    }
    await delay(intervalS * 1000);
  }
}
