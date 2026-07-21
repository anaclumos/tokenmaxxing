// `xx serve` state. slack.json holds the Slack tokens plus the channel->repo
// links; it is credential material (xoxb-/xapp-), so it is written 0600 and its
// tokens must never be printed. Per-thread records under slack-threads/ pin the
// claude session id + cwd a Slack thread resumes into (resume is cwd-keyed, so
// the cwd must stay byte-stable for the thread's whole life). A present but
// unparseable slack.json THROWS (no silent empty config); absent = null.
//
// Retention tradeoff (intentional, closing-review critic gap): thread records
// have NO age-out - the only GC is the model-invoked finish_thread close-out.
// An abandoned thread's record persists indefinitely, ON PURPOSE: records are
// tiny JSON, every record is a resumable conversation, and a time-based
// reaper would silently kill threads the user still expects to revive with
// one @mention. Revisit only if slack-threads/ ever measurably bloats.

import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { omit } from "es-toolkit";
import { z } from "zod";
import { paths } from "./paths.ts";
import { writeFileAtomic } from "./atomic.ts";

/** Claude Agent SDK permission modes an unattended bridge may run under.
 *  acceptEdits (default) auto-approves file edits but not arbitrary Bash;
 *  bypassPermissions is full autonomy - a per-link, user-chosen risk posture. */
const ServePermissionModeSchema = z.enum(["default", "acceptEdits", "bypassPermissions", "dontAsk", "plan"]);

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
  /** the home workspace's team id (auth.test), the reference the external-author
   *  guard compares message origins against; captured at setup and ensured at
   *  daemon start, so it is only absent in configs saved before the guard. */
  workspaceTeamId: z.string().optional(),
  links: z.array(SlackLinkSchema).default([]),
});
export type SlackConfig = z.infer<typeof SlackConfigSchema>;

/** Team-origin fields Slack stamps on message/mention event payloads. */
const MessageOriginSchema = z.looseObject({
  source_team: z.string().optional(),
  team: z.string().optional(),
  team_id: z.string().optional(),
  user_team: z.string().optional(),
});

/** Outsiders must not drive sessions (owner rule 2026-07-16, ported from Slaude
 *  at its shutdown): in Slack Connect shared channels an external-workspace
 *  author carries team fields (`user_team` / `source_team` / `team`) that
 *  differ from the home workspace. Fail closed: reject a payload whose author
 *  origin is unreadable, absent, or disagrees on ANY present field. */
export function isOutsideAuthor(input: { raw: unknown; workspaceTeamId: string }): boolean {
  const parsed = MessageOriginSchema.safeParse(input.raw);
  if (!parsed.success) return true;
  const fields = [parsed.data.user_team, parsed.data.source_team, parsed.data.team, parsed.data.team_id]
    .filter((team): team is string => team !== undefined);
  if (fields.length === 0) return true;
  return fields.some((team) => team !== input.workspaceTeamId);
}

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
 *  turn 8 minutes in). A marker can also survive a RETURNED turn on purpose:
 *  a usage-limit deferral keeps it with resumeAt set, and the daemon resumes
 *  the turn itself once the pool recovers (2026-07-20 incident: limit-hit
 *  turns and depleted-pool drops sat dead until the user re-sent by hand).
 *  resumeCount caps the retries: every resumed attempt spends real quota, so
 *  a turn that keeps dying must not retry forever. */
const ActiveTurnSchema = z.object({
  /** the original folded prompt, replayed verbatim when the killed turn never
   *  reached its init message (sessionId still null = nothing to resume). */
  prompt: z.string(),
  startedAt: z.string(),
  resumeCount: z.number().int().nonnegative(),
  /** epoch ms when the pool is expected usable again: present only on a
   *  usage-limit deferral. The daemon resumes the turn at this time (or at
   *  startup once it has passed); a still-depleted pool at the wake simply
   *  re-defers, bounded by resumeCount. */
  resumeAt: z.number().int().positive().optional(),
  /** the DETACHED claude child's process-group id, persisted at spawn: an
   *  uncatchable daemon death (SIGKILL, crash) skips the exit hook that kills
   *  the group, so recovery must reap a surviving orphan before resuming -
   *  two claude processes must never share the thread's cwd and session.
   *  Absent until the spawn callback fires. */
  pid: z.number().int().positive().optional(),
  /** the ps lstart token captured for that pid at spawn: pid + start time is
   *  the process identity, so recovery signals only a verified match - a
   *  recycled pid must never get the kill (cubic review catch; this machine
   *  runs the user's real claude sessions). Absent = identity unverifiable =
   *  never signal. */
  pidStartedAt: z.string().optional(),
  /** Slack id (message ts) of the turn's triggering message: it carries the
   *  status reactions (hourglass while running, check/x/question at settle),
   *  so a recovered turn can finish the lifecycle it started. Absent for
   *  turns whose trigger had no relayable message id (e.g. a resumed record
   *  from before this field existed) - status reactions just skip then. */
  messageId: z.string().optional(),
  /** the triggering turn's requester ids: a recovered turn that flags
   *  attention must persist the KILLED turn's actual askers, not whoever
   *  authored the thread's newest message at recovery time (vercel review
   *  catch on PR #43 - the wrong user would get nudged and answer-gated).
   *  Absent on older records: recovery falls back to the streamable
   *  handle's newest-author derivation. */
  requesterIds: z.array(z.string()).optional(),
});
export type ActiveTurn = z.infer<typeof ActiveTurnSchema>;

