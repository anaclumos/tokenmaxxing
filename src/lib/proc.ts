// Process identity beyond a bare PID: pids recycle, so anything that must act
// on "the process I recorded earlier" (reaping an orphan, trusting a presence
// file) pins pid + start time and treats a mismatch as a different process.

import { z } from "zod";

/** The ps lstart token for a pid, or null when no such process. pid + start
 *  time is the standard process identity: equality with the token captured
 *  at spawn proves this is still the SAME process, never a recycled pid.
 *  LC_ALL=C pins the lstart rendering (cubic review catch): the capturing and
 *  the comparing process can run under different locales (terminal vs
 *  launchd), and a formatting mismatch would silently break the identity.
 *  Tradeoff (flagged and accepted): lstart has one-second resolution, so a
 *  pid recycled onto a process started within the SAME wall-clock second
 *  would pass - landing on the exact pid AND second is vanishingly unlikely,
 *  and finer start-time sources are per-platform native calls ps cannot give. */
export function pidStartTime(pid: number): string | null {
  const res = Bun.spawnSync(["ps", "-p", String(pid), "-o", "lstart="], { env: { ...process.env, LC_ALL: "C" } });
  if (res.exitCode !== 0) return null;
  const lstart = res.stdout.toString().trim();
  return lstart === "" ? null : lstart;
}

/** Whether the pid names a LIVE process (signal-0 probe); EPERM still proves
 *  existence. Distinguishes "pid is dead" from "ps could not answer", which a
 *  null pidStartTime alone cannot. */
export function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const errno = z.object({ code: z.string() }).safeParse(e);
    if (errno.success && errno.data.code === "ESRCH") return false;
    if (errno.success && errno.data.code === "EPERM") return true;
    throw e;
  }
}
