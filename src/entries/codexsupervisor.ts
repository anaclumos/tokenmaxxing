// The `codex` supervisor. Invoked in place of codex (via ~/.config/tokenmaxxing/
// bin/codex on PATH). Codex REQUIRES a restart to change accounts: a running
// process refuses an auth.json swap to a different account (verified
// rust-v0.144.5 reload_if_account_id_matches), so unlike the claude supervisor
// (whose child hot-adopts swaps) this respawn IS the switch mechanism, not just
// UX. The codex Stop hook performs the swap at an idle turn boundary and drops
// a marker keyed by THIS supervisor's id (passed down via env, so N concurrent
// sessions pair correctly); the supervisor then SIGTERMs its child and
// relaunches `codex resume <session-id>` on the freshly-installed account.

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { codexPaths, paths } from "../lib/paths.ts";
import { withLock } from "../lib/lock.ts";
import { LOOP_DIAGNOSIS, MAX_WRAP_DEPTH, WRAP_DEPTH_ENV, WRAP_RATE_MAX, WRAP_RATE_WINDOW_MS, wrapDepth, wrapperEntryRateTripped } from "../lib/claudebin.ts";
import { resolveRealCodex } from "../lib/codexbin.ts";
import { clearCodexPresence, writeCodexPresence } from "../lib/codexpresence.ts";
import { liveCodexAccountId } from "../lib/codexsample.ts";
import { saveTermios, restoreTermios } from "../lib/tty.ts";
import { CodexRespawnMarkerSchema } from "../lib/types.ts";
import { log } from "../lib/log.ts";

export const CODEX_SUPERVISOR_ID_ENV = "TOKENMAXXING_CODEX_SUPERVISOR_ID";

/** Subcommands that never host an interactive session worth managing. */
const NONINTERACTIVE_SUBCMDS = new Set([
  "exec", "review", "login", "logout", "mcp", "plugin", "mcp-server", "app-server",
  "remote-control", "app", "completion", "update", "doctor", "sandbox", "debug",
  "apply", "archive", "delete", "unarchive", "cloud", "exec-server", "features", "help",
]);

const PASSTHROUGH_FLAGS = new Set(["--version", "-V", "--help", "-h"]);

/** Root options that consume the NEXT token as their value (verified against
 *  `codex --help` 0.144.4): without skipping them, `codex -m gpt exec ...`
 *  would read "gpt" as the subcommand and wrongly supervise an exec run. */
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

/** Entry point: `codex ...args` through the on-PATH shim. */
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

  if (!shouldManageCodex({ argv })) {
    // STRIP the supervisor pairing env from unmanaged spawns: a nested codex
    // launched from inside a supervised session (e.g. its agent running
    // `codex exec ...`) would otherwise inherit the OUTER session's id, and
    // its global Stop hook could then write a respawn marker that SIGTERMs
    // the outer session MID-TURN and resumes it onto the nested transcript
    // (closing-review catch). A managed nested launch is already safe - it
    // exports its own fresh id below; only a shim-bypassed absolute-path
    // nested launch keeps the inherited env, the same accepted gap as
    // claude's bg-daemon bypass.
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

  // On respawn the ONLY reliable relaunch is `codex resume <session-id>`:
  // codex generates its own session ids (there is no flag to pin one at
  // launch), so original launch args are used verbatim only for the first
  // spawn. Model/sandbox preferences persist in config.toml either way.
  let launchArgs = argv;
  let respawns = 0;
  while (true) {
    if (existsSync(marker)) rmSync(marker, { force: true });
    log("codexsupervisor.launch", { supervisorId: supervisorId.slice(0, 8), respawns, args: launchArgs.join(" ") });

    // Declare which account THIS session runs on (the live identity at spawn):
    // the picker must never target it and the sampler must never rotate its
    // parked token while the session lives. Rewritten every respawn (the swap
    // changed the live identity); cleared on exit; PID-validated by readers.
    // Read + presence-write + spawn run under the codex FLOCK (closing-review
    // catch): unlocked, a swap could land between the read and the child's
    // auth.json read, seating the child on the NEW account while presence
    // named the old one for the session's whole life - un-benching the
    // running account for samplers and the picker. Under the flock no swap
    // can interleave until after the spawn; the residual window (child
    // startup vs a swap acquiring the lock immediately after) is sub-ms in
    // practice against a swap's network-bound critical section.
    const child = await withLock(codexPaths.lockFile, async () => {
      const spawnAccountId = liveCodexAccountId();
      if (spawnAccountId) writeCodexPresence({ supervisorId, accountId: spawnAccountId });
      return Bun.spawn([real, ...launchArgs], {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        env: { ...childEnv, [CODEX_SUPERVISOR_ID_ENV]: supervisorId },
      });
    });

    let done = false;
    const markerWatch = (async () => {
      while (!done) {
        if (await Bun.file(marker).exists()) return true;
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
      child.kill(); // SIGTERM at the committed turn boundary the Stop hook chose
    }
    await child.exited;
    done = true;
    await markerWatch.catch(() => false);
    restoreTermios(savedTermios);

    if (existsSync(marker)) {
      const payload = CodexRespawnMarkerSchema.parse(await Bun.file(marker).json());
      rmSync(marker, { force: true });
      respawns++;
      process.stdout.write(`\n\x1b[36m↻ tokenmaxxing: switched codex to ${payload.account} - resuming...\x1b[0m\n`);
      launchArgs = payload.sessionId ? ["resume", payload.sessionId] : ["resume", "--last"];
      continue;
    }
    clearCodexPresence({ supervisorId });
    // a reconcile signal addressed to this now-gone session is moot; the
    // deciding actor's sweep would gc it eventually, this is just prompt.
    rmSync(join(codexPaths.reconcileDir, supervisorId), { force: true });
    log("codexsupervisor.exit", { supervisorId: supervisorId.slice(0, 8), respawns, code: child.exitCode, signal: child.signalCode });
    return child.exitCode ?? (child.signalCode ? 1 : 0);
  }
}
