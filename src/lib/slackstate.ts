// `xx serve` state. slack.json holds the Slack tokens plus the channel->repo
// links; it is credential material (xoxb-/xapp-), so it is written 0600 and its
// tokens must never be printed. Per-thread records under slack-threads/ pin the
// claude session id + cwd a Slack thread resumes into (resume is cwd-keyed, so
// the cwd must stay byte-stable for the thread's whole life). A present but
// unparseable slack.json THROWS (no silent empty config); absent = null.

import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
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
