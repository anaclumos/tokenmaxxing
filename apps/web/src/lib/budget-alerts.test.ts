import { describe, expect, test } from "bun:test";

import {
  getBudgetAlertEmailRecipients,
  getTriggeredBudgetAlertEvents,
  groupBudgetAlertBuckets,
} from "./budget-alerts";

describe("groupBudgetAlertBuckets", () => {
  test("groups weekly records into Monday UTC buckets", () => {
    const buckets = groupBudgetAlertBuckets({
      period: "weekly",
      records: [
        { timestamp: new Date("2026-04-07T12:00:00Z"), costUsd: 4 },
        { timestamp: new Date("2026-04-09T09:00:00Z"), costUsd: 6 },
      ],
    });

    expect([...buckets.keys()]).toEqual(["2026-04-06"]);
    expect(buckets.get("2026-04-06")?.cost).toBe(10);
  });
});

describe("getTriggeredBudgetAlertEvents", () => {
  test("fires when a threshold is crossed", () => {
    const insertedBuckets = groupBudgetAlertBuckets({
      period: "daily",
      records: [{ timestamp: new Date("2026-04-08T12:00:00Z"), costUsd: 25 }],
    });
    const currentBuckets = groupBudgetAlertBuckets({
      period: "daily",
      records: [
        { timestamp: new Date("2026-04-08T08:00:00Z"), costUsd: 90 },
        { timestamp: new Date("2026-04-08T12:00:00Z"), costUsd: 25 },
      ],
    });

    expect(
      getTriggeredBudgetAlertEvents({
        alert: {
          id: "alert_1",
          orgId: "org_1",
          userId: "user_1",
          period: "daily",
          thresholdUsd: 100,
        },
        currentBuckets,
        insertedBuckets,
      }),
    ).toEqual([{ alertId: "alert_1", actualCost: 115, thresholdCost: 100 }]);
  });

  test("does not fire when already over the threshold", () => {
    const insertedBuckets = groupBudgetAlertBuckets({
      period: "monthly",
      records: [{ timestamp: new Date("2026-04-12T12:00:00Z"), costUsd: 15 }],
    });
    const currentBuckets = groupBudgetAlertBuckets({
      period: "monthly",
      records: [
        { timestamp: new Date("2026-04-02T08:00:00Z"), costUsd: 120 },
        { timestamp: new Date("2026-04-12T12:00:00Z"), costUsd: 15 },
      ],
    });

    expect(
      getTriggeredBudgetAlertEvents({
        alert: {
          id: "alert_2",
          orgId: "org_1",
          userId: null,
          period: "monthly",
          thresholdUsd: 100,
        },
        currentBuckets,
        insertedBuckets,
      }),
    ).toEqual([]);
  });
});

describe("getBudgetAlertEmailRecipients", () => {
  test("includes org admins and the member for member-scoped alerts", () => {
    expect(
      getBudgetAlertEmailRecipients({
        event: {
          orgId: "org_1",
          userId: "user_1",
        },
        orgAdminEmailsByOrg: new Map([["org_1", ["admin@example.com"]]]),
        userById: new Map([
          [
            "user_1",
            {
              username: "alice",
              email: "alice@example.com",
            },
          ],
        ]),
      }),
    ).toEqual(["admin@example.com", "alice@example.com"]);
  });

  test("dedupes recipients when the member is also an admin", () => {
    expect(
      getBudgetAlertEmailRecipients({
        event: {
          orgId: "org_1",
          userId: "user_1",
        },
        orgAdminEmailsByOrg: new Map([["org_1", ["alice@example.com"]]]),
        userById: new Map([
          [
            "user_1",
            {
              username: "alice",
              email: "alice@example.com",
            },
          ],
        ]),
      }),
    ).toEqual(["alice@example.com"]);
  });

  test("uses org admins only for org-wide alerts", () => {
    expect(
      getBudgetAlertEmailRecipients({
        event: {
          orgId: "org_1",
          userId: null,
        },
        orgAdminEmailsByOrg: new Map([["org_1", ["admin@example.com"]]]),
        userById: new Map(),
      }),
    ).toEqual(["admin@example.com"]);
  });
});
