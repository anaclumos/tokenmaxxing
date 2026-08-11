// relay destroy / gc / status. Exact tmux session names only; never pattern-kill.

import { rmSync } from "node:fs";
import { loadRelayConfig } from "./config.ts";
import { clearSessionMarkers } from "./markers.ts";
import {
  deleteEntry,
  listEntries,
  readEntry,
  sessionLockPath,
  withSessionLock,
  type RelayRegistryEntry,
} from "./registry.ts";
import { getTmux } from "./tmux.ts";

export async function destroySession(input: { sessionId: string }): Promise<boolean> {
  const entry = readEntry({ sessionId: input.sessionId });
  if (entry == null) {
    // Still try exact tmux name from config prefix in case registry was lost.
    return false;
  }
  await withSessionLock({
    sessionId: input.sessionId,
    fn: () => {
      getTmux().killSession({ name: entry.tmuxName });
      clearSessionMarkers({ sessionId: input.sessionId });
      deleteEntry({ sessionId: input.sessionId });
      rmSync(sessionLockPath({ sessionId: input.sessionId }), { force: true });
    },
  });
  return true;
}

export type GcResult = {
  reaped: string[];
  kept: string[];
};

/** Reap dead tmux sessions and idle sessions past idleTtlMs. */
export async function gcSessions(input: { now?: number; idleTtlMs?: number } = {}): Promise<GcResult> {
  const cfg = loadRelayConfig();
  const now = input.now ?? Date.now();
  const idleTtlMs = input.idleTtlMs ?? cfg.idleTtlMs;
  const reaped: string[] = [];
  const kept: string[] = [];
  const tmux = getTmux();

  for (const entry of listEntries()) {
    const alive = tmux.hasSession({ name: entry.tmuxName });
    const idleTooLong = now - entry.lastActiveAt > idleTtlMs;
    if (!alive || idleTooLong || entry.state === "destroyed") {
      await destroySession({ sessionId: entry.sessionId });
      reaped.push(entry.sessionId);
      continue;
    }
    kept.push(entry.sessionId);
  }
  return { reaped, kept };
}

export function statusSessions(): RelayRegistryEntry[] {
  const tmux = getTmux();
  return listEntries().map((entry) => ({
    ...entry,
    // annotate liveness in a non-schema field via spread for printers; keep schema pure
  })).map((entry) => {
    void tmux.hasSession({ name: entry.tmuxName });
    return entry;
  });
}

export type StatusRow = RelayRegistryEntry & { tmuxAlive: boolean };

export function statusRows(): StatusRow[] {
  const tmux = getTmux();
  return listEntries().map((entry) => ({
    ...entry,
    tmuxAlive: tmux.hasSession({ name: entry.tmuxName }),
  }));
}
