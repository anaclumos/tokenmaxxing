// `xx serve` slack state: config schema, channel-id/thread-key structure,
// link edits, mention stripping, and the fail-fast slack.json contract.

import { describe, expect, test } from "bun:test";
import { rmSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  SlackConfigSchema,
  bareChannelId,
  isChannelId,
  linkForChannel,
  loadSlackConfig,
  loadSlackThread,
  removeLink,
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

describe("thread records", () => {
  test("round-trip by thread id", () => {
    const record = {
      threadId: "slack:C0123:1721.456",
      repo: "/tmp/repo",
      cwd: "/tmp/repo",
      sessionId: null,
      createdAt: "2026-07-18T00:00:00.000Z",
    };
    saveSlackThread(record);
    const loaded = loadSlackThread(record.threadId);
    expect(loaded?.cwd).toBe("/tmp/repo");
    expect(loaded?.sessionId).toBeNull();
  });
});
