import { describe, expect, test } from "bun:test"

import {
  CliStatusResponse,
  SubmitPayload,
  SubmitResponse,
  UsageRecord,
  formatTokens,
  totalTokens,
} from "@tokenmaxxing/shared/types"

const validRecord = {
  client: "claude-code" as const,
  model: "claude-opus-4-6",
  sessionHash: "a".repeat(64),
  timestamp: "2026-03-15T12:00:00Z",
  tokens: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 100, reasoning: 50 },
  costUsd: 0.15,
}

describe("UsageRecord", () => {
  test("parses a valid record", () => {
    const parsed = UsageRecord.parse(validRecord)
    expect(parsed.client).toBe("claude-code")
    expect(parsed.tokens.input).toBe(1000)
    expect(parsed.project).toBeUndefined()
  })

  test("accepts optional project field", () => {
    const parsed = UsageRecord.parse({ ...validRecord, project: "my-repo" })
    expect(parsed.project).toBe("my-repo")
  })

  test("strips project when not provided", () => {
    const parsed = UsageRecord.parse(validRecord)
    expect(parsed).not.toHaveProperty("project")
  })

  test("rejects unsupported client", () => {
    expect(() => UsageRecord.parse({ ...validRecord, client: "unknown-tool" })).toThrow()
  })

  test("rejects short session hash", () => {
    expect(() => UsageRecord.parse({ ...validRecord, sessionHash: "abc" })).toThrow()
  })
})

describe("SubmitPayload", () => {
  test("accepts 1-500 records", () => {
    const parsed = SubmitPayload.parse({ records: [validRecord] })
    expect(parsed.records).toHaveLength(1)
  })

  test("rejects empty records array", () => {
    expect(() => SubmitPayload.parse({ records: [] })).toThrow()
  })
})

describe("formatTokens", () => {
  test("formats billions", () => { expect(formatTokens(2_400_000_000)).toBe("2.4B") })
  test("formats millions", () => { expect(formatTokens(150_000_000)).toBe("150.0M") })
  test("formats thousands", () => { expect(formatTokens(42_000)).toBe("42K") })
  test("formats small numbers", () => { expect(formatTokens(999)).toBe("999") })
})

describe("totalTokens", () => {
  test("sums all token types", () => {
    expect(totalTokens(validRecord.tokens)).toBe(1850)
  })
})

describe("SubmitResponse", () => {
  test("parses a valid submit response", () => {
    const parsed = SubmitResponse.parse({
      inserted: 12,
      skipped: 3,
      total: 15,
    })

    expect(parsed.inserted).toBe(12)
    expect(parsed.skipped).toBe(3)
    expect(parsed.total).toBe(15)
  })

  test("rejects an invalid submit response", () => {
    expect(() =>
      SubmitResponse.parse({
        inserted: "12",
        skipped: 3,
        total: 15,
      })
    ).toThrow()
  })
})

describe("CliStatusResponse", () => {
  test("parses the CLI status contract from /api/me", () => {
    const parsed = CliStatusResponse.parse({
      user: {
        username: "sc",
        avatarUrl: null,
        totalTokens: 1234,
        totalCost: "12.3400",
        streak: 4,
        longestStreak: 7,
      },
      ranks: {
        global: { rank: 9 },
      },
      recentActivity: [],
    })

    expect(parsed.user.username).toBe("sc")
    expect(parsed.user.totalTokens).toBe(1234)
    expect(parsed.user.totalCost).toBe(12.34)
    expect(parsed.ranks.global?.rank).toBe(9)
    expect(parsed.user).not.toHaveProperty("avatarUrl")
    expect(parsed).not.toHaveProperty("recentActivity")
  })

  test("allows an unranked user", () => {
    const parsed = CliStatusResponse.parse({
      user: {
        username: "sc",
        totalTokens: 0,
        totalCost: "0",
        streak: 0,
        longestStreak: 0,
      },
      ranks: {
        global: null,
      },
    })

    expect(parsed.ranks.global).toBeNull()
  })

  test("rejects an invalid status response", () => {
    expect(() =>
      CliStatusResponse.parse({
        user: {
          username: "sc",
          totalTokens: "1234",
          totalCost: "12.3400",
          streak: 4,
          longestStreak: 7,
        },
        ranks: {
          global: { rank: 9 },
        },
      })
    ).toThrow()
  })

  test("rejects a non-numeric total cost", () => {
    expect(() =>
      CliStatusResponse.parse({
        user: {
          username: "sc",
          totalTokens: 1234,
          totalCost: "abc",
          streak: 4,
          longestStreak: 7,
        },
        ranks: {
          global: { rank: 9 },
        },
      })
    ).toThrow()
  })
})
