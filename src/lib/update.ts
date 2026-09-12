import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import { http } from "./http.ts";
import { isNixPackaged } from "./install.ts";
import { withLock } from "./lock.ts";
import { log } from "./log.ts";
import { HOME, paths } from "./paths.ts";

const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const LATEST_URL = "https://registry.npmjs.org/tokenmaxxing/latest";

const DirOverrideSchema = z.string().min(1).optional().catch(undefined);
const AttemptSchema = z.object({ attemptedAt: z.number() });
const VersionSchema = z.object({ version: z.string().min(1) });

const updateJson = join(paths.home, "update.json");
const updateLock = join(paths.home, "update.lock");

function bunGlobalRoot(): string {
  const globalDir = DirOverrideSchema.parse(process.env.BUN_INSTALL_GLOBAL_DIR);
  if (globalDir != null) return globalDir;
  return join(DirOverrideSchema.parse(process.env.BUN_INSTALL) ?? join(HOME, ".bun"), "install", "global");
}

function installedPackageDir(): string {
  return join(bunGlobalRoot(), "node_modules", "tokenmaxxing");
}

function realOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

export function detectInstallKind(): "bun-global" | "nix" | "other" {
  if (isNixPackaged()) return "nix";
  const entry = realOrNull(Bun.main);
  return entry != null && entry === realOrNull(join(installedPackageDir(), "src", "main.ts")) ? "bun-global" : "other";
}

function installedVersion(): string {
  const file = join(installedPackageDir(), "package.json");
  return VersionSchema.parse(JSON.parse(readFileSync(file, "utf8"))).version;
}

function isDue(now: number): boolean {
  if (!existsSync(updateJson)) return true;
  const attempt = AttemptSchema.parse(JSON.parse(readFileSync(updateJson, "utf8")));
  return now - attempt.attemptedAt >= UPDATE_INTERVAL_MS;
}

async function updateToLatest(): Promise<void> {
  const current = installedVersion();
  const response = await http.get(LATEST_URL);
  if (!response.ok) throw new Error(`${LATEST_URL} answered HTTP ${response.status}`);
  const latest = VersionSchema.parse(await response.json()).version;
  if (Bun.semver.order(latest, current) <= 0) return;
  const child = Bun.spawn([process.execPath, "add", "-g", `tokenmaxxing@${latest}`], { stdout: "ignore", stderr: "pipe" });
  const stderr = await new Response(child.stderr).text();
  const code = await child.exited;
  if (code !== 0) throw new Error(`bun add -g tokenmaxxing@${latest} exited ${code}: ${stderr.trim().slice(0, 240)}`);
  const installed = installedVersion();
  if (installed !== latest) throw new Error(`bun add -g tokenmaxxing@${latest} left ${installed} installed`);
  log("update.done", { from: current, to: latest });
}

export async function maybeAutoUpdate(): Promise<void> {
  if (detectInstallKind() !== "bun-global") return;
  await withLock(updateLock, async () => {
    const now = Date.now();
    if (!isDue(now)) return;
    writeFileAtomic(updateJson, JSON.stringify({ attemptedAt: now }) + "\n");
    try {
      await updateToLatest();
    } catch (e) {
      throw new Error(`self-update from npm failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
}
