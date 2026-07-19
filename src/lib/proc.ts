// Process identity beyond a bare PID: pids recycle, so anything that must act
// on "the process I recorded earlier" (reaping an orphan, trusting a presence
// file) pins pid + start time and treats a mismatch as a different process.

/** The ps lstart token for a pid, or null when no such process. pid + start
 *  time is the standard process identity: equality with the token captured
 *  at spawn proves this is still the SAME process, never a recycled pid.
 *  LC_ALL=C pins the lstart rendering (cubic review catch): the capturing and
 *  the comparing process can run under different locales (terminal vs
 *  launchd), and a formatting mismatch would silently break the identity. */
export function pidStartTime(pid: number): string | null {
  const res = Bun.spawnSync(["ps", "-p", String(pid), "-o", "lstart="], { env: { ...process.env, LC_ALL: "C" } });
  if (res.exitCode !== 0) return null;
  const lstart = res.stdout.toString().trim();
  return lstart === "" ? null : lstart;
}
