import { parseArgs } from "node:util";
import { withLock } from "../lib/lock.ts";
import { errorMessage } from "../lib/log.ts";
import { paths } from "../lib/paths.ts";
import {
  limitWallUntil,
  loadCloudSessions,
  loadCloudWalled,
  newReservationKey,
  pickToken,
  readCloudTokens,
  saveCloudSessions,
  saveCloudWalled,
  spawnCloudClaude,
  transcriptBytes,
} from "../lib/cloud.ts";
import { c, emitError, fmtReset } from "./render.ts";

const USAGE = "usage: tokenmaxxing cloud run [--session <id>] [--max-turns <n>] \"<prompt>\" (the prompt is also read from stdin)";

function parseFlags(args: string[]): { session: string | null; maxTurns: number | null; prompt: string | null } | { error: string } {
  let parsed;
  try {
    parsed = parseArgs({ args, options: { session: { type: "string" }, "max-turns": { type: "string" } }, allowPositionals: true });
  } catch (e) {
    return { error: errorMessage(e) };
  }
  const { session, "max-turns": rawTurns } = parsed.values;
  if (session === "") return { error: "--session needs a session id" };
  const maxTurns = rawTurns == null ? null : Number(rawTurns);
  if (maxTurns != null && (!Number.isInteger(maxTurns) || maxTurns < 1)) return { error: `--max-turns needs a positive whole number, got: ${rawTurns}` };
  return { session: session ?? null, maxTurns, prompt: parsed.positionals.length > 0 ? parsed.positionals.join(" ") : null };
}

export async function cmdCloudRun(args: string[]): Promise<number> {
  const flags = parseFlags(args);
  if ("error" in flags) {
    emitError({ message: `${flags.error} - ${USAGE}` });
    return 2;
  }
  const prompt = flags.prompt ?? (process.stdin.isTTY ? null : await Bun.stdin.text());
  if (prompt == null || prompt.trim() === "") {
    emitError({ message: USAGE });
    return 2;
  }
  const tokens = readCloudTokens();
  let sessionId = flags.session;
  while (true) {
    const reservation = newReservationKey();
    const pick = await withLock(paths.cloudLockFile, () => {
      const sessions = loadCloudSessions();
      const picked = pickToken({ tokens, sessions, walled: loadCloudWalled(), sessionId, now: Date.now() });
      if (picked.ok) saveCloudSessions({ ...sessions, [reservation]: picked.token.label });
      return picked;
    });
    if (!pick.ok) {
      emitError({ message: `every token is at its limit - earliest ${fmtReset(pick.earliestReset)}` });
      return 1;
    }
    const label = pick.token.label;
    console.error(c.dim(`cloud run: ${label}${sessionId ? ` (resuming ${sessionId})` : ""}`));
    const transcriptBefore = transcriptBytes(sessionId);
    let spawned: Awaited<ReturnType<typeof spawnCloudClaude>>;
    try {
      spawned = await spawnCloudClaude({ token: pick.token.token, prompt, resume: sessionId, maxTurns: flags.maxTurns });
    } catch (e) {
      await withLock(paths.cloudLockFile, () => {
        const sessions = loadCloudSessions();
        delete sessions[reservation];
        saveCloudSessions(sessions);
      });
      throw e;
    }
    const { exitCode, result } = spawned;
    sessionId = result.session_id;
    const failed = result.is_error || result.subtype !== "success";
    const until = failed ? limitWallUntil({ sessionId: result.session_id, sinceBytes: transcriptBefore, now: Date.now() }) : null;
    await withLock(paths.cloudLockFile, () => {
      const sessions = loadCloudSessions();
      delete sessions[reservation];
      saveCloudSessions({ ...sessions, [result.session_id]: label });
      if (until != null) saveCloudWalled({ ...loadCloudWalled(), [label]: until });
    });
    if (failed) {
      if (until != null) {
        console.error(c.yellow(`cloud run: ${label} hit its limit (${fmtReset(until)}) - resuming the session on the next token`));
        continue;
      }
      const errors = result.subtype === "success" ? [result.result] : result.errors;
      emitError({
        message: `claude exited ${exitCode ?? "on signal"} (${result.subtype}): ${errors.join("; ")}`,
        notes: [`session ${result.session_id}`],
      });
      return 1;
    }
    console.log(result.result);
    console.log(`session ${result.session_id}`);
    return 0;
  }
}
