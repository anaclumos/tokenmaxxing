import { describe, expect, test } from "bun:test";

import { buildLocalWrappedData } from "./wrapped-data";

const records = [
  {
    client: "codex" as const,
    model: "gpt-5",
    sessionHash: "a".repeat(64),
    timestamp: "2025-01-01T09:00:00Z",
    tokens: {
      input: 100,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 5,
    },
    costUsd: 1.25,
  },
  {
    client: "codex" as const,
    model: "gpt-5",
    sessionHash: "b".repeat(64),
    timestamp: "2025-01-02T09:00:00Z",
    tokens: {
      input: 60,
      output: 10,
      cacheRead: 10,
      cacheWrite: 0,
      reasoning: 0,
    },
    costUsd: 0.8,
  },
  {
    client: "claude-code" as const,
    model: "claude-opus",
    sessionHash: "c".repeat(64),
    timestamp: "2025-01-04T09:00:00Z",
    tokens: {
      input: 80,
      output: 40,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
    },
    costUsd: 2.5,
  },
  {
    client: "codex" as const,
    model: "gpt-5",
    sessionHash: "d".repeat(64),
    timestamp: "2024-12-30T09:00:00Z",
    tokens: {
      input: 500,
      output: 500,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
    },
    costUsd: 9,
  },
];

describe("buildLocalWrappedData", () => {
  test("returns null when the target year has no records", () => {
    const data = buildLocalWrappedData({
      records,
      username: "sc",
      year: 2023,
    });

    expect(data).toBeNull();
  });

  test("builds wrapped data from the selected year only", () => {
    const data = buildLocalWrappedData({
      records,
      username: "sc",
      year: 2025,
    });

    expect(data).not.toBeNull();
    expect(data?.username).toBe("sc");
    expect(data?.year).toBe(2025);
    expect(data?.messages).toBe(3);
    expect(data?.activeDays).toBe(3);
    expect(data?.longestStreak).toBe(2);
    expect(data?.totalTokens).toBe(325);
    expect(data?.totalCost).toBeCloseTo(4.55, 2);
    expect(data?.topClients).toEqual(["codex", "claude-code"]);
    expect(data?.topModels).toEqual(["gpt-5", "claude-opus"]);
    expect(data?.activityMap.get("2025-01-01")).toBe(125);
    expect(data?.activityMap.get("2025-01-02")).toBe(80);
    expect(data?.activityMap.get("2025-01-04")).toBe(120);
  });
});
