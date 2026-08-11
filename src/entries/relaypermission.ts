// PermissionRequest hook for relay workers. When TOKENMAXXING_RELAY_SESSION is
// set, park on a pending marker until `relay decide` writes a decision, then
// return allow/deny. Under bypassPermissions (or when pings are disabled),
// auto-allow without surfacing. Never blocks non-relay sessions. Always exits 0
// with a JSON decision body Claude understands.

import { delay } from "es-toolkit";
import { z } from "zod";
import { loadRelayConfig } from "../lib/relay/config.ts";
import {
  clearDecision,
  readDecision,
  writePendingRequest,
} from "../lib/relay/markers.ts";
import { permissionPingsEnabled } from "../lib/relay/modes.ts";
import { readEntry, registryHas } from "../lib/relay/registry.ts";
import { RELAY_SESSION_ENV } from "../lib/relay/worker.ts";
import { log } from "../lib/log.ts";

const StdinSchema = z.looseObject({
  tool_name: z.string().optional(),
  tool_input: z.unknown().optional(),
  request_id: z.string().optional(),
  permission_suggestions: z.unknown().optional(),
});

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const c of Bun.stdin.stream()) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

function allow(): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
}

function deny(): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny" } } });
}

function fallbackAllow(): string {
  // Unknown Claude envelope shapes: fail open for non-relay; for relay we still
  // prefer an explicit decision. Default allow keeps the worker unblocked if
  // the host never answers within timeout only after we already tried.
  return allow();
}

export async function handleRelayPermission(input: { rawStdin: string }): Promise<string> {
  if (process.env.TOKENMAXXING_PROBE) return allow();

  const sessionId = process.env[RELAY_SESSION_ENV];
  if (sessionId == null || sessionId === "") return allow();
  if (!registryHas({ sessionId })) return allow();

  const entry = readEntry({ sessionId });
  if (entry != null && !permissionPingsEnabled({ mode: entry.permissionMode })) {
    return allow();
  }

  const parsed = StdinSchema.safeParse((() => {
    try {
      return JSON.parse(input.rawStdin);
    } catch {
      return {};
    }
  })());
  const requestId = parsed.success && parsed.data.request_id
    ? parsed.data.request_id
    : crypto.randomUUID();
  const toolName = parsed.success ? (parsed.data.tool_name ?? "tool") : "tool";
  const detail = parsed.success
    ? JSON.stringify(parsed.data.tool_input ?? parsed.data).slice(0, 500)
    : input.rawStdin.slice(0, 500);

  writePendingRequest({
    sessionId,
    requestId,
    summary: `Permission needed: ${toolName}`,
    detail,
  });

  const cfg = loadRelayConfig();
  const deadline = Date.now() + cfg.decideTimeoutMs;
  while (Date.now() < deadline) {
    const decision = readDecision({ sessionId, requestId });
    if (decision != null) {
      clearDecision({ sessionId, requestId });
      return decision.approve ? allow() : deny();
    }
    await delay(50);
  }
  log("relay.permission_timeout", { session: sessionId.slice(0, 8), requestId: requestId.slice(0, 8) });
  return deny();
}

export async function runRelayPermissionHook(): Promise<number> {
  try {
    const out = await handleRelayPermission({ rawStdin: await readStdin() });
    process.stdout.write(out);
  } catch (e) {
    log("relay.permission_error", { err: e instanceof Error ? e.message : String(e) });
    process.stdout.write(fallbackAllow());
  }
  return 0;
}
