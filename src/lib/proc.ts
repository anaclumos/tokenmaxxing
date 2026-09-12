import { ErrnoSchema } from "./types.ts";

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
    const code = ErrnoSchema.safeParse(e).data?.code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw e;
  }
}
