// Ensure a durable tmux worker for a relay session. Spawns tokenmaxxing-
// supervised claude/codex via PATH shims with pooled env intact.

import { join } from "node:path";
import { paths } from "../paths.ts";
import { claudeArgvForMode, codexArgvForMode, type ClaudePermissionMode } from "./modes.ts";
import { loadRelayConfig, type RelayWorker } from "./config.ts";
import {
  createEntry,
  readEntry,
  touchEntry,
  withSessionLock,
  type RelayRegistryEntry,
} from "./registry.ts";
import { getTmux } from "./tmux.ts";
import { clearTurnDoneMarker } from "./markers.ts";

export const RELAY_SESSION_ENV = "TOKENMAXXING_RELAY_SESSION";

function shellQuote(input: { value: string }): string {
  return `'${input.value.replaceAll("'", `'\\''`)}'`;
}

export function buildWorkerCommand(input: {
  sessionId: string;
  worker: RelayWorker;
  permissionMode: ClaudePermissionMode;
  binDir?: string;
}): string {
  const binDir = input.binDir ?? paths.binDir;
  // Keep $PATH expandable: only quote the binDir segment.
  const envPrefix = `TOKENMAXXING_RELAY_SESSION=${shellQuote({ value: input.sessionId })} PATH=${shellQuote({ value: binDir })}:"$PATH"`;
  if (input.worker === "claude") {
    const modeArgs = claudeArgvForMode({ mode: input.permissionMode }).map((a) => shellQuote({ value: a })).join(" ");
    // Interactive durable session pinned to the relay UUID as Claude session id.
    return `${envPrefix} claude --session-id ${shellQuote({ value: input.sessionId })} ${modeArgs}`;
  }
  const modeArgs = codexArgvForMode({ mode: input.permissionMode }).map((a) => shellQuote({ value: a })).join(" ");
  return `${envPrefix} codex ${modeArgs}`;
}

export async function ensureSession(input: {
  sessionId?: string;
  worker?: RelayWorker;
  permissionMode?: ClaudePermissionMode;
  cwd: string;
  now?: number;
}): Promise<RelayRegistryEntry> {
  const cfg = loadRelayConfig();
  const sessionId = input.sessionId ?? crypto.randomUUID();
  const worker = input.worker ?? cfg.defaultWorker;
  const permissionMode = input.permissionMode ?? cfg.defaultPermissionMode;

  return withSessionLock({
    sessionId,
    fn: () => {
      const existing = readEntry({ sessionId });
      const tmux = getTmux();
      if (existing != null) {
        if (!tmux.hasSession({ name: existing.tmuxName })) {
          const command = buildWorkerCommand({
            sessionId,
            worker: existing.worker,
            permissionMode: input.permissionMode ?? existing.permissionMode,
          });
          tmux.newSession({ name: existing.tmuxName, cwd: existing.cwd, command });
        }
        return touchEntry({
          sessionId,
          permissionMode: input.permissionMode,
          state: "idle",
          now: input.now,
        });
      }
      const entry = createEntry({
        sessionId,
        worker,
        permissionMode,
        cwd: input.cwd,
        now: input.now,
      });
      const command = buildWorkerCommand({ sessionId, worker, permissionMode });
      tmux.newSession({ name: entry.tmuxName, cwd: input.cwd, command });
      return entry;
    },
  });
}

export async function sendPrompt(input: {
  sessionId: string;
  prompt: string;
}): Promise<void> {
  await withSessionLock({
    sessionId: input.sessionId,
    fn: () => {
      const entry = readEntry({ sessionId: input.sessionId });
      if (entry == null) throw new Error(`relay session not found: ${input.sessionId}`);
      clearTurnDoneMarker({ sessionId: input.sessionId });
      getTmux().sendKeys({ name: entry.tmuxName, text: input.prompt, enter: true });
      touchEntry({ sessionId: input.sessionId, state: "running" });
    },
  });
}

export async function setLivePermissionMode(input: {
  sessionId: string;
  permissionMode: ClaudePermissionMode;
}): Promise<RelayRegistryEntry> {
  return withSessionLock({
    sessionId: input.sessionId,
    fn: () => {
      const entry = readEntry({ sessionId: input.sessionId });
      if (entry == null) throw new Error(`relay session not found: ${input.sessionId}`);
      // Best-effort: cycle Claude's Shift+Tab equivalent via a slash command when
      // the worker is Claude. Codex needs a respawn for sandbox changes.
      if (entry.worker === "claude" && getTmux().hasSession({ name: entry.tmuxName })) {
        getTmux().sendKeys({
          name: entry.tmuxName,
          text: `/permissions ${input.permissionMode}`,
          enter: true,
        });
      } else if (entry.worker === "codex") {
        getTmux().killSession({ name: entry.tmuxName });
        const command = buildWorkerCommand({
          sessionId: input.sessionId,
          worker: "codex",
          permissionMode: input.permissionMode,
        });
        getTmux().newSession({ name: entry.tmuxName, cwd: entry.cwd, command });
      }
      return touchEntry({
        sessionId: input.sessionId,
        permissionMode: input.permissionMode,
      });
    },
  });
}

export function workerBinHint(): string {
  return join(paths.binDir, "claude");
}
