import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { delay } from "es-toolkit";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import { http } from "./http.ts";
import { isNixPackaged } from "./install.ts";
import { withLock } from "./lock.ts";
import { log } from "./log.ts";
import { HOME, paths } from "./paths.ts";

const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const INSTALL_DEADLINE_MS = 60_000;
const LATEST_URL = "https://registry.npmjs.org/tokenmaxxing/latest";

const DirOverrideSchema = z.string().min(1).optional().catch(undefined);
const AttemptSchema = z.object({ attemptedAt: z.number() });
const VersionSchema = z.object({ version: z.string().min(1) });

const updateJson = join(paths.home, "update.json");
const updateLock = join(paths.home, "update.lock");

function realOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function globalRootCandidates(): string[] {
  const globalDir = DirOverrideSchema.parse(process.env.BUN_INSTALL_GLOBAL_DIR);
  const bunInstall = DirOverrideSchema.parse(process.env.BUN_INSTALL);
  return [
    ...(globalDir != null ? [globalDir] : []),
    ...(bunInstall != null ? [join(bunInstall, "install", "global")] : []),
    join(dirname(dirname(process.execPath)), "install", "global"),
    join(HOME, ".bun", "install", "global"),
  ];
}

function packageDir(root: string): string {
  return join(root, "node_modules", "tokenmaxxing");
}

function detectGlobalRoot(): string | null {
  if (isNixPackaged()) return null;
  const entry = realOrNull(Bun.main);
  if (entry == null) return null;
  return globalRootCandidates().find((root) => entry === realOrNull(join(packageDir(root), "src", "main.ts"))) ?? null;
}

function installedVersion(root: string): string {
  return VersionSchema.parse(JSON.parse(readFileSync(join(packageDir(root), "package.json"), "utf8"))).version;
}

function isDue(now: number): boolean {
  if (!existsSync(updateJson)) return true;
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(updateJson, "utf8"));
  } catch {
    throw new Error(`${updateJson} is corrupt (unparsable JSON) - repair or remove the file`);
  }
  return now - AttemptSchema.parse(json).attemptedAt >= UPDATE_INTERVAL_MS;
}

async function updateToLatest(root: string): Promise<void> {
  const current = installedVersion(root);
  const response = await http.get(LATEST_URL);
  if (!response.ok) throw new Error(`${LATEST_URL} answered HTTP ${response.status}`);
  const latest = VersionSchema.parse(await response.json()).version;
  if (Bun.semver.order(latest, current) <= 0) return;
  const child = Bun.spawn([process.execPath, "add", "-g", `tokenmaxxing@${latest}`], {
    cwd: paths.home,
    env: { ...process.env, BUN_INSTALL_GLOBAL_DIR: root },
    stdout: "ignore",
    stderr: "pipe",
    timeout: INSTALL_DEADLINE_MS,
    killSignal: "SIGKILL",
  });
  const stderrText = new Response(child.stderr).text();
  await child.exited;
  const stderr = await Promise.race([stderrText, delay(1_000).then(() => "")]);
  if (child.exitCode !== 0) throw new Error(`bun add -g tokenmaxxing@${latest} exited ${child.signalCode ?? child.exitCode}: ${stderr.trim().slice(0, 240)}`);
  const installed = installedVersion(root);
  if (installed !== latest) throw new Error(`bun add -g tokenmaxxing@${latest} left ${installed} installed`);
  log("update.done", { from: current, to: latest });
}

export async function maybeAutoUpdate(): Promise<void> {
  const root = detectGlobalRoot();
  if (root == null) return;
  await withLock(updateLock, async () => {
    const now = Date.now();
    if (!isDue(now)) return;
    writeFileAtomic(updateJson, JSON.stringify({ attemptedAt: now }) + "\n");
    try {
      await updateToLatest(root);
    } catch (e) {
      throw new Error(`self-update from npm failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
}
