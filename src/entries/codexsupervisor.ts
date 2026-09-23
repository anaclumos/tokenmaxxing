import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { codexPaths, codexPool } from "../lib/paths.ts";
import { withLock } from "../lib/lock.ts";
import { CODEX_BIN, UNMANAGED_ENV, WRAP_DEPTH_ENV, resolveRealBin, wrapDepth } from "../lib/claudebin.ts";
import { codexStoreUsable, ensureCodexStoreHome } from "../lib/codexauth.ts";
import { codexPickCtx, pickCodexSeat } from "../lib/codex.ts";
import { clearPresence, livingPresences } from "../lib/presence.ts";
import { isExhausted } from "../lib/picker.ts";
import { exitStatus, loopGuardTripped, raceMarkerOrExit, recordPresenceOrStop, runPassthrough } from "../lib/supervise.ts";
import { saveTermios } from "../lib/tty.ts";
import { loadAccounts, readJsonFile } from "../lib/state.ts";
import { CodexRespawnMarkerSchema, type Account } from "../lib/types.ts";
import { errorMessage, log } from "../lib/log.ts";

export const CODEX_SUPERVISOR_ID_ENV = "TOKENMAXXING_CODEX_SUPERVISOR_ID";

const NONINTERACTIVE_SUBCMDS = new Set([
  "exec", "review", "login", "logout", "mcp", "plugin", "mcp-server", "app-server",
  "remote-control", "app", "completion", "update", "doctor", "sandbox", "debug",
  "apply", "archive", "delete", "unarchive", "cloud", "exec-server", "features", "help",
]);

const PASSTHROUGH_FLAGS = new Set(["--version", "-V", "--help", "-h"]);

function readCodexMarker(marker: string): z.infer<typeof CodexRespawnMarkerSchema> {
  try {
    return readJsonFile(marker, CodexRespawnMarkerSchema);
  } catch (e) {
    log("codexsupervisor.marker_invalid", { err: errorMessage(e) });
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

function validWanted(input: { wanted: string | null; now: number; supervisorId: string }): Account | null {
  if (input.wanted == null) return null;
  const a = loadAccounts(codexPool).accounts.find((x) => x.id === input.wanted);
  if (!a || a.needsReauth === true) return null;
  if (isExhausted(a, codexPickCtx(input.now, input.wanted))) return null;
  if (!codexStoreUsable(a.id)) return null;
  const foreign = livingPresences(codexPaths.presenceDir).some((p) => p.accountId === a.id && p.id !== input.supervisorId);
  if (foreign) {
    log("codexsupervisor.wanted_present", { account: a.id.slice(0, 8) });
    return null;
  }
  return a;
}

export async function runCodexSupervisor(input: { argv: string[] }): Promise<number> {
  const { argv } = input;
  if (loopGuardTripped("codex")) return 1;

  const real = resolveRealBin(CODEX_BIN);
  const childEnv = { ...process.env, [WRAP_DEPTH_ENV]: String(wrapDepth() + 1) };

  if (!shouldManageCodex({ argv }) || process.env[UNMANAGED_ENV]) {
    const passthroughEnv: Record<string, string | undefined> = { ...childEnv };
    delete passthroughEnv[CODEX_SUPERVISOR_ID_ENV];
    return runPassthrough({ real, argv, env: passthroughEnv });
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
    const { child, seat } = await withLock(codexPool.lockFile, async () => {
      clearPresence({ dir: codexPaths.presenceDir, id: supervisorId });
      const picked = validWanted({ wanted, now: launchedAt, supervisorId }) ?? pickCodexSeat(launchedAt);
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
      if (picked) {
        await recordPresenceOrStop({
          child: spawned,
          dir: codexPaths.presenceDir,
          id: supervisorId,
          accountId: picked.id,
          event: "codexsupervisor.presence_failed",
          message: "could not write the codex presence file - refusing to run an unprotected session (its account would look like a swap target)",
          savedTermios,
        });
      }
      return { child: spawned, seat: picked };
    });
    if (respawns > 0) {
      process.stdout.write(`\n\x1b[36m↻ tokenmaxxing: switched codex to ${seat?.label ?? "the ambient codex login"} - resuming...\x1b[0m\n`);
    }

    await raceMarkerOrExit({
      child,
      tick: () => {
        if (!existsSync(marker)) return false;
        readCodexMarker(marker);
        return true;
      },
      savedTermios,
    });

    const payload = existsSync(marker) ? readCodexMarker(marker) : null;
    if (payload) {
      rmSync(marker, { force: true });
      respawns++;
      wanted = payload.accountId;
      launchArgs = payload.sessionId ? ["resume", payload.sessionId] : ["resume", "--last"];
      continue;
    }
    clearPresence({ dir: codexPaths.presenceDir, id: supervisorId });
    log("codexsupervisor.exit", { supervisorId: supervisorId.slice(0, 8), respawns, code: child.exitCode, signal: child.signalCode });
    return exitStatus(child);
  }
}
