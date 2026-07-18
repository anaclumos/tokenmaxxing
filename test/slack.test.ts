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
  test("strips one leading mention token and trims", () => {
    expect(stripLeadingMention("<@U0123> fix the tests")).toBe("fix the tests");
    expect(stripLeadingMention("  <@U0123>   fix ")).toBe("fix");
    expect(stripLeadingMention("no mention here")).toBe("no mention here");
    expect(stripLeadingMention("<@U0123 unclosed")).toBe("<@U0123 unclosed");
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
