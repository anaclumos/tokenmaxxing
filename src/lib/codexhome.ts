import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import { codexStopHookPosition, type CodexHookPosition } from "./install.ts";
import { log } from "./log.ts";
import { codexPaths, codexStoreDirFor, shortId } from "./paths.ts";
import { ErrnoSchema } from "./types.ts";

const STORE_ONLY = new Set(["auth.json"]);

const SHARED_DIRS = ["sessions", "archived_sessions", "thread-writer-locks", "shell_snapshots", "memories", "log", "tmp", ".tmp"];

function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (e) {
    if (ErrnoSchema.safeParse(e).data?.code === "ENOENT") return false;
    throw e;
  }
}

export function prepareCodexHome(accountId: string): string {
  const store = codexStoreDirFor(accountId);
  mkdirSync(store, { recursive: true, mode: 0o700 });
  for (const name of SHARED_DIRS) mkdirSync(join(codexPaths.home, name), { recursive: true });
  for (const name of readdirSync(store)) {
    if (STORE_ONLY.has(name)) continue;
    const entry = join(store, name);
    if (lstatSync(entry).isSymbolicLink() && !existsSync(entry)) unlinkSync(entry);
  }
  for (const name of readdirSync(codexPaths.home)) {
    if (STORE_ONLY.has(name)) continue;
    const entry = join(store, name);
    if (!entryExists(entry)) symlinkSync(join(codexPaths.home, name), entry);
  }
  return store;
}

const HookStateSchema = z.looseObject({ enabled: z.boolean().optional(), trusted_hash: z.string().optional() });
const ConfigTomlSchema = z.looseObject({
  hooks: z.looseObject({ state: z.record(z.string(), HookStateSchema).optional() }).optional(),
});

function hookKey(home: string, position: CodexHookPosition): string {
  return `${join(home, "hooks.json")}:stop:${position.group}:${position.handler}`;
}

export function propagateCodexHookTrust(storeDir: string): void {
  const position = codexStopHookPosition();
  if (!position || !existsSync(codexPaths.configToml)) return;
  const configPath = realpathSync(codexPaths.configToml);
  const text = readFileSync(configPath, "utf8");
  const states = ConfigTomlSchema.parse(Bun.TOML.parse(text)).hooks?.state ?? {};
  const storeKey = hookKey(realpathSync(storeDir), position);
  if (states[storeKey]?.trusted_hash != null) return;
  const suffix = `/hooks.json:stop:${position.group}:${position.handler}`;
  const source =
    [hookKey(codexPaths.home, position), hookKey(realpathSync(codexPaths.home), position)].map((key) => states[key]).find((state) => state?.trusted_hash != null) ??
    Object.entries(states).find(([key, state]) => key.endsWith(suffix) && state.trusted_hash != null)?.[1];
  if (source?.trusted_hash == null) return;
  const lines = [`[hooks.state.${JSON.stringify(storeKey)}]`, `trusted_hash = ${JSON.stringify(source.trusted_hash)}`];
  if (source.enabled != null) lines.push(`enabled = ${source.enabled}`);
  const next = `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}\n${lines.join("\n")}\n`;
  let copied: string | undefined;
  try {
    copied = ConfigTomlSchema.parse(Bun.TOML.parse(next)).hooks?.state?.[storeKey]?.trusted_hash;
  } catch (e) {
    log("codexhome.trust_skipped", { store: shortId(storeDir), err: e instanceof Error ? e.message : String(e) });
    return;
  }
  if (copied !== source.trusted_hash) {
    log("codexhome.trust_skipped", { store: shortId(storeDir), err: "appended state table did not read back" });
    return;
  }
  writeFileAtomic(configPath, next, statSync(configPath).mode & 0o777);
  log("codexhome.trust_copied", { store: shortId(storeDir) });
}
