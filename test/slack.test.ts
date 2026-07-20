// `xx serve` slack state: config schema, channel-id/thread-key structure,
// link edits, mention stripping, and the fail-fast slack.json contract.

import { describe, expect, test } from "bun:test";
import { rmSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  MAX_TURN_RESUMES,
  SlackConfigSchema,
  SlackThreadSchema,
  bareChannelId,
  isChannelId,
  isOutsideAuthor,
  linkForChannel,
  loadSlackConfig,
  loadSlackThread,
  removeLink,
  resumeDecision,
  saveSlackThread,
  stripLeadingMention,
  threadKey,
  upsertLink,
} from "../src/lib/slackstate.ts";
import { paths } from "../src/lib/paths.ts";

const goodConfig = {
  botToken: "xoxb-1234",
  appToken: "xapp-5678",
  links: [{ channel: "C0123ABC", repo: "/tmp/repo" }],
};

describe("SlackConfigSchema", () => {
  test("accepts xoxb-/xapp- tokens and defaults permissionMode", () => {
    const cfg = SlackConfigSchema.parse(goodConfig);
    expect(cfg.links[0]?.permissionMode).toBe("acceptEdits");
  });

  test("rejects wrong token prefixes", () => {
    expect(() => SlackConfigSchema.parse({ ...goodConfig, botToken: "xapp-1" })).toThrow();
    expect(() => SlackConfigSchema.parse({ ...goodConfig, appToken: "xoxb-1" })).toThrow();
  });

  test("workspaceTeamId is optional and round-trips", () => {
    expect(SlackConfigSchema.parse(goodConfig).workspaceTeamId).toBeUndefined();
    expect(SlackConfigSchema.parse({ ...goodConfig, workspaceTeamId: "T0HOME" }).workspaceTeamId).toBe("T0HOME");
  });
});

describe("isOutsideAuthor", () => {
  const workspaceTeamId = "T0HOME";

  test("home-workspace payloads pass via any team field", () => {
    expect(isOutsideAuthor({ raw: { team: "T0HOME" }, workspaceTeamId })).toBe(false);
    expect(isOutsideAuthor({ raw: { user_team: "T0HOME" }, workspaceTeamId })).toBe(false);
    expect(isOutsideAuthor({ raw: { source_team: "T0HOME" }, workspaceTeamId })).toBe(false);
    expect(isOutsideAuthor({ raw: { team_id: "T0HOME" }, workspaceTeamId })).toBe(false);
    expect(isOutsideAuthor({ raw: { team: "T0HOME", user_team: "T0HOME", source_team: "T0HOME", channel: "C1", ts: "1.2" }, workspaceTeamId })).toBe(false);
  });

  test("ANY present field disagreeing rejects (Slack Connect externals)", () => {
    expect(isOutsideAuthor({ raw: { team: "T0HOME", user_team: "TEXTERNAL" }, workspaceTeamId })).toBe(true);
    expect(isOutsideAuthor({ raw: { source_team: "TEXTERNAL" }, workspaceTeamId })).toBe(true);
  });

  test("fail-closed on unreadable or origin-less payloads", () => {
    expect(isOutsideAuthor({ raw: {}, workspaceTeamId })).toBe(true);
    expect(isOutsideAuthor({ raw: { channel: "C1", ts: "1.2" }, workspaceTeamId })).toBe(true);
    expect(isOutsideAuthor({ raw: null, workspaceTeamId })).toBe(true);
    expect(isOutsideAuthor({ raw: undefined, workspaceTeamId })).toBe(true);
    expect(isOutsideAuthor({ raw: "not an object", workspaceTeamId })).toBe(true);
    expect(isOutsideAuthor({ raw: { team: 123 }, workspaceTeamId })).toBe(true);
  });
});

describe("isChannelId", () => {
  test("accepts C/G ids, rejects names and lowercase", () => {
    expect(isChannelId("C0123ABC")).toBe(true);
    expect(isChannelId("G9ZYX8")).toBe(true);
    expect(isChannelId("#general")).toBe(false);
    expect(isChannelId("c0123")).toBe(false);
    expect(isChannelId("C")).toBe(false);
    expect(isChannelId("D0123")).toBe(false);
  });
});

describe("threadKey", () => {
  test("keeps alnum, maps everything else to hyphens", () => {
    expect(threadKey("slack:C0123:1721.456")).toBe("slack-C0123-1721-456");
  });
});

