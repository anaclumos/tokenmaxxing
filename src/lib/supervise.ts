import type { Subprocess } from "bun";
import { LOOP_DIAGNOSIS, MAX_WRAP_DEPTH, WRAP_RATE_MAX, WRAP_RATE_WINDOW_MS, wrapDepth, wrapperEntryRateTripped } from "./claudebin.ts";
import { errorMessage, log } from "./log.ts";
import { paths } from "./paths.ts";
import { writePresence } from "./presence.ts";
import { restoreTermios } from "./tty.ts";

export type WrappedProduct = "claude" | "codex";

type ChildHandle = {
  pid: number;
  exitCode: number | null;
  signalCode: string | null;
  kill: () => void;
  exited: Promise<unknown>;
};

const WRAPPED: Record<WrappedProduct, { setting: string; binary: string; events: string }> = {
  claude: { setting: "claudeBin", binary: "Claude", events: "supervisor" },
  codex: { setting: "codexBin", binary: "codex", events: "codexsupervisor" },
};

export function exitStatus(child: { exitCode: number | null; signalCode: string | null }): number {
  return child.exitCode ?? (child.signalCode ? 1 : 0);
}

export function loopGuardTripped(product: WrappedProduct): boolean {
  const { setting, binary, events } = WRAPPED[product];
  const depth = wrapDepth();
  if (depth >= MAX_WRAP_DEPTH) {
    console.error(
      `tokenmaxxing: ${LOOP_DIAGNOSIS} (depth ${depth}) - ${setting} in ${paths.configJson} does not launch the real ${binary} binary. Fix ${setting}, then run \`tokenmaxxing doctor\`.`,
    );
    log(`${events}.loop_abort`, { depth });
    return true;
  }
  if (wrapperEntryRateTripped(Date.now())) {
    console.error(
      `tokenmaxxing: ${LOOP_DIAGNOSIS} (over ${WRAP_RATE_MAX} wrapper entries in ${WRAP_RATE_WINDOW_MS / 1000}s) - ${setting} in ${paths.configJson} does not launch the real ${binary} binary. Fix ${setting}, then run \`tokenmaxxing doctor\`.`,
    );
    log(`${events}.rate_abort`, { max: WRAP_RATE_MAX });
    return true;
  }
  return false;
}

export async function runPassthrough(input: { real: string; argv: string[]; env: Record<string, string | undefined>; onSpawn?: (child: Subprocess) => void }): Promise<number> {
  const p = Bun.spawn([input.real, ...input.argv], { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: input.env });
  input.onSpawn?.(p);
  await p.exited;
  return exitStatus(p);
}

export async function recordPresenceOrStop(input: { child: ChildHandle; dir: string; id: string; accountId: string; event: string; message: string; savedTermios: string | null }): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      writePresence({ dir: input.dir, id: input.id, accountId: input.accountId, pid: input.child.pid });
      return;
    } catch (e) {
      if (input.child.exitCode !== null || input.child.signalCode !== null) return;
      if (attempt >= 9) {
        log(input.event, { err: errorMessage(e) });
        input.child.kill();
        await input.child.exited;
        restoreTermios(input.savedTermios);
        throw new Error(input.message);
      }
      await Bun.sleep(100);
    }
  }
}

export async function raceMarkerOrExit(input: {
  child: { exited: Promise<unknown>; kill: () => void };
  tick: () => boolean | Promise<boolean>;
  savedTermios: string | null;
  onKill?: () => void;
  onError?: () => void;
  onExited?: () => void;
}): Promise<void> {
  let done = false;
  const markerWatch = (async () => {
    while (!done) {
      if (await input.tick()) return true;
      await Bun.sleep(150);
    }
    return false;
  })();
  const exited = input.child.exited.then(() => {
    done = true;
    return "exit" as const;
  });
  try {
    const winner = await Promise.race([exited, markerWatch.then((found) => (found ? "marker" : "exit"))]);
    if (winner === "marker") {
      input.onKill?.();
      input.child.kill();
    }
  } catch (e) {
    input.onKill?.();
    input.child.kill();
    input.onError?.();
    throw e;
  } finally {
    await input.child.exited;
    input.onExited?.();
    done = true;
    await markerWatch.catch(() => false);
    restoreTermios(input.savedTermios);
  }
}
