import { withLock } from "../lib/lock.ts";
import { paths } from "../lib/paths.ts";
import {
  limitWallUntil,
  loadCloudSessions,
  loadCloudWalled,
  pickToken,
  readCloudTokens,
  saveCloudSessions,
  saveCloudWalled,
  spawnCloudClaude,
} from "../lib/cloud.ts";
import { c, emitError, emitJson, fmtReset } from "./render.ts";

const USAGE = "usage: tokenmaxxing cloud run [--session <id>] [--max-turns <n>] \"<prompt>\" (the prompt is also read from stdin)";

function parseFlags(args: string[]): { session: string | null; maxTurns: number | null; prompt: string | null } | { error: string } {
  let session: string | null = null;
  let maxTurns: number | null = null;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--session") {
      const raw = args[++i];
      if (raw == null || raw === "") return { error: "--session needs a session id" };
      session = raw;
      continue;
    }
    if (arg === "--max-turns") {
      const raw = args[++i];
      maxTurns = Number(raw);
      if (!Number.isInteger(maxTurns) || maxTurns < 1) return { error: `--max-turns needs a positive whole number, got: ${raw ?? "nothing"}` };
      continue;
    }
    positional.push(arg);
  }
  return { session, maxTurns, prompt: positional.length > 0 ? positional.join(" ") : null };
}

export async function cmdCloudRun(args: string[], json = false): Promise<number> {
  const flags = parseFlags(args);
  if ("error" in flags) {
    emitError({ json, message: `${flags.error} - ${USAGE}` });
    return 2;
  }
  const prompt = flags.prompt ?? (process.stdin.isTTY ? null : (await Bun.stdin.text()).trim());
  if (prompt == null || prompt === "") {
    emitError({ json, message: USAGE });
    return 2;
  }
  const tokens = readCloudTokens();
  let sessionId = flags.session;
  while (true) {
    const pick = await withLock(paths.cloudLockFile, () =>
      pickToken({ tokens, sessions: loadCloudSessions(), walled: loadCloudWalled(), sessionId, now: Date.now() }),
    );
    if (!pick.ok) {
      emitError({
        json,
        message: `every token is at its limit - earliest ${fmtReset(pick.earliestReset)}`,
        extra: { earliestReset: pick.earliestReset, session_id: sessionId },
      });
      return 1;
    }
    const label = pick.token.label;
    console.error(c.dim(`cloud run: ${label}${sessionId ? ` (resuming ${sessionId})` : ""}`));
    const { exitCode, result } = await spawnCloudClaude({ token: pick.token.token, prompt, resume: sessionId, maxTurns: flags.maxTurns });
    sessionId = result.session_id;
    await withLock(paths.cloudLockFile, () => {
      saveCloudSessions({ ...loadCloudSessions(), [result.session_id]: label });
    });
    if (result.is_error || result.subtype !== "success") {
      const until = limitWallUntil({ result, now: Date.now() });
      if (until != null) {
        await withLock(paths.cloudLockFile, () => {
          saveCloudWalled({ ...loadCloudWalled(), [label]: until });
        });
        console.error(c.yellow(`cloud run: ${label} hit its limit (${fmtReset(until)}) - resuming the session on the next token`));
        continue;
      }
      const errors = result.errors ?? (result.result ? [result.result] : []);
      emitError({
        json,
        message: `claude exited ${exitCode ?? "on signal"} (${result.subtype}): ${errors.join("; ")}`,
        notes: [`session ${result.session_id}`],
        extra: { session_id: result.session_id, subtype: result.subtype, errors },
      });
      return 1;
    }
    if (json) {
      emitJson({ ok: true, session_id: result.session_id, result: result.result ?? "", num_turns: result.num_turns, total_cost_usd: result.total_cost_usd });
      return 0;
    }
    console.log(result.result ?? "");
    console.log(`session ${result.session_id}`);
    return 0;
  }
}
