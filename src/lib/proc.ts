import { basename } from "node:path";
import { ErrnoSchema } from "./types.ts";

const SHELLS = new Set(["sh", "bash", "dash", "zsh", "ksh", "fish"]);
const MAX_SHELL_HOPS = 4;

function parentAndName(pid: number): { ppid: number; comm: string } | null {
  const res = Bun.spawnSync(["ps", "-p", String(pid), "-o", "ppid=", "-o", "comm="], { env: { ...process.env, LC_ALL: "C" } });
  if (res.exitCode !== 0) return null;
  const row = res.stdout.toString().trim();
  const cut = row.indexOf(" ");
  if (cut === -1) return null;
  const ppid = Number(row.slice(0, cut));
  return Number.isInteger(ppid) ? { ppid, comm: row.slice(cut).trim() } : null;
}

export function spawnedThroughShellsBy(ancestor: number): boolean {
  let cur = process.ppid;
  for (let hop = 0; hop <= MAX_SHELL_HOPS; hop++) {
    if (cur === ancestor) return true;
    const proc = parentAndName(cur);
    if (proc == null || !SHELLS.has(basename(proc.comm))) return false;
    cur = proc.ppid;
  }
  return false;
}

export function ancestorPids(): number[] {
  const res = Bun.spawnSync(["ps", "-A", "-o", "pid=", "-o", "ppid="], { env: { ...process.env, LC_ALL: "C" } });
  if (res.exitCode !== 0) throw new Error(`ps -A exited ${res.exitCode}: ${res.stderr.toString().trim()}`);
  const parent = new Map<number, number>();
  for (const row of res.stdout.toString().split("\n")) {
    const [pid, ppid] = row.split(" ").filter(Boolean).map(Number);
    if (pid !== undefined && ppid !== undefined) parent.set(pid, ppid);
  }
  const out: number[] = [];
  for (let pid = process.ppid; pid > 1; pid = parent.get(pid) ?? 0) out.push(pid);
  return out;
}

export function pidStartTimes(pids: number[]): Map<number, string> {
  const started = new Map<number, string>();
  if (pids.length === 0) return started;
  const res = Bun.spawnSync(["ps", "-p", pids.join(","), "-o", "pid=", "-o", "lstart="], { env: { ...process.env, LC_ALL: "C" } });
  if (res.exitCode !== 0) return started;
  for (const row of res.stdout.toString().split("\n")) {
    const line = row.trim();
    const cut = line.indexOf(" ");
    if (cut !== -1) started.set(Number(line.slice(0, cut)), line.slice(cut).trim());
  }
  return started;
}

export async function readStdin(): Promise<string> {
  return Buffer.from(await Bun.stdin.bytes()).toString("utf8");
}

export async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true });
    let nl = pending.indexOf("\n");
    while (nl !== -1) {
      yield pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      nl = pending.indexOf("\n");
    }
  }
  pending += decoder.decode();
  if (pending.length > 0) yield pending;
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
