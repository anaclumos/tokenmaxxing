import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { codexPaths, paths } from "../lib/paths.ts";
import { withLock } from "../lib/lock.ts";
import { LOOP_DIAGNOSIS, MAX_WRAP_DEPTH, UNMANAGED_ENV, WRAP_DEPTH_ENV, WRAP_RATE_MAX, WRAP_RATE_WINDOW_MS, wrapDepth, wrapperEntryRateTripped } from "../lib/claudebin.ts";
import { resolveRealCodex } from "../lib/codexbin.ts";
import { clearCodexPresence, writeCodexPresence } from "../lib/codexpresence.ts";
import { liveCodexAccountId } from "../lib/codexsample.ts";
import { saveTermios, restoreTermios } from "../lib/tty.ts";
import { CodexRespawnMarkerSchema } from "../lib/types.ts";
import { log } from "../lib/log.ts";

export const CODEX_SUPERVISOR_ID_ENV = "TOKENMAXXING_CODEX_SUPERVISOR_ID";

const NONINTERACTIVE_SUBCMDS = new Set([
  "exec", "review", "login", "logout", "mcp", "plugin", "mcp-server", "app-server",
  "remote-control", "app", "completion", "update", "doctor", "sandbox", "debug",
  "apply", "archive", "delete", "unarchive", "cloud", "exec-server", "features", "help",
]);

const PASSTHROUGH_FLAGS = new Set(["--version", "-V", "--help", "-h"]);

function consumableCodexMarker(marker: string): z.infer<typeof CodexRespawnMarkerSchema> | null {
  try {
    return CodexRespawnMarkerSchema.parse(JSON.parse(readFileSync(marker, "utf8")));
  } catch (e) {
    rmSync(marker, { force: true });
    log("codexsupervisor.marker_invalid", { err: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

const VALUE_TAKING_ROOT_FLAGS = new Set([
  "-c", "--config", "-i", "--image", "-m", "--model", "--local-provider", "-p", "--profile",
  "-s", "--sandbox", "-a", "--ask-for-approval", "-C", "--cd", "--add-dir", "--enable",
]);

export function shouldManageCodex(input: { argv: string[] }): boolean {
  if (process.env.TOKENMAXXING_PROBE) return false;
  let firstPositional: string | null = null;
  for (let i = 0; i < input.argv.length; i++) {
    const arg = input.argv[i]!;
    if (PASSTHROUGH_FLAGS.has(arg)) return false;
    if (VALUE_TAKING_ROOT_FLAGS.has(arg)) {
      i++;
      continue;
    }
    if (!arg.startsWith("-") && firstPositional === null) firstPositional = arg;
  }
  return firstPositional === null || !NONINTERACTIVE_SUBCMDS.has(firstPositional);
}

export async function runCodexSupervisor(input: { argv: string[] }): Promise<number> {
  const { argv } = input;
  const depth = wrapDepth();
  if (depth >= MAX_WRAP_DEPTH) {
    console.error(
      `tokenmaxxing: ${LOOP_DIAGNOSIS} (depth ${depth}) - codexBin in ${paths.configJson} does not launch the real codex binary. Fix codexBin, then run \`tokenmaxxing doctor\`.`,
    );
    log("codexsupervisor.loop_abort", { depth });
    return 1;
  }
  if (wrapperEntryRateTripped(Date.now())) {
    console.error(
      `tokenmaxxing: ${LOOP_DIAGNOSIS} (over ${WRAP_RATE_MAX} wrapper entries in ${WRAP_RATE_WINDOW_MS / 1000}s) - codexBin in ${paths.configJson} does not launch the real codex binary. Fix codexBin, then run \`tokenmaxxing doctor\`.`,
    );
    log("codexsupervisor.rate_abort", { max: WRAP_RATE_MAX });
    return 1;
  }

  const real = resolveRealCodex();
  const childEnv = { ...process.env, [WRAP_DEPTH_ENV]: String(depth + 1) };

  if (!shouldManageCodex({ argv }) || process.env[UNMANAGED_ENV]) {
    const passthroughEnv: Record<string, string | undefined> = { ...childEnv };
    delete passthroughEnv[CODEX_SUPERVISOR_ID_ENV];
    const p = Bun.spawn([real, ...argv], { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: passthroughEnv });
    await p.exited;
    return p.exitCode ?? (p.signalCode ? 1 : 0);
  }

  const supervisorId = crypto.randomUUID();
  mkdirSync(codexPaths.respawnDir, { recursive: true });
  const marker = join(codexPaths.respawnDir, supervisorId);
  const savedTermios = saveTermios();

  process.on("SIGINT", () => {});
  process.on("SIGHUP", () => {});

  let launchArgs = argv;
  let respawns = 0;
  while (true) {
    if (existsSync(marker)) rmSync(marker, { force: true });
    log("codexsupervisor.launch", { supervisorId: supervisorId.slice(0, 8), respawns, args: launchArgs.join(" ") });

    const child = await withLock(codexPaths.lockFile, async () => {
      const spawnAccountId = liveCodexAccountId();
      const spawned = Bun.spawn([real, ...launchArgs], {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        env: { ...childEnv, [CODEX_SUPERVISOR_ID_ENV]: supervisorId },
      });
      if (spawnAccountId) {
        for (let attempt = 0; attempt < 10; attempt++) {
          try {
            writeCodexPresence({ supervisorId, accountId: spawnAccountId, pid: spawned.pid });
            break;
          } catch (e) {
            if (spawned.exitCode !== null || spawned.signalCode !== null) break;
            if (attempt === 9) {
              log("codexsupervisor.presence_failed", { err: e instanceof Error ? e.message : String(e) });
              spawned.kill();
              await spawned.exited;
              restoreTermios(savedTermios);
              throw new Error("could not write the codex presence file - refusing to run an unprotected session (its account would look like a swap target)");
            }
            await Bun.sleep(100);
          }
        }
      }
      return spawned;
    });

    let done = false;
    const markerWatch = (async () => {
      while (!done) {
        if (existsSync(marker) && consumableCodexMarker(marker) != null) return true;
        await Bun.sleep(150);
      }
      return false;
    })();
    const exited = child.exited.then(() => {
      done = true;
      return "exit";
    });
    const winner = await Promise.race([exited, markerWatch.then((found) => (found ? "marker" : "exit"))]);

    if (winner === "marker") {
      child.kill();
    }
    await child.exited;
    done = true;
    await markerWatch.catch(() => false);
    restoreTermios(savedTermios);

    const payload = existsSync(marker) ? consumableCodexMarker(marker) : null;
    if (payload) {
      rmSync(marker, { force: true });
      respawns++;
      process.stdout.write(`\n\x1b[36m↻ tokenmaxxing: switched codex to ${payload.account} - resuming...\x1b[0m\n`);
      launchArgs = payload.sessionId ? ["resume", payload.sessionId] : ["resume", "--last"];
      continue;
    }
    clearCodexPresence({ supervisorId });
    rmSync(join(codexPaths.reconcileDir, supervisorId), { force: true });
    log("codexsupervisor.exit", { supervisorId: supervisorId.slice(0, 8), respawns, code: child.exitCode, signal: child.signalCode });
    return child.exitCode ?? (child.signalCode ? 1 : 0);
  }
}
