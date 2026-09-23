import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import { realpathOrNull } from "./claudebin.ts";
import { http } from "./http.ts";
import { isNixPackaged } from "./install.ts";
import { withLock } from "./lock.ts";
import { errorMessage, log } from "./log.ts";
import { env, HOME, optionalEnv, paths } from "./paths.ts";

const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const INSTALL_DEADLINE_MS = 60_000;
const REGISTRY_DEADLINE_MS = 15_000;

const AttemptSchema = z.object({ attemptedAt: z.number() });
const VersionSchema = z.object({ version: z.string().min(1) });
const LatestSchema = z.object({ version: z.string().min(1), engines: z.looseObject({ bun: z.string().min(1).optional() }).optional() });

const updateJson = join(paths.home, "update.json");
const updateLock = join(paths.home, "update.lock");

function registry(): { base: URL; authorization: string | null } {
  const raw = env("TOKENMAXXING_NPM_REGISTRY", "https://registry.npmjs.org");
  const base = new URL(raw.endsWith("/") ? raw : `${raw}/`);
  const authorization =
    base.username !== "" || base.password !== "" ? `Basic ${btoa(`${decodeURIComponent(base.username)}:${decodeURIComponent(base.password)}`)}` : null;
  base.username = "";
  base.password = "";
  return { base, authorization };
}

function globalRootCandidates(): string[] {
  const globalDir = optionalEnv("BUN_INSTALL_GLOBAL_DIR");
  const bunInstall = optionalEnv("BUN_INSTALL");
  return [
    ...(globalDir != null ? [globalDir] : []),
    ...(bunInstall != null ? [join(bunInstall, "install", "global")] : []),
    join(dirname(dirname(process.execPath)), "install", "global"),
    join(HOME, ".bun", "install", "global"),
  ].map((candidate) => resolve(candidate));
}

function packageDir(root: string): string {
  return join(root, "node_modules", "tokenmaxxing");
}

function registryPackageDir(root: string): string | null {
  const dir = packageDir(root);
  try {
    return lstatSync(dir).isSymbolicLink() ? null : dir;
  } catch {
    return null;
  }
}

function detectGlobalRoot(): string | null {
  if (isNixPackaged()) return null;
  const entry = realpathOrNull(Bun.main);
  if (entry == null) return null;
  return (
    globalRootCandidates().find((root) => {
      const dir = registryPackageDir(root);
      return dir != null && entry === realpathOrNull(join(dir, "src", "main.ts"));
    }) ?? null
  );
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
  const { base, authorization } = registry();
  const latestUrl = new URL("tokenmaxxing/latest", base).href;
  const signal = AbortSignal.timeout(REGISTRY_DEADLINE_MS);
  const response = await http.get(latestUrl, { signal, headers: authorization ? { authorization } : undefined });
  if (!response.ok) throw new Error(`${latestUrl} answered HTTP ${response.status}`);
  const latest = LatestSchema.parse(await response.json());
  if (Bun.semver.order(latest.version, current) <= 0) return;
  const floor = latest.engines?.bun;
  if (floor != null && !Bun.semver.satisfies(Bun.version, floor)) {
    throw new Error(`tokenmaxxing@${latest.version} needs bun ${floor}, this is bun ${Bun.version}`);
  }
  const child = Bun.spawn([process.execPath, "add", "-g", "--registry", base.href, `tokenmaxxing@${latest.version}`], {
    cwd: paths.home,
    env: { ...process.env, BUN_INSTALL_GLOBAL_DIR: root },
    stdout: "ignore",
    stderr: "inherit",
    timeout: INSTALL_DEADLINE_MS,
    killSignal: "SIGKILL",
  });
  await child.exited;
  if (child.exitCode !== 0) throw new Error(`bun add -g tokenmaxxing@${latest.version} exited ${child.signalCode ?? child.exitCode}`);
  const installed = installedVersion(root);
  if (installed !== latest.version) throw new Error(`bun add -g tokenmaxxing@${latest.version} left ${installed} installed`);
  log("update.done", { from: current, to: latest.version });
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
      throw new Error(`self-update from npm failed: ${errorMessage(e)}`);
    }
  });
}
