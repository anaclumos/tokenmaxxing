import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import { piAuthJsonFor, piPaths, piStoreDirFor, type PiPool } from "./paths.ts";
import { readJsonFile } from "./state.ts";
import { ErrnoSchema } from "./types.ts";

export const PI_PROVIDER: Record<PiPool, string> = { claude: "anthropic", codex: "openai-codex" };

const PiOAuthSchema = z.looseObject({
  type: z.literal("oauth"),
  access: z.string().min(1),
  refresh: z.string().min(1),
  expires: z.number(),
  accountId: z.string().optional(),
});
export type PiOAuth = z.infer<typeof PiOAuthSchema>;

const PiAuthFileSchema = z.record(z.string(), z.unknown());

export function readPiAuthAt(input: { path: string; pool: PiPool }): PiOAuth | null {
  let file: z.infer<typeof PiAuthFileSchema>;
  try {
    file = readJsonFile(input.path, PiAuthFileSchema);
  } catch (e) {
    if (ErrnoSchema.safeParse(e).data?.code === "ENOENT") return null;
    throw e;
  }
  const entry = file[PI_PROVIDER[input.pool]];
  if (entry === undefined) return null;
  const parsed = PiOAuthSchema.safeParse(entry);
  if (!parsed.success) throw new Error(`${input.path}: the ${PI_PROVIDER[input.pool]} entry is not a pi OAuth credential`);
  return parsed.data;
}

export function readPiStore(pool: PiPool, accountId: string): PiOAuth | null {
  return readPiAuthAt({ path: piAuthJsonFor(pool, accountId), pool });
}

export function piStoreUsable(pool: PiPool, accountId: string): boolean {
  try {
    return readPiStore(pool, accountId) != null;
  } catch {
    return false;
  }
}

export function writePiStore(pool: PiPool, accountId: string, cred: PiOAuth): void {
  writeFileAtomic(piAuthJsonFor(pool, accountId), JSON.stringify({ [PI_PROVIDER[pool]]: cred }, null, 2), 0o600);
}

export function deletePiStore(pool: PiPool, accountId: string): void {
  rmSync(piStoreDirFor(pool, accountId), { recursive: true, force: true });
}

export function linkSharedPiHome(dir: string): void {
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(piPaths.home, "sessions"), { recursive: true });
  for (const name of readdirSync(piPaths.home)) {
    if (name.startsWith("auth.json")) continue;
    const link = join(dir, name);
    if (existsSync(link)) continue;
    try {
      symlinkSync(join(piPaths.home, name), link);
    } catch (e) {
      if (ErrnoSchema.safeParse(e).data?.code !== "EEXIST") throw e;
    }
  }
}

export function ensurePiStoreHome(pool: PiPool, accountId: string): string {
  const store = piStoreDirFor(pool, accountId);
  linkSharedPiHome(store);
  return store;
}
