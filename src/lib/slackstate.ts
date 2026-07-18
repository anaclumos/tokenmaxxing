// `xx serve` state. slack.json holds the Slack tokens plus the channel->repo
// links; it is credential material (xoxb-/xapp-), so it is written 0600 and its
// tokens must never be printed. Per-thread records under slack-threads/ pin the
// claude session id + cwd a Slack thread resumes into (resume is cwd-keyed, so
// the cwd must stay byte-stable for the thread's whole life). A present but
// unparseable slack.json THROWS (no silent empty config); absent = null.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { paths } from "./paths.ts";
import { writeFileAtomic } from "./atomic.ts";

/** Claude Agent SDK permission modes an unattended bridge may run under.
 *  acceptEdits (default) auto-approves file edits but not arbitrary Bash;
 *  bypassPermissions is full autonomy - a per-link, user-chosen risk posture. */
export const ServePermissionModeSchema = z.enum(["default", "acceptEdits", "bypassPermissions", "dontAsk", "plan"]);

export const SlackLinkSchema = z.object({
  /** Slack channel id (C.../G...). Names are not stored - ids are stable. */
  channel: z.string(),
  /** absolute path of the git repo this channel drives. */
  repo: z.string(),
  permissionMode: ServePermissionModeSchema.default("acceptEdits"),
  /** optional model override for this repo's sessions. */
  model: z.string().optional(),
});
export type SlackLink = z.infer<typeof SlackLinkSchema>;

export const SlackConfigSchema = z.object({
  botToken: z.string().startsWith("xoxb-"),
  appToken: z.string().startsWith("xapp-"),
  links: z.array(SlackLinkSchema).default([]),
});
export type SlackConfig = z.infer<typeof SlackConfigSchema>;

export function loadSlackConfig(): SlackConfig | null {
  if (!existsSync(paths.slackJson)) return null;
  return SlackConfigSchema.parse(JSON.parse(readFileSync(paths.slackJson, "utf8")));
}

export function saveSlackConfig(cfg: SlackConfig): void {
  writeFileAtomic(paths.slackJson, JSON.stringify(SlackConfigSchema.parse(cfg), null, 2) + "\n", 0o600);
}

/** A Slack channel id: C (public) or G (private/legacy) followed by uppercase
 *  alphanumerics. Structural check, no regex. */
export function isChannelId(s: string): boolean {
  if (s.length < 2 || (s[0] !== "C" && s[0] !== "G")) return false;
  const rest = s.slice(1);
  return [...rest].every((ch) => (ch >= "0" && ch <= "9") || (ch >= "A" && ch <= "Z"));
}

// ---- per-thread session records -------------------------------------------

/** Durable in-flight-turn marker. Written before a turn spawns and removed
 *  when it returns, so a marker that survives into the next daemon start means
 *  a restart killed the turn mid-run - startup then notifies the thread and
 *  auto-resumes it (2026-07-18 incident: a redeploy silently killed a ship
 *  turn 8 minutes in). resumeCount caps the retries: every resumed attempt
 *  spends real quota, so a turn that keeps dying must not retry forever. */
export const ActiveTurnSchema = z.object({
  /** the original folded prompt, replayed verbatim when the killed turn never
   *  reached its init message (sessionId still null = nothing to resume). */
  prompt: z.string(),
  startedAt: z.string(),
  resumeCount: z.number().int().nonnegative(),
});
export type ActiveTurn = z.infer<typeof ActiveTurnSchema>;

export const SlackThreadSchema = z.object({
  /** chat-sdk thread id, e.g. "slack:C0123:1721300000.123456". */
  threadId: z.string(),
  repo: z.string(),
  /** the dir every turn of this thread runs in; resume is cwd-keyed, so it
   *  stays byte-stable for the thread's whole life (records from the removed
   *  worktree-per-thread era pin their old worktree and keep working). */
  cwd: z.string(),
  /** claude session id; null until the first turn's init message arrives. */
  sessionId: z.string().nullable(),
  createdAt: z.string(),
  /** present only while a turn is running (or was killed mid-run). */
  activeTurn: ActiveTurnSchema.optional(),
});
export type SlackThread = z.infer<typeof SlackThreadSchema>;

