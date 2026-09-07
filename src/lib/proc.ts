import { errnoCode } from "./errors.ts";

export function pidStartTime(pid: number): string | null {
  const res = Bun.spawnSync(["ps", "-p", String(pid), "-o", "lstart="], { env: { ...process.env, LC_ALL: "C" } });
  if (res.exitCode !== 0) return null;
  const lstart = res.stdout.toString().trim();
  return lstart === "" ? null : lstart;
}

export function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = errnoCode(e);
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw e;
  }
}

const MARKER_POLL_MS = 150;

export async function awaitExitOrMarker(input: { child: { exited: Promise<number>; kill: () => void }; markerReady: () => boolean }): Promise<void> {
  let done = false;
  const watch = (async () => {
    while (!done) {
      if (input.markerReady()) return true;
      await Bun.sleep(MARKER_POLL_MS);
    }
    return false;
  })();
  const exited = input.child.exited.then(() => {
    done = true;
    return false;
  });
  try {
    if (await Promise.race([exited, watch])) input.child.kill();
  } catch (e) {
    input.child.kill();
    await input.child.exited;
    throw e;
  }
  await input.child.exited;
  done = true;
  await watch;
}
