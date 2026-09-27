import { borrowCodexSeat } from "../lib/codex.ts";
import { emitError } from "./render.ts";

export async function cmdSeat(pidRaw: string | undefined, extra: string[]): Promise<number> {
  const pid = pidRaw != null && /^(0|[1-9][0-9]*)$/.test(pidRaw) ? Number(pidRaw) : NaN;
  if (!Number.isSafeInteger(pid) || pid < 2 || extra.length > 0) {
    emitError({ message: "usage: tokenmaxxing seat --codex <pid> - print the CODEX_HOME of one pooled account, reserved until <pid> exits" });
    return 2;
  }
  const granted = await borrowCodexSeat(pid);
  if (!granted) {
    emitError({ message: "no usable codex account (pool empty, every account live in another session, or every account at a limit) - use the ambient codex login" });
    return 1;
  }
  if ("denied" in granted) {
    emitError({ message: granted.denied });
    return 1;
  }
  console.log(granted.store);
  return 0;
}
