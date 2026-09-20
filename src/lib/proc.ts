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

export function pidStartTime(pid: number): string | null {
  const res = Bun.spawnSync(["ps", "-p", String(pid), "-o", "lstart="], { env: { ...process.env, LC_ALL: "C" } });
  if (res.exitCode !== 0) return null;
  const lstart = res.stdout.toString().trim();
  return lstart === "" ? null : lstart;
}

export async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
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