/** Filesystem-safe key for a thread id: alnum kept, everything else "-". */
export function threadKey(threadId: string): string {
  return [...threadId]
    .map((ch) => ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9") ? ch : "-"))
    .join("");
}

function threadFile(threadId: string): string {
  return join(paths.slackThreadsDir, `${threadKey(threadId)}.json`);
}

export function loadSlackThread(threadId: string): SlackThread | null {
  const f = threadFile(threadId);
  if (!existsSync(f)) return null;
  return SlackThreadSchema.parse(JSON.parse(readFileSync(f, "utf8")));
}

export function saveSlackThread(t: SlackThread): void {
  writeFileAtomic(threadFile(t.threadId), JSON.stringify(SlackThreadSchema.parse(t), null, 2) + "\n");
}

export function listSlackThreads(): SlackThread[] {
  if (!existsSync(paths.slackThreadsDir)) return [];
  const out: SlackThread[] = [];
  for (const f of readdirSync(paths.slackThreadsDir)) {
    if (!f.endsWith(".json")) continue;
    out.push(SlackThreadSchema.parse(JSON.parse(readFileSync(join(paths.slackThreadsDir, f), "utf8"))));
  }
  return out;
}

// ---- interrupted-turn resume decision (unit-tested) ------------------------

/** Resumed attempts spend real quota, so an interrupted turn retries at most
 *  this many times before startup gives up and asks for a human message. */
export const MAX_TURN_RESUMES = 3;

export const ResumeDecisionSchema = z.union([
  z.object({ kind: z.literal("give-up"), notice: z.string() }),
  z.object({
    kind: z.literal("resume"),
    notice: z.string(),
    prompt: z.string(),
    /** session to resume; null = the kill landed before init assigned one,
     *  so the original prompt replays in a fresh session. */
    sessionId: z.string().nullable(),
    /** the incremented marker to persist BEFORE the resumed turn spawns, so
     *  a kill during the resume still counts toward the cap. */
    marker: ActiveTurnSchema,
  }),
]);
export type ResumeDecision = z.infer<typeof ResumeDecisionSchema>;

/** What startup should do with a thread whose activeTurn marker survived the
 *  previous daemon. Returns null for threads with no surviving marker. */
export function resumeDecision(record: SlackThread): ResumeDecision | null {
  const turn = record.activeTurn;
  if (!turn) return null;
  if (turn.resumeCount >= MAX_TURN_RESUMES) {
    return {
      kind: "give-up",
      notice: `a daemon restart interrupted this turn, and ${MAX_TURN_RESUMES} resume attempts were interrupted too - giving up. Send a new message to continue.`,
    };
  }
  const marker = { ...turn, resumeCount: turn.resumeCount + 1 };
  const attempt = marker.resumeCount > 1 ? ` (attempt ${marker.resumeCount}/${MAX_TURN_RESUMES})` : "";
  if (record.sessionId === null) {
    return {
      kind: "resume",
      notice: `a daemon restart interrupted this turn before its session opened - starting it over${attempt}`,
      prompt: turn.prompt,
      sessionId: null,
      marker,
    };
  }
  return {
    kind: "resume",
    notice: `a daemon restart interrupted this turn - resuming${attempt}`,
    prompt: `A tokenmaxxing serve daemon restart killed your previous turn mid-run. Pick up exactly where you left off and finish the task. If the work was already complete, just summarize the final state. The original request was:\n\n${turn.prompt}`,
    sessionId: record.sessionId,
    marker,
  };
}

// ---- pure link edits (unit-tested) ----------------------------------------

export function upsertLink(cfg: SlackConfig, link: SlackLink): SlackConfig {
  const links = cfg.links.filter((l) => l.channel !== link.channel);
  links.push(link);
  return { ...cfg, links };
}

export function removeLink(cfg: SlackConfig, channel: string): SlackConfig | null {
  if (!cfg.links.some((l) => l.channel === channel)) return null;
  return { ...cfg, links: cfg.links.filter((l) => l.channel !== channel) };
}

export function linkForChannel(cfg: SlackConfig, channel: string): SlackLink | null {
  return cfg.links.find((l) => l.channel === channel) ?? null;
}

/** Chat SDK channel ids are adapter-prefixed ("slack:C0123"); links store the
 *  bare Slack id, so lookups must strip the prefix. */
export function bareChannelId(id: string): string {
  return id.startsWith("slack:") ? id.slice("slack:".length) : id;
}

/** Strip a leading Slack mention token ("<@U0123> rest") from message text. */
export function stripLeadingMention(text: string): string {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("<@")) return text.trim();
  const close = trimmed.indexOf(">");
  if (close < 0) return text.trim();
  return trimmed.slice(close + 1).trim();
}
