import { describe, expect, test } from "bun:test";

import { summarizeDailyAggregateRows } from "./daily-aggregate-summary";

describe("summarizeDailyAggregateRows", () => {
  test("summarizes totals, sets, and activity consistently", () => {
    const summary = summarizeDailyAggregateRows({
      rows: [
        {
          date: "2025-01-01",
          totalInput: 100,
          totalOutput: 20,
          totalCacheRead: 30,
          totalCacheWrite: 0,
          totalReasoning: 5,
          modelsUsed: ["gpt-5", "gpt-4.1"],
          clientsUsed: ["codex"],
        },
        {
          date: "2025-01-02",
          totalInput: 40,
          totalOutput: 10,
          totalCacheRead: 10,
          totalCacheWrite: 5,
          totalReasoning: 0,
          modelsUsed: ["gpt-5", "claude-opus"],
          clientsUsed: ["codex", "claude-code"],
        },
      ],
    });

    expect(summary.breakdown).toEqual({
      input: 140,
      output: 30,
      cacheRead: 40,
      cacheWrite: 5,
      reasoning: 5,
    });
    expect(summary.totalTokens).toBe(220);
    expect(summary.cachePool).toBe(180);
    expect(summary.cacheHitRate).toBeCloseTo(22.2222, 4);
    expect(summary.models).toEqual(["claude-opus", "gpt-4.1", "gpt-5"]);
    expect(summary.clients).toEqual(["claude-code", "codex"]);
    expect(summary.activeDays).toBe(2);
    expect(summary.activity).toEqual([
      { date: "2025-01-01", tokens: 155 },
      { date: "2025-01-02", tokens: 65 },
    ]);
    expect(summary.activityMap.get("2025-01-01")).toBe(155);
    expect(summary.activityMap.get("2025-01-02")).toBe(65);
  });
});
