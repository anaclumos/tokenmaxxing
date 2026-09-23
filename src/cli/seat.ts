import { observeCodex } from "../lib/codex.ts";
import { codexStoreUsable, ensureCodexStoreHome } from "../lib/codexauth.ts";
import { withLock } from "../lib/lock.ts";
import { log } from "../lib/log.ts";
import { codexPaths, codexPool } from "../lib/paths.ts";
import { livingPresences, writePresence } from "../lib/presence.ts";
import { isExhausted, pickBest, thresholdBars, type PickCtx } from "../lib/picker.ts";
import { loadAccounts, loadConfig } from "../lib/state.ts";
import { emitError } from "./render.ts";

export async function cmdSeat(pidRaw: string | undefined, extra: string[]): Promise<number> {
  const pid = pidRaw != null && /^(0|[1-9][0-9]*)$/.test(pidRaw) ? Number(pidRaw) : NaN;
  if (!Number.isSafeInteger(pid) || pid < 2 || extra.length > 0) {
    emitError({ message: "usage: tokenmaxxing seat --codex <pid> - print the CODEX_HOME of one pooled account, reserved until <pid> exits" });
    return 2;
  }
  const now = Date.now();
  const seatId = `seat-${pid}`;
  const cfg = loadConfig();
  await Promise.all(
    loadAccounts(codexPool)
      .accounts.filter((a) => a.needsReauth !== true && codexStoreUsable(a.id))
      .map((a) => observeCodex(a, cfg, now, { probe: true, refresh: false })),
  );
  const granted = await withLock(codexPool.lockFile, (): { store: string; id: string; reused: boolean } | { denied: string } | null => {
    const ctx: PickCtx = { now, thresholds: thresholdBars(loadConfig()), currentId: null, families: null, seats: null };
    const idx = loadAccounts(codexPool);
    const living = livingPresences(codexPaths.presenceDir);
    const held = living.find((p) => p.id === seatId);
    const heldAccount = held ? (idx.accounts.find((x) => x.id === held.accountId) ?? null) : null;
    if (heldAccount) {
      if (heldAccount.needsReauth === true) {
        return { denied: "the account this pid holds needs reauthentication - run `tokenmaxxing auth --codex` and borrow again" };
      }
      if (!codexStoreUsable(heldAccount.id)) {
        return { denied: "the account this pid holds has no usable credential in its store - refusing to hand back a credential-less seat" };
      }
      return { store: ensureCodexStoreHome(heldAccount.id), id: heldAccount.id, reused: true };
    }
    const present = new Set(living.map((p) => p.accountId));
    const usable = idx.accounts.filter(
      (a) => a.needsReauth !== true && !isExhausted(a, ctx) && !present.has(a.id) && codexStoreUsable(a.id)
    );
    const picked = pickBest(usable, ctx);
    if (!picked) return null;
    const store = ensureCodexStoreHome(picked.id);
    writePresence({ dir: codexPaths.presenceDir, id: seatId, accountId: picked.id, pid });
    return { store, id: picked.id, reused: false };
  });
  if (!granted) {
    emitError({ message: "no usable codex account (pool empty, every account live in another session, or every account at a limit) - use the ambient codex login" });
    return 1;
  }
  if ("denied" in granted) {
    emitError({ message: granted.denied });
    return 1;
  }
  log("seat.grant", { account: granted.id.slice(0, 8), pid, reused: granted.reused });
  console.log(granted.store);
  return 0;
}