/** The thread is waiting on the user: set after a turn in which the model
 *  called need_attention (the ask-the-user flow), cleared when any relayable
 *  message or an asked user's reaction arrives. One nudge per ask: nudgedAt
 *  marks it spent, so the sweep can never mention-spam. */
const ThreadAttentionSchema = z.object({
  /** the asked users: only their reactions count as an answer. */
  requesterIds: z.array(z.string()),
  askedAt: z.string(),
  nudgedAt: z.string().optional(),
  /** the asking turn's triggering message: carries the question-mark status
   *  reaction, removed once the user responds. */
  messageId: z.string().optional(),
});
export type ThreadAttention = z.infer<typeof ThreadAttentionSchema>;

/** A user reaction observed while no answer was owed: folded into the next
 *  turn's prompt as context (the model sees it and can respond), then
 *  cleared. Bounded to the newest few so an emoji burst cannot grow the
 *  record without bound. */
const PendingReactionSchema = z.object({
  userId: z.string(),
  emoji: z.string(),
  at: z.string(),
});
export type PendingReaction = z.infer<typeof PendingReactionSchema>;

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
  /** present only while the thread waits on the user's answer. */
  attention: ThreadAttentionSchema.optional(),
  /** reactions observed since the last turn, folded into the next prompt. */
  pendingReactions: z.array(PendingReactionSchema).optional(),
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

/** Drop a finished thread's record: the thread-level GC (cleanupThread). */
export function deleteSlackThread(threadId: string): void {
  const f = threadFile(threadId);
  if (existsSync(f)) unlinkSync(f);
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

const ResumeDecisionSchema = z.union([
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

/** What to do with a thread whose activeTurn marker survived: either the
 *  previous daemon died mid-turn (no resumeAt - startup recovery) or a
 *  usage-limit deferral parked the turn (resumeAt set - the scheduler fires
 *  it once the pool recovers). Returns null for threads with no marker. The
 *  resumed marker drops resumeAt: the wake is consumed, and a still-depleted
 *  pool at the resume writes a fresh deferral with a fresh wake. */
export function resumeDecision(record: SlackThread): ResumeDecision | null {
  const turn = record.activeTurn;
  if (!turn) return null;
  const deferred = turn.resumeAt !== undefined;
  if (turn.resumeCount >= MAX_TURN_RESUMES) {
    return {
      kind: "give-up",
      notice: deferred
        ? `this turn kept hitting the pool's usage limits and ${MAX_TURN_RESUMES} resume attempts were spent - giving up. Send a new message to continue.`
        : `a daemon restart interrupted this turn, and ${MAX_TURN_RESUMES} resume attempts were interrupted too - giving up. Send a new message to continue.`,
    };
  }
  const marker = omit({ ...turn, resumeCount: turn.resumeCount + 1 }, ["resumeAt"]);
  const attempt = marker.resumeCount > 1 ? ` (attempt ${marker.resumeCount}/${MAX_TURN_RESUMES})` : "";
  if (record.sessionId === null) {
    return {
      kind: "resume",
      notice: deferred
        ? `the account pool has recovered - running your held message${attempt}`
        : `a daemon restart interrupted this turn before its session opened - starting it over${attempt}`,
      prompt: turn.prompt,
      sessionId: null,
      marker,
    };
  }
  return {
    kind: "resume",
    notice: deferred ? `the account pool has recovered - resuming this turn${attempt}` : `a daemon restart interrupted this turn - resuming${attempt}`,
    prompt: deferred
      ? `Your previous turn stopped early because every pooled account was at its usage limit; the pool has recovered. Pick up exactly where you left off and finish the task. If the work was already complete, just summarize the final state. The original request was:\n\n${turn.prompt}`
      : `A tokenmaxxing serve daemon restart killed your previous turn mid-run. Pick up exactly where you left off and finish the task. If the work was already complete, just summarize the final state. The original request was:\n\n${turn.prompt}`,
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

/**
 * Strip a leading Slack mention OF THE BOT from message text. Two forms: raw
 * mrkdwn ("<@U0123> rest") and the bare form the Chat SDK's incoming
 * mrkdwn->markdown normalization produces ("@U0123 rest") - observed live
 * 2026-07-18 when a relayed prompt arrived starting "@U0BHS1YKNSK". Only a
 * token whose id equals botUserId is stripped (review catch 2026-07-18:
 * handleTurn runs this over every subscribed message, so a follow-up starting
 * with a colleague's mention must keep it - the prompt would otherwise lose
 * who it is about). An unknown botUserId strips nothing: without the id we
 * cannot tell the bot's mention from anyone else's.
 */
export function stripLeadingMention(input: { text: string; botUserId: string | null }): string {
  const trimmed = input.text.trimStart();
  if (input.botUserId === null) return input.text.trim();
  if (trimmed.startsWith("<@")) {
    const close = trimmed.indexOf(">");
    if (close < 0) return input.text.trim();
    const [id] = trimmed.slice(2, close).split("|");
    if (id === input.botUserId) return trimmed.slice(close + 1).trim();
    return input.text.trim();
  }
  if (trimmed.startsWith("@U") || trimmed.startsWith("@W")) {
    let end = 1;
    while (end < trimmed.length) {
      const ch = trimmed[end] ?? "";
      if ((ch >= "0" && ch <= "9") || (ch >= "A" && ch <= "Z")) end += 1;
      else break;
    }
    const next = trimmed[end];
    const atBoundary = next === undefined || next === " " || next === "\n" || next === "\t";
    if (end - 1 >= 2 && atBoundary && trimmed.slice(1, end) === input.botUserId) return trimmed.slice(end).trim();
  }
  return input.text.trim();
}
