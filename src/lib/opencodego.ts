import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import { env, HOME, opencodeGoAuthJsonFor, opencodeGoPaths, opencodeGoPool, opencodeGoStoreDirFor } from "./paths.ts";
import { withLock } from "./lock.ts";
import { log } from "./log.ts";
import { livingPresences, writePresence } from "./presence.ts";
import type { Provider, SeatBorrow } from "./provider.ts";
import { loadAccounts, readJsonFile, type Harvest } from "./state.ts";
import { statusOnlyProvider, type AuthEntry } from "./statusonly.ts";
import { ErrnoSchema } from "./types.ts";
import { c } from "../cli/render.ts";

const OpencodeAuthEntrySchema = z.looseObject({ type: z.string(), key: z.string().optional() });
const OpencodeAuthFileSchema = z.record(z.string(), z.unknown());

function liveAuthPath(): string {
  return join(env("XDG_DATA_HOME", join(HOME, ".local", "share")), "opencode", "auth.json");
}

function idOfKey(key: string): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(`opencode-go:${key}`);
  return h.digest("hex");
}

function harvestOf(key: string): Harvest {
  const id = idOfKey(key);
  return {
    id,
    email: null,
    tier: "go",
    sample: null,
    park: async () => {
      writeFileAtomic(opencodeGoAuthJsonFor(id), JSON.stringify({ "opencode-go": { type: "api", key } }, null, 2), 0o600);
    },
  };
}

function readAuth(path: string): AuthEntry[] {
  let map: z.infer<typeof OpencodeAuthFileSchema>;
  try {
    map = readJsonFile(path, OpencodeAuthFileSchema);
  } catch (e) {
    if (ErrnoSchema.safeParse(e).data?.code === "ENOENT") return [];
    throw e;
  }
  const entry = OpencodeAuthEntrySchema.safeParse(map["opencode-go"]);
  if (!entry.success || entry.data.type !== "api" || !entry.data.key) return [];
  return [{ id: idOfKey(entry.data.key), usable: true, harvest: harvestOf(entry.data.key) }];
}

export async function borrowOpencodeGoSeat(pid: number): Promise<SeatBorrow> {
  const seatId = `seat-${pid}`;
  const granted = await withLock(opencodeGoPool.lockFile, async (): Promise<SeatBorrow> => {
    const accounts = loadAccounts(opencodeGoPool).accounts;
    const living = livingPresences(opencodeGoPaths.presenceDir);
    const held = living.find((p) => p.id === seatId);
    const heldAccount = held ? (accounts.find((a) => a.id === held.accountId) ?? null) : null;
    if (heldAccount) {
      if (!(await opencodeGo.storeUsable(heldAccount))) {
        return { denied: "the key this pid holds is no longer usable in its store - run `tokenmaxxing auth --opencode-go` and borrow again" };
      }
      return { store: opencodeGoStoreDirFor(heldAccount.id), id: heldAccount.id, reused: true };
    }
    const lent = new Set(living.map((p) => p.accountId));
    const open = accounts.filter((a) => !lent.has(a.id));
    const usable = await Promise.all(open.map(opencodeGo.storeUsable));
    const picked = open.find((_, i) => usable[i]);
    if (!picked) return null;
    writePresence({ dir: opencodeGoPaths.presenceDir, id: seatId, accountId: picked.id, pid });
    return { store: opencodeGoStoreDirFor(picked.id), id: picked.id, reused: false };
  });
  if (granted && !("denied" in granted)) log("seat.grant", { account: granted.id.slice(0, 8), pid, reused: granted.reused });
  return granted;
}

export const opencodeGo: Provider = statusOnlyProvider({
  name: "opencode-go",
  flag: " --opencode-go",
  pool: opencodeGoPool,
  binName: "opencode",
  binKey: "opencodeBin",
  storeDirFor: opencodeGoStoreDirFor,
  authJsonFor: opencodeGoAuthJsonFor,
  onboardDir: opencodeGoPaths.onboardDir,
  homeEnv: "XDG_DATA_HOME",
  loginArgs: ["providers", "login", "-p", "opencode-go"],
  onboardAuthRel: join("opencode", "auth.json"),
  liveAuthPath,
  readAuth,
  liveId: () => null,
  versionOk: (out) => out !== "",
  importIntro: "Pooling your opencode-go API key - your existing opencode auth stays as it is.",
  foundLive: () => `found an opencode-go credential in ${liveAuthPath()} - pooling it; use \`tokenmaxxing add --opencode-go\` for more keys.`,
  installNotice: "opencode-go pool is status-only: no supervisor or hooks installed. Use `tokenmaxxing status` to view pooled keys.",
  loginStep: () => `Paste the opencode-go API key from ${c.bold("opencode.ai/zen")} when opencode asks for it.`,
});
