// Shared stdout contract for cheap host relay agents.

import type { ClaudePermissionMode } from "./modes.ts";

export type TurnOutput = {
  sessionId: string;
  permissionMode: ClaudePermissionMode;
  kind: "turn-done";
  text: string;
};

export type PermissionNeededOutput = {
  sessionId: string;
  permissionMode: ClaudePermissionMode;
  kind: "permission-needed";
  requestId: string;
  summary: string;
  detail: string;
};

export type RelayStdout = TurnOutput | PermissionNeededOutput;

export function formatRelayStdout(input: { payload: RelayStdout }): string {
  const p = input.payload;
  const lines = [
    `session: ${p.sessionId}`,
    `permission-mode: ${p.permissionMode}`,
  ];
  if (p.kind === "permission-needed") {
    lines.push(`permission-needed: ${p.requestId}`);
    lines.push(`summary: ${p.summary}`);
    lines.push(`detail: ${p.detail}`);
    lines.push(`session: ${p.sessionId}`);
    lines.push(`permission-mode: ${p.permissionMode}`);
  } else if (p.text.trim() !== "") {
    lines.push(p.text.replace(/\s+$/, ""));
  }
  return lines.join("\n") + "\n";
}

export function parseRelayStdout(input: { text: string }): {
  sessionId: string | null;
  permissionMode: string | null;
  requestId: string | null;
  summary: string | null;
  detail: string | null;
} {
  let sessionId: string | null = null;
  let permissionMode: string | null = null;
  let requestId: string | null = null;
  let summary: string | null = null;
  let detail: string | null = null;
  for (const line of input.text.split("\n")) {
    if (line.startsWith("session: ")) sessionId = line.slice("session: ".length).trim();
    else if (line.startsWith("permission-mode: ")) permissionMode = line.slice("permission-mode: ".length).trim();
    else if (line.startsWith("permission-needed: ")) requestId = line.slice("permission-needed: ".length).trim();
    else if (line.startsWith("summary: ")) summary = line.slice("summary: ".length);
    else if (line.startsWith("detail: ")) detail = line.slice("detail: ".length);
  }
  return { sessionId, permissionMode, requestId, summary, detail };
}
