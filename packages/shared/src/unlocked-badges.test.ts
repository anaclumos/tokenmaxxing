import { describe, expect, test } from "bun:test";

import { getUnlockedBadges } from "./unlocked-badges";

describe("getUnlockedBadges", () => {
  test("returns newly unlocked badges after projecting inserted records", () => {
    const badges = getUnlockedBadges({
      rows: [
        {
          date: "2025-01-01",
          totalInput: 100,
          totalOutput: 20,
          totalCacheRead: 10,
          totalCacheWrite: 0,
          totalReasoning: 0,
          clientsUsed: ["codex"],
          modelsUsed: ["gpt-5"],
        },
      ],
      records: [
        {
          timestamp: new Date("2025-01-02T10:00:00Z"),
          inputTokens: 30,
          outputTokens: 10,
          cacheReadTokens: 60,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          client: "claude-code",
          model: "claude-opus",
        },
        {
          timestamp: new Date("2025-01-03T10:00:00Z"),
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          client: "cursor",
          model: "gpt-4.1",
        },
      ],
    });

    expect(badges.map((badge) => badge.id)).toEqual(["multi-client"]);
  });

  test("returns no badges when inserted records unlock nothing new", () => {
    const badges = getUnlockedBadges({
      rows: [
        {
          date: "2025-01-01",
          totalInput: 100,
          totalOutput: 20,
          totalCacheRead: 60,
          totalCacheWrite: 0,
          totalReasoning: 0,
          clientsUsed: ["codex", "claude-code", "cursor"],
          modelsUsed: ["gpt-5", "claude-opus", "gpt-4.1"],
        },
      ],
      records: [
        {
          timestamp: new Date("2025-01-02T10:00:00Z"),
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 10,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          client: "codex",
          model: "gpt-5",
        },
      ],
    });

    expect(badges).toEqual([]);
  });
});
