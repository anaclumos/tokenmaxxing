// Save/restore the controlling terminal's line settings around a child that owns
// the tty via inherited stdio. If we SIGTERM such a child (supervisor respawn, or
// `add` auto-exit), the terminal can be left in raw mode; restoring stty fixes it.

export function saveTermios(): string | null {
  const p = Bun.spawnSync(["/bin/sh", "-c", "stty -g </dev/tty"]);
  const s = p.stdout?.toString().trim();
  return s && p.exitCode === 0 ? s : null;
}

export function restoreTermios(saved: string | null): void {
  const cmd = saved ? `stty ${saved} </dev/tty` : "stty sane </dev/tty";
  Bun.spawnSync(["/bin/sh", "-c", cmd], { stdout: "ignore", stderr: "ignore" });
}
