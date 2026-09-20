import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type { z } from "zod";
import { codexPaths, optionalEnv } from "../lib/paths.ts";
import { writeFileAtomic } from "../lib/atomic.ts";
import { MAX_WRAP_DEPTH, WRAP_DEPTH_ENV } from "../lib/claudebin.ts";
import { codex, codexPickCtx } from "../lib/codex.ts";
import { resolveRealCodex } from "../lib/codexbin.ts";
import { compactCodexThread } from "../lib/compact.ts";
import { evaluateAndMaybeSwap } from "../lib/decide.ts";
import { isExhausted } from "../lib/picker.ts";
import { livingPresences } from "../lib/presence.ts";
import { readStdin } from "../lib/proc.ts";
import { loadAccounts, loadConfig } from "../lib/state.ts";
import { CODEX_SUPERVISOR_ID_ENV } from "./codexsupervisor.ts";
import { CodexRespawnMarkerSchema, CodexStopStdinSchema, JsonTextSchema } from "../lib/types.ts";
import { errorMessage, log } from "../lib/log.ts";

async function compactBeforeMove(input: { sessionId: string | null; now: number }): Promise<void> {
  const { sessionId, now } = input;
  if (sessionId == null || sessionId.trim() === "") return;
  const liveId = codex.liveId();
  const live = liveId == null ? undefined : loadAccounts(codex.pool).accounts.find((a) => a.id === liveId);
  if (!live || live.needsReauth === true || (live.enforcedUntil != null && live.enforcedUntil > now)) return;
  const observed = await codex.observeLive(live, loadConfig(), now, { probe: true, perModel: false });
  if (!observed || !isExhausted({ ...live, windows: observed.windows }, codexPickCtx(now, live.id))) return;
  const env: Record<string, string | undefined> = { ...process.env, TOKENMAXXING_PROBE: "1", [WRAP_DEPTH_ENV]: String(MAX_WRAP_DEPTH) };
  delete env[CODEX_SUPERVISOR_ID_ENV];
  log("codexstop.compact_start", { thread: sessionId.slice(0, 8), account: live.id.slice(0, 8) });
  await compactCodexThread({ real: resolveRealCodex(), threadId: sessionId, env });
}

async function handleCodexStop(rawStdin: string): Promise<void> {
  const parsed = CodexStopStdinSchema.safeParse(JsonTextSchema.safeParse(rawStdin).data);
  const sessionId = parsed.success ? (parsed.data.session_id ?? null) : null;

  try {
    const supervisorId = optionalEnv(CODEX_SUPERVISOR_ID_ENV);
    if (supervisorId === undefined) {
      log("codexstop.unsupervised_skip", {});
      return;
    }
    const own = livingPresences(codexPaths.presenceDir).find((p) => p.id === supervisorId);
    const seat = codex.liveId();
    if (own && own.accountId !== seat) {
      log("codexstop.foreign_seat", { supervisorId: supervisorId.slice(0, 8), seat: seat?.slice(0, 8) ?? null });
      return;
    }
    const now = Date.now();
    await compactBeforeMove({ sessionId, now });
    const decision = await evaluateAndMaybeSwap(codex, now);
    if (decision.swapped && decision.account) {
      mkdirSync(codexPaths.respawnDir, { recursive: true });
      const payload: z.infer<typeof CodexRespawnMarkerSchema> = { accountId: decision.account.id, sessionId, ts: Date.now() };
      writeFileAtomic(join(codexPaths.respawnDir, supervisorId), JSON.stringify(payload));
      log("codexstop.marker", { supervisorId: supervisorId.slice(0, 8) });
      return;
    }
  } catch (e) {
    log("codexstop.error", { err: errorMessage(e) });
  }
}

export async function runCodexStopHook(): Promise<number> {
  if (!process.env.TOKENMAXXING_PROBE) await handleCodexStop(await readStdin());
  process.stdout.write("{}");
  return 0;
}
