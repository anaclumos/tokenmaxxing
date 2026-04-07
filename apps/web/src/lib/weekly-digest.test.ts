import { describe, expect, test } from "bun:test";

import {
  formatWeekOverWeekChange,
  getWeeklyDigestUnsubscribeToken,
  getWeeklyDigestUnsubscribeUrl,
  getWeeklyDigestWindows,
  verifyWeeklyDigestUnsubscribeToken,
} from "./weekly-digest";

describe("getWeeklyDigestWindows", () => {
  test("uses the most recent completed Monday-through-Sunday week", () => {
    const { current, previous } = getWeeklyDigestWindows({
      now: new Date("2026-04-08T12:30:00Z"),
    });

    expect(current.startDate).toBe("2026-03-30");
    expect(current.endDate).toBe("2026-04-06");
    expect(current.label).toBe("Mar 30 - Apr 5");

    expect(previous.startDate).toBe("2026-03-23");
    expect(previous.endDate).toBe("2026-03-30");
    expect(previous.label).toBe("Mar 23 - Mar 29");
  });
});

describe("formatWeekOverWeekChange", () => {
  test("handles positive deltas", () => {
    expect(formatWeekOverWeekChange({ current: 15, previous: 10 })).toBe("+50% vs previous week");
  });

  test("handles new activity", () => {
    expect(formatWeekOverWeekChange({ current: 10, previous: 0 })).toBe("new vs previous week");
  });

  test("handles flat weeks", () => {
    expect(formatWeekOverWeekChange({ current: 0, previous: 0 })).toBe("flat vs previous week");
  });
});

describe("weekly digest unsubscribe links", () => {
  test("signs and verifies unsubscribe tokens", () => {
    const secret = "test-secret";
    const userId = "9d881a6a-0d5b-4d1a-a7eb-68fb912807e7";
    const token = getWeeklyDigestUnsubscribeToken({ secret, userId });

    expect(verifyWeeklyDigestUnsubscribeToken({ secret, token, userId })).toBe(true);
    expect(verifyWeeklyDigestUnsubscribeToken({ secret, token: `${token}x`, userId })).toBe(false);
    expect(
      getWeeklyDigestUnsubscribeUrl({
        origin: "https://tokenmaxx.ing",
        secret,
        userId,
      }),
    ).toBe(
      `https://tokenmaxx.ing/api/settings/weekly-digest/unsubscribe?user=${userId}&token=${token}`,
    );
  });
});
