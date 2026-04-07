import { describe, expect, test } from "bun:test";

import { getEarnedBadges, getFeaturedBadge, getFeaturedBadgeValue } from "./badges";

describe("getEarnedBadges", () => {
  test("returns no badges for an empty profile", () => {
    expect(
      getEarnedBadges({
        context: {
          totalTokens: 0,
          longestStreak: 0,
          clientCount: 0,
          modelCount: 0,
          cacheHitRate: 0,
          activeDays: 0,
        },
      }),
    ).toEqual([]);
  });

  test("returns the expected deterministic badge shelf", () => {
    const badges = getEarnedBadges({
      context: {
        totalTokens: 1_250_000_000,
        longestStreak: 14,
        clientCount: 4,
        modelCount: 12,
        cacheHitRate: 58.2,
        activeDays: 31,
      },
    });

    expect(badges.map((badge) => badge.id)).toEqual([
      "first-submit",
      "power-week",
      "marathon-month",
      "streak-7",
      "multi-client",
      "model-explorer",
      "efficient",
      "billion-club",
    ]);
    expect(badges[0]?.tone).toBe("sky");
    expect(badges[0]?.icon).toBe("upload");
    expect(badges.at(-1)?.tone).toBe("amber");
    expect(badges.at(-1)?.icon).toBe("medal");
  });

  test("returns the most advanced earned badge as the featured badge", () => {
    const badge = getFeaturedBadge({
      context: {
        totalTokens: 11_000_000_000,
        longestStreak: 31,
        clientCount: 4,
        modelCount: 12,
        cacheHitRate: 58.2,
        activeDays: 31,
      },
    });

    expect(badge?.id).toBe("ten-billion-club");
    expect(badge?.mark).toBe("10B");
    expect(badge?.icon).toBe("crown");
  });

  test("returns the featured badge name or mark deterministically", () => {
    const context = {
      totalTokens: 1_250_000_000,
      longestStreak: 14,
      clientCount: 4,
      modelCount: 12,
      cacheHitRate: 58.2,
      activeDays: 31,
    };

    expect(getFeaturedBadgeValue({ context, format: "name" })).toBe("1B Club");
    expect(getFeaturedBadgeValue({ context, format: "mark" })).toBe("1B");
  });
});
