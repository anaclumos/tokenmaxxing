import { describe, expect, test } from "bun:test"

import { CliStatusResponse, SubmitResponse } from "@tokenmaxxing/shared/types"

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
