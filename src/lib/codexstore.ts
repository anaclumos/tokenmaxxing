import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import { ourCodexStopGroupIndex } from "./install.ts";
import { log } from "./log.ts";
import { codexPaths, codexPool, codexStoreDirFor } from "./paths.ts";
import { loadAccounts } from "./state.ts";

const SHARED_DIRS = ["sessions", "archived_sessions"];

function lexists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export function ensureCodexStore(accountId: string): string {
  const dir = codexStoreDirFor(accountId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of SHARED_DIRS) mkdirSync(join(codexPaths.home, name), { recursive: true });
  for (const name of readdirSync(dir)) {
    const entry = join(dir, name);
    if (lstatSync(entry).isSymbolicLink() && !existsSync(entry)) unlinkSync(entry);
  }
  for (const name of readdirSync(codexPaths.home)) {
    if (name === "auth.json" || name.includes(".sqlite")) continue;
    const link = join(dir, name);
    if (!lexists(link)) symlinkSync(join(codexPaths.home, name), link);
  }
  return dir;
}

const HookStateTomlSchema = z.looseObject({
  hooks: z
    .looseObject({
      state: z.record(z.string(), z.looseObject({ trusted_hash: z.string().optional() })).optional(),
    })
    .optional(),
});

function trustKey(homeDir: string, group: number): string {
  return `${homeDir}/hooks.json:stop:${group}:0`;
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

export function replicateHookTrust(storeDir: string): void {
  if (!existsSync(codexPaths.configToml)) return;
  const group = ourCodexStopGroupIndex();
  if (group == null) return;
  const text = readFileSync(codexPaths.configToml, "utf8");
  let state: Record<string, { trusted_hash?: string }>;
  try {
    state = HookStateTomlSchema.parse(Bun.TOML.parse(text)).hooks?.state ?? {};
  } catch (e) {
    log("codexstore.trust_skip", { err: e instanceof Error ? e.message : String(e) });
    return;
  }
  const key = trustKey(realpathSync(storeDir), group);
  if (key in state) return;
  const homes = [codexPaths.home, ...loadAccounts(codexPool).accounts.map((a) => codexStoreDirFor(a.id))]
    .map(realpathOrNull)
    .filter((home): home is string => home != null);
  const hash = homes.map((home) => state[trustKey(home, group)]?.trusted_hash).find((h) => h != null);
  if (hash == null) return;
  const sep = text === "" || text.endsWith("\n") ? "" : "\n";
  writeFileAtomic(
    codexPaths.configToml,
    `${text}${sep}\n[hooks.state.${JSON.stringify(key)}]\ntrusted_hash = ${JSON.stringify(hash)}\n`,
    statSync(codexPaths.configToml).mode & 0o777,
  );
  log("codexstore.trust_replicated", { store: storeDir });
}

export function codexSeatEnv(accountId: string): Record<string, string> {
  const dir = ensureCodexStore(accountId);
  replicateHookTrust(dir);
  return { CODEX_HOME: dir, CODEX_SQLITE_HOME: codexPaths.home, TOKENMAXXING_CODEX_HOME: codexPaths.home };
}