describe("link edits", () => {
  const cfg = SlackConfigSchema.parse(goodConfig);

  test("upsertLink replaces an existing channel link", () => {
    const next = upsertLink(cfg, { ...cfg.links[0]!, repo: "/tmp/other" });
    expect(next.links).toHaveLength(1);
    expect(next.links[0]?.repo).toBe("/tmp/other");
  });

  test("removeLink returns null for an unknown channel", () => {
    expect(removeLink(cfg, "C404")).toBeNull();
    expect(removeLink(cfg, "C0123ABC")?.links).toHaveLength(0);
  });

  test("linkForChannel finds by id", () => {
    expect(linkForChannel(cfg, "C0123ABC")?.repo).toBe("/tmp/repo");
    expect(linkForChannel(cfg, "C404")).toBeNull();
  });

  test("bareChannelId strips the chat-sdk adapter prefix", () => {
    expect(bareChannelId("slack:C0123ABC")).toBe("C0123ABC");
    expect(bareChannelId("C0123ABC")).toBe("C0123ABC");
    expect(linkForChannel(cfg, bareChannelId("slack:C0123ABC"))?.repo).toBe("/tmp/repo");
  });
});

describe("stripLeadingMention", () => {
  test("strips one leading bot mention token and trims", () => {
    expect(stripLeadingMention({ text: "<@U0123> fix the tests", botUserId: "U0123" })).toBe("fix the tests");
    expect(stripLeadingMention({ text: "  <@U0123>   fix ", botUserId: "U0123" })).toBe("fix");
    expect(stripLeadingMention({ text: "<@U0123|tokenmaxxing> fix", botUserId: "U0123" })).toBe("fix");
    expect(stripLeadingMention({ text: "no mention here", botUserId: "U0123" })).toBe("no mention here");
    expect(stripLeadingMention({ text: "<@U0123 unclosed", botUserId: "U0123" })).toBe("<@U0123 unclosed");
  });

  test("strips the bare form the Chat SDK's mrkdwn normalization produces", () => {
    expect(stripLeadingMention({ text: "@U0BHS1YKNSK add related skills", botUserId: "U0BHS1YKNSK" })).toBe("add related skills");
    expect(stripLeadingMention({ text: "  @W0123ABC\nnext line", botUserId: "W0123ABC" })).toBe("next line");
    expect(stripLeadingMention({ text: "@U0123", botUserId: "U0123" })).toBe("");
    // prose and display-name mentions are not structurally user ids: pass through.
    expect(stripLeadingMention({ text: "@bob please look", botUserId: "U0123" })).toBe("@bob please look");
    expect(stripLeadingMention({ text: "@U lone letter", botUserId: "U0123" })).toBe("@U lone letter");
    expect(stripLeadingMention({ text: "@U0123: colon glued", botUserId: "U0123" })).toBe("@U0123: colon glued");
    expect(stripLeadingMention({ text: "email@U0123 is not a mention", botUserId: "U0123" })).toBe("email@U0123 is not a mention");
  });

  test("keeps mentions of anyone but the bot (review catch 2026-07-18)", () => {
    expect(stripLeadingMention({ text: "@UALICE99 can you check this", botUserId: "U0123" })).toBe("@UALICE99 can you check this");
    expect(stripLeadingMention({ text: "<@UALICE99> can you check this", botUserId: "U0123" })).toBe("<@UALICE99> can you check this");
    // unknown bot id strips nothing: we cannot tell the bot's mention apart.
    expect(stripLeadingMention({ text: "<@U0123> fix the tests", botUserId: null })).toBe("<@U0123> fix the tests");
    expect(stripLeadingMention({ text: "@U0123 fix", botUserId: null })).toBe("@U0123 fix");
  });

  test("both Slack slash-command arrival forms land the command at position 0", () => {
    // Slack's composer eats bare "/cmd" client-side (never delivered); the
    // two forms that DO post are mention-first and Slack's own leading-space
    // workaround. Both must normalize so the CLI parses the slash command.
    expect(stripLeadingMention({ text: "<@U0123> /usage", botUserId: "U0123" })).toBe("/usage");
    expect(stripLeadingMention({ text: " /usage", botUserId: "U0123" })).toBe("/usage");
    expect(stripLeadingMention({ text: "<@U0123> /goal ship the feature", botUserId: "U0123" })).toBe("/goal ship the feature");
  });
});

describe("slack.json contract", () => {
  test("absent = null, unparseable = throw, valid = parsed", () => {
    rmSync(paths.slackJson, { force: true });
    expect(loadSlackConfig()).toBeNull();

    mkdirSync(dirname(paths.slackJson), { recursive: true });
    writeFileSync(paths.slackJson, "{broken");
    expect(() => loadSlackConfig()).toThrow();

    writeFileSync(paths.slackJson, JSON.stringify(goodConfig));
    expect(loadSlackConfig()?.links).toHaveLength(1);
    rmSync(paths.slackJson, { force: true });
  });
});

const baseRecord = {
  threadId: "slack:C0123:1721.456",
  repo: "/tmp/repo",
  cwd: "/tmp/repo",
  sessionId: null,
  createdAt: "2026-07-18T00:00:00.000Z",
};

