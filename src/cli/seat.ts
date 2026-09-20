import { ensureCodexStoreHome } from "../lib/codexauth.ts";
import { withLock } from "../lib/lock.ts";
import { log } from "../lib/log.ts";
import { codexPaths, codexPool } from "../lib/paths.ts";
import { seatCounts, writePresence } from "../lib/presence.ts";
import { isExhausted, pickBest, thresholdBars, type PickCtx } from "../lib/picker.ts";
import { loadAccounts, loadConfig } from "../lib/state.ts";
import { emitError } from "./render.ts";

export async function cmdSeat(pidRaw: string | undefined, extra: string[]): Promise<number> {
  const pid = Number(pidRaw);
  if (!Number.isInteger(pid) || pid <= 1 || extra.length > 0) {
    emitError({ message: "usage: tokenmaxxing seat --codex <pid> - print the CODEX_HOME of one pooled account, reserved until <pid> exits" });
    return 2;
  }
  const now = Date.now();
  const granted = await withLock(codexPool.lockFile, () => {
    const ctx: PickCtx = { now, thresholds: thresholdBars(loadConfig()), currentId: null, families: null, seats: null };
    const present = seatCounts(codexPaths.presenceDir);
    const usable = loadAccounts(codexPool).accounts.filter(
      (a) => a.needsReauth !== true && !isExhausted(a, ctx) && !present.has(a.id)
    );
    const picked = pickBest(usable, ctx);
    if (!picked) return null;
    const store = ensureCodexStoreHome(picked.id);
    writePresence({ dir: codexPaths.presenceDir, id: `seat-${pid}`, accountId: picked.id, pid });
    return { store, id: picked.id };
  });
  if (!granted) {
    emitError({ message: "no usable codex account (pool empty, every account live in another session, or every account at a limit) - use the ambient codex login" });
    return 1;
  }
  log("seat.grant", { account: granted.id.slice(0, 8), pid });
  console.log(granted.store);
  return 0;
}
