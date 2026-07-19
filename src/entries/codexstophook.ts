// Codex Stop hook (installed in ~/.codex/hooks.json by `init --codex`). Fires
// when codex finishes a turn: the transcript is committed and the process is
// idle, the one boundary where killing it loses nothing. If the decision swaps
// accounts and this session runs under the codex supervisor, drop a respawn
// marker keyed by the supervisor's id; the supervisor SIGTERMs codex and
// relaunches `codex resume <session-id>` on the new account (a running codex
// never adopts a different account's credential: restart IS the switch).
//
// Contract with codex (verified against the 0.144.4 binary + hooks reference):
// stdin carries session_id, stdout `{}` on exit 0 is the documented no-op, and
// a hook failure must never block the stop - errors are logged, not thrown.

import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { z } from "zod";
import { codexPaths } from "../lib/paths.ts";
import { writeFileAtomic } from "../lib/atomic.ts";
import { evaluateAndMaybeSwapCodex } from "../lib/codexdecide.ts";
import { CODEX_SUPERVISOR_ID_ENV } from "./codexsupervisor.ts";
import { CodexRespawnMarkerSchema, CodexStopStdinSchema } from "../lib/types.ts";
import { log } from "../lib/log.ts";

const SupervisorIdSchema = z.string().min(1).optional().catch(undefined);

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/** The testable core: decide, and on a swap under a supervisor, drop the
 *  respawn marker. Never throws (a hook failure must not block the stop). */
export async function handleCodexStop(input: { rawStdin: string }): Promise<void> {
  const parsed = CodexStopStdinSchema.safeParse((() => {
    try {
      return JSON.parse(input.rawStdin);
    } catch {
      return {};
    }
  })());
  const sessionId = parsed.success ? (parsed.data.session_id ?? null) : null;

  try {
    // No supervisor = no decision AT ALL, checked before evaluate can swap:
    // hooks.json is global, so this hook also fires in sessions launched
    // around the PATH shim (IDE extension, absolute path), and a swap with
    // nobody to respawn strands that session - codex cannot hot-adopt, and
    // its guarded reload refuses a cross-account auth.json, so the session
    // dies on its stale token with "Please sign in again" (closing-review
    // catch). Restart IS the switch; without a restarter, do not switch.
    const supervisorId = SupervisorIdSchema.parse(process.env[CODEX_SUPERVISOR_ID_ENV]);
    if (supervisorId === undefined) {
      log("codexstop.unsupervised_skip", {});
      return;
    }
    const decision = await evaluateAndMaybeSwapCodex({});
    if (decision.swapped && decision.account) {
      mkdirSync(codexPaths.respawnDir, { recursive: true });
      const payload = CodexRespawnMarkerSchema.parse({
        account: decision.account.label,
        sessionId,
        ts: Date.now(),
      });
      writeFileAtomic(join(codexPaths.respawnDir, supervisorId), JSON.stringify(payload));
      log("codexstop.marker", { supervisorId: supervisorId.slice(0, 8) });
    }
  } catch (e) {
    log("codexstop.error", { err: e instanceof Error ? e.message : String(e) });
  }
}

export async function runCodexStopHook(): Promise<number> {
  if (!process.env.TOKENMAXXING_PROBE) {
    await handleCodexStop({ rawStdin: await readStdin() });
  }
  process.stdout.write("{}"); // documented no-op hook output; never block the stop
  return 0;
}
