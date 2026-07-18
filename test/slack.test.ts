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
  test("strips one leading mention token and trims", () => {
    expect(stripLeadingMention("<@U0123> fix the tests")).toBe("fix the tests");
    expect(stripLeadingMention("  <@U0123>   fix ")).toBe("fix");
    expect(stripLeadingMention("no mention here")).toBe("no mention here");
    expect(stripLeadingMention("<@U0123 unclosed")).toBe("<@U0123 unclosed");
  });

  test("both Slack slash-command arrival forms land the command at position 0", () => {
    // Slack's composer eats bare "/cmd" client-side (never delivered); the
    // two forms that DO post are mention-first and Slack's own leading-space
    // workaround. Both must normalize so the CLI parses the slash command.
    expect(stripLeadingMention("<@U0123> /usage")).toBe("/usage");
    expect(stripLeadingMention(" /usage")).toBe("/usage");
    expect(stripLeadingMention("<@U0123> /goal ship the feature")).toBe("/goal ship the feature");
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
