import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { codexPaths, codexPool, paths } from "../lib/paths.ts";
import { withLock } from "../lib/lock.ts";
import { LOOP_DIAGNOSIS, MAX_WRAP_DEPTH, UNMANAGED_ENV, WRAP_DEPTH_ENV, WRAP_RATE_MAX, WRAP_RATE_WINDOW_MS, wrapDepth, wrapperEntryRateTripped } from "../lib/claudebin.ts";
import { resolveRealCodex } from "../lib/codexbin.ts";
import { ensureCodexStoreHome } from "../lib/codexauth.ts";
import { pickCodexSeat } from "../lib/codex.ts";
import { clearPresence, writePresence } from "../lib/presence.ts";
import { saveTermios, restoreTermios } from "../lib/tty.ts";
import { loadAccounts } from "../lib/state.ts";
import { CodexRespawnMarkerSchema } from "../lib/types.ts";
import { log } from "../lib/log.ts";

export const CODEX_SUPERVISOR_ID_ENV = "TOKENMAXXING_CODEX_SUPERVISOR_ID";

const NONINTERACTIVE_SUBCMDS = new Set([
  "exec", "review", "login", "logout", "mcp", "plugin", "mcp-server", "app-server",
  "remote-control", "app", "completion", "update", "doctor", "sandbox", "debug",
  "apply", "archive", "delete", "unarchive", "cloud", "exec-server", "features", "help",
]);

const PASSTHROUGH_FLAGS = new Set(["--version", "-V", "--help", "-h"]);

function readCodexMarker(marker: string): z.infer<typeof CodexRespawnMarkerSchema> {
  try {
    return CodexRespawnMarkerSchema.parse(JSON.parse(readFileSync(marker, "utf8")));
  } catch (e) {
    log("codexsupervisor.marker_invalid", { err: e instanceof Error ? e.message : String(e) });
    throw new Error(
      `${marker} is corrupt (unparsable JSON or off-schema) - the codex session was stopped instead of resumed on a stale target; inspect and remove the marker, then run \`codex resume\``,
    );
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

async function recordCodexPresence(child: { pid: number; exitCode: number | null; signalCode: string | null; kill: () => void; exited: Promise<unknown> }, supervisorId: string, seat: { id: string }, savedTermios: string | null): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      writePresence({ dir: codexPaths.presenceDir, id: supervisorId, accountId: seat.id, pid: child.pid });
      return;
    } catch (e) {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (attempt >= 9) {
        log("codexsupervisor.presence_failed", { err: e instanceof Error ? e.message : String(e) });
        child.kill();
        await child.exited;
        restoreTermios(savedTermios);
        throw new Error("could not write the codex presence file - refusing to run an unprotected session (its account would look like a swap target)");
      }
      await Bun.sleep(100);
    }
  }
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
  let wanted: string | null = null;
  while (true) {
    if (existsSync(marker)) rmSync(marker, { force: true });

    const launchedAt = Date.now();
    const { child } = await withLock(codexPool.lockFile, async () => {
      const picked = (wanted == null ? null : (loadAccounts(codexPool).accounts.find((a) => a.id === wanted) ?? null)) ?? pickCodexSeat(launchedAt, wanted);
      log("codexsupervisor.launch", { supervisorId: supervisorId.slice(0, 8), respawns, seat: picked?.id.slice(0, 8) ?? null, args: launchArgs.join(" ") });
      const store = picked ? ensureCodexStoreHome(picked.id) : undefined;
      const spawned = Bun.spawn([real, ...launchArgs], {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        env: {
          ...childEnv,
          [CODEX_SUPERVISOR_ID_ENV]: supervisorId,
          ...(store ? { CODEX_HOME: store } : {}),
        },
      });
      if (picked) await recordCodexPresence(spawned, supervisorId, picked, savedTermios);
      return { child: spawned, seat: picked };
    });

    let done = false;
    const markerWatch = (async () => {
      while (!done) {
        if (existsSync(marker)) {
          readCodexMarker(marker);
          return true;
        }
        await Bun.sleep(150);
      }
      return false;
    })();
    const exited = child.exited.then(() => {
      done = true;
      return "exit";
    });
    try {
      const winner = await Promise.race([exited, markerWatch.then((found) => (found ? "marker" : "exit"))]);
      if (winner === "marker") child.kill();
    } catch (e) {
      child.kill();
      throw e;
    } finally {
      await child.exited;
      done = true;
      await markerWatch.catch(() => false);
      restoreTermios(savedTermios);
    }

    const payload = existsSync(marker) ? readCodexMarker(marker) : null;
    if (payload) {
      rmSync(marker, { force: true });
      respawns++;
      const label = loadAccounts(codexPool).accounts.find((a) => a.id === payload.accountId)?.label ?? payload.accountId.slice(0, 8);
      process.stdout.write(`\n\x1b[36m↻ tokenmaxxing: switched codex to ${label} - resuming...\x1b[0m\n`);
      wanted = payload.accountId;
      launchArgs = payload.sessionId ? ["resume", payload.sessionId] : ["resume", "--last"];
      continue;
    }
    clearPresence({ dir: codexPaths.presenceDir, id: supervisorId });
    log("codexsupervisor.exit", { supervisorId: supervisorId.slice(0, 8), respawns, code: child.exitCode, signal: child.signalCode });
    return child.exitCode ?? (child.signalCode ? 1 : 0);
  }
}