describe("thread records", () => {
  test("round-trip by thread id", () => {
    saveSlackThread(baseRecord);
    const loaded = loadSlackThread(baseRecord.threadId);
    expect(loaded?.cwd).toBe("/tmp/repo");
    expect(loaded?.sessionId).toBeNull();
  });

  test("records without activeTurn still parse (pre-marker records)", () => {
    const loaded = SlackThreadSchema.parse(baseRecord);
    expect(loaded.activeTurn).toBeUndefined();
  });

  test("activeTurn marker survives a save/load round-trip and clears on omit-save", () => {
    const marker = { prompt: "ship the thing", startedAt: "2026-07-18T10:00:00.000Z", resumeCount: 1 };
    saveSlackThread({ ...baseRecord, activeTurn: marker });
    expect(loadSlackThread(baseRecord.threadId)?.activeTurn).toEqual(marker);
    saveSlackThread(baseRecord);
    expect(loadSlackThread(baseRecord.threadId)?.activeTurn).toBeUndefined();
  });

  test("the spawn pid persists on the marker; a pre-spawn marker has none", () => {
    const marker = { prompt: "ship", startedAt: "2026-07-18T10:00:00.000Z", resumeCount: 0 };
    saveSlackThread({ ...baseRecord, activeTurn: { ...marker, pid: 4242 } });
    expect(loadSlackThread(baseRecord.threadId)?.activeTurn?.pid).toBe(4242);
    saveSlackThread({ ...baseRecord, activeTurn: marker });
    expect(loadSlackThread(baseRecord.threadId)?.activeTurn?.pid).toBeUndefined();
  });

  test("the marker's triggering-message id persists (status reactions on recovery)", () => {
    const marker = { prompt: "ship", startedAt: "2026-07-18T10:00:00.000Z", resumeCount: 0, messageId: "1721.456" };
    saveSlackThread({ ...baseRecord, activeTurn: marker });
    expect(loadSlackThread(baseRecord.threadId)?.activeTurn?.messageId).toBe("1721.456");
  });

  test("attention and pendingReactions round-trip and clear on omit-save", () => {
    const attention = { requesterIds: ["U1", "U2"], askedAt: "2026-07-20T00:00:00.000Z", messageId: "1721.900" };
    const pendingReactions = [{ userId: "U3", emoji: "eyes", at: "2026-07-20T00:01:00.000Z" }];
    saveSlackThread({ ...baseRecord, attention, pendingReactions });
    const loaded = loadSlackThread(baseRecord.threadId);
    expect(loaded?.attention).toEqual(attention);
    expect(loaded?.pendingReactions).toEqual(pendingReactions);
    saveSlackThread({ ...baseRecord, attention: { ...attention, nudgedAt: "2026-07-20T00:10:00.000Z" } });
    expect(loadSlackThread(baseRecord.threadId)?.attention?.nudgedAt).toBe("2026-07-20T00:10:00.000Z");
    saveSlackThread(baseRecord);
    expect(loadSlackThread(baseRecord.threadId)?.attention).toBeUndefined();
    expect(loadSlackThread(baseRecord.threadId)?.pendingReactions).toBeUndefined();
  });
});

describe("resumeDecision", () => {
  const marker = { prompt: "ship the thing", startedAt: "2026-07-18T10:00:00.000Z", resumeCount: 0 };

  test("no marker = nothing to recover", () => {
    expect(resumeDecision(baseRecord)).toBeNull();
  });

  test("marker with a session id resumes it with a continuation prompt", () => {
    const decision = resumeDecision({ ...baseRecord, sessionId: "sess-1", activeTurn: marker });
    expect(decision?.kind).toBe("resume");
    if (decision?.kind !== "resume") throw new Error("expected resume");
    expect(decision.sessionId).toBe("sess-1");
    expect(decision.prompt).toContain("ship the thing");
    expect(decision.prompt).not.toBe("ship the thing");
    expect(decision.marker.resumeCount).toBe(1);
  });

  test("marker without a session id replays the original prompt fresh", () => {
    const decision = resumeDecision({ ...baseRecord, activeTurn: marker });
    if (decision?.kind !== "resume") throw new Error("expected resume");
    expect(decision.sessionId).toBeNull();
    expect(decision.prompt).toBe("ship the thing");
    expect(decision.marker.resumeCount).toBe(1);
  });

  test("gives up at the retry cap, never below it", () => {
    const nearCap = resumeDecision({ ...baseRecord, activeTurn: { ...marker, resumeCount: MAX_TURN_RESUMES - 1 } });
    expect(nearCap?.kind).toBe("resume");
    const atCap = resumeDecision({ ...baseRecord, activeTurn: { ...marker, resumeCount: MAX_TURN_RESUMES } });
    expect(atCap?.kind).toBe("give-up");
  });
});
