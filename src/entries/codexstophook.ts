import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { z } from "zod";
import { codexPaths } from "../lib/paths.ts";
import { writeFileAtomic } from "../lib/atomic.ts";
import { codex } from "../lib/codex.ts";
import { evaluateAndMaybeSwap } from "../lib/decide.ts";
import { CODEX_SUPERVISOR_ID_ENV } from "./codexsupervisor.ts";
import { CodexRespawnMarkerSchema, CodexStopStdinSchema, JsonTextSchema } from "../lib/types.ts";
import { log } from "../lib/log.ts";
import { readStdin } from "./statusline.ts";

const SupervisorIdSchema = z.string().min(1).optional().catch(undefined);

export async function handleCodexStop(input: { rawStdin: string }): Promise<void> {
  const parsed = CodexStopStdinSchema.safeParse(JsonTextSchema.safeParse(input.rawStdin).data);
  const sessionId = parsed.success ? (parsed.data.session_id ?? null) : null;

  try {
    const supervisorId = SupervisorIdSchema.parse(process.env[CODEX_SUPERVISOR_ID_ENV]);
    if (supervisorId === undefined) {
      log("codexstop.unsupervised_skip", {});
      return;
    }
    const decision = await evaluateAndMaybeSwap(codex, Date.now(), true);
    if (decision.swapped && decision.account) {
      mkdirSync(codexPaths.respawnDir, { recursive: true });
      const payload = CodexRespawnMarkerSchema.parse({ accountId: decision.account.id, sessionId, ts: Date.now() });
      writeFileAtomic(join(codexPaths.respawnDir, supervisorId), JSON.stringify(payload));
      log("codexstop.marker", { supervisorId: supervisorId.slice(0, 8), account: decision.account.id.slice(0, 8) });
    }
  } catch (e) {
    log("codexstop.error", { err: e instanceof Error ? e.message : String(e) });
  }
}

export async function runCodexStopHook(): Promise<number> {
  if (!process.env.TOKENMAXXING_PROBE) {
    await handleCodexStop({ rawStdin: await readStdin() });
  }
  process.stdout.write("{}");
  return 0;
}
