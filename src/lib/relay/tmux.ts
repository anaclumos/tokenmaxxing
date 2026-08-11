// Thin tmux wrapper. Exact session names only; never pattern-kill. Injectable
// for hermetic tests that must not require a real tmux server or workers.

import { z } from "zod";

export type TmuxBackend = {
  hasSession: (input: { name: string }) => boolean;
  newSession: (input: { name: string; cwd: string; command: string }) => void;
  killSession: (input: { name: string }) => void;
  sendKeys: (input: { name: string; text: string; enter?: boolean }) => void;
  capturePane: (input: { name: string }) => string;
  listSessions: () => string[];
};

function runTmux(args: string[]): { ok: boolean; stdout: string; stderr: string; code: number } {
  const res = Bun.spawnSync(["tmux", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  return {
    ok: res.exitCode === 0,
    code: res.exitCode ?? 1,
    stdout: res.stdout.toString(),
    stderr: res.stderr.toString(),
  };
}

export const liveTmux: TmuxBackend = {
  hasSession: ({ name }) => runTmux(["has-session", "-t", name]).ok,
  newSession: ({ name, cwd, command }) => {
    const res = runTmux(["new-session", "-d", "-s", name, "-c", cwd, command]);
    if (!res.ok) throw new Error(`tmux new-session failed for ${name}: ${res.stderr.trim() || res.stdout.trim()}`);
  },
  killSession: ({ name }) => {
    // Exact name only. Missing session is success for destroy/gc idempotence.
    runTmux(["kill-session", "-t", name]);
  },
  sendKeys: ({ name, text, enter = true }) => {
    const res = runTmux(["send-keys", "-t", name, "-l", "--", text]);
    if (!res.ok) throw new Error(`tmux send-keys failed for ${name}: ${res.stderr.trim()}`);
    if (enter) {
      const enterRes = runTmux(["send-keys", "-t", name, "Enter"]);
      if (!enterRes.ok) throw new Error(`tmux send-keys Enter failed for ${name}: ${enterRes.stderr.trim()}`);
    }
  },
  capturePane: ({ name }) => {
    const res = runTmux(["capture-pane", "-p", "-t", name, "-S", "-200"]);
    if (!res.ok) return "";
    return res.stdout;
  },
  listSessions: () => {
    const res = runTmux(["list-sessions", "-F", "#{session_name}"]);
    if (!res.ok) return [];
    return res.stdout.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
  },
};

let backend: TmuxBackend = liveTmux;

export function getTmux(): TmuxBackend {
  return backend;
}

/** Test-only: replace the tmux backend. */
export function setTmuxBackend(input: { backend: TmuxBackend }): void {
  backend = input.backend;
}

export function resetTmuxBackend(): void {
  backend = liveTmux;
}

const MemorySessionSchema = z.object({
  name: z.string(),
  cwd: z.string(),
  command: stringOrEmpty(),
  keys: z.array(z.string()).default([]),
  pane: z.string().default(""),
});

function stringOrEmpty() {
  return z.string();
}

/** In-memory tmux for hermetic tests. */
export function createMemoryTmux(): TmuxBackend & { sessions: Map<string, z.infer<typeof MemorySessionSchema>> } {
  const sessions = new Map<string, z.infer<typeof MemorySessionSchema>>();
  const api: TmuxBackend & { sessions: typeof sessions } = {
    sessions,
    hasSession: ({ name }) => sessions.has(name),
    newSession: ({ name, cwd, command }) => {
      if (sessions.has(name)) throw new Error(`tmux session already exists: ${name}`);
      sessions.set(name, MemorySessionSchema.parse({ name, cwd, command, keys: [], pane: "" }));
    },
    killSession: ({ name }) => {
      sessions.delete(name);
    },
    sendKeys: ({ name, text, enter = true }) => {
      const s = sessions.get(name);
      if (!s) throw new Error(`no tmux session: ${name}`);
      s.keys.push(enter ? `${text}\n` : text);
      s.pane += enter ? `${text}\n` : text;
    },
    capturePane: ({ name }) => sessions.get(name)?.pane ?? "",
    listSessions: () => [...sessions.keys()],
  };
  return api;
}
