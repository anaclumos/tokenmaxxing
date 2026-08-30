import { describe, expect, test } from "bun:test";
import { planAuth, pickerOrder } from "../src/cli/auth.ts";
import type { Account } from "../src/lib/types.ts";

function account(input: { uuid: string; email: string; label?: string; needsReauth?: boolean }): Account {
  return {
    accountUuid: input.uuid,
    email: input.email,
    organizationUuid: `org-${input.uuid}`,
    label: input.label ?? input.email,
    keychainItem: `tokenmaxxing-cred-${input.uuid.slice(0, 8)}`,
    oauthAccount: {
      accountUuid: input.uuid,
      emailAddress: input.email,
      organizationUuid: `org-${input.uuid}`,
    },
    addedAt: "2026-07-01T00:00:00.000Z",
    needsReauth: input.needsReauth,
  };
}

const dell = account({ uuid: "11111111-aaaa", email: "dell@example.com", label: "dell", needsReauth: true });
const mini = account({ uuid: "22222222-bbbb", email: "mini@example.com", label: "mini" });
const dead = account({ uuid: "33333333-cccc", email: "dead@example.com", label: "dead", needsReauth: true });
const pool = [mini, dell, dead];

describe("planAuth", () => {
  test("bare argv asks interactively", () => {
    expect(planAuth({ accounts: pool, argv: [] })).toEqual({ kind: "pick" });
  });

  test("--all targets exactly the needs-reauth accounts, pool order", () => {
    const plan = planAuth({ accounts: pool, argv: ["--all"] });
    expect(plan).toEqual({ kind: "targets", uuids: [dell.accountUuid, dead.accountUuid] });
  });

  test("--all with a healthy pool targets nothing", () => {
    const plan = planAuth({ accounts: [mini], argv: ["--all"] });
    expect(plan).toEqual({ kind: "targets", uuids: [] });
  });

  test("selector resolves by label, email, and uuid prefix", () => {
    for (const sel of ["dell", "dell@example.com", "11111111"]) {
      expect(planAuth({ accounts: pool, argv: [sel] })).toEqual({ kind: "targets", uuids: [dell.accountUuid] });
    }
  });

  test("selector works on a healthy account too", () => {
    expect(planAuth({ accounts: pool, argv: ["mini"] })).toEqual({ kind: "targets", uuids: [mini.accountUuid] });
  });

  test("unknown selector errors", () => {
    const plan = planAuth({ accounts: pool, argv: ["nope"] });
    expect(plan.kind).toBe("error");
  });

  test("an empty pool errors even with --all", () => {
    expect(planAuth({ accounts: [], argv: [] }).kind).toBe("error");
    expect(planAuth({ accounts: [], argv: ["--all"] }).kind).toBe("error");
  });

  test("--all plus a selector is a usage error, before any pool state", () => {
    expect(planAuth({ accounts: pool, argv: ["dell", "--all"] })).toEqual({ kind: "usage" });
    expect(planAuth({ accounts: [], argv: ["dell", "--all"] })).toEqual({ kind: "usage" });
  });

  test("two selectors are a usage error", () => {
    expect(planAuth({ accounts: pool, argv: ["dell", "mini"] })).toEqual({ kind: "usage" });
  });
});

describe("pickerOrder", () => {
  test("needs-reauth accounts list first, pool order within each group", () => {
    expect(pickerOrder(pool).map((a) => a.label)).toEqual(["dell", "dead", "mini"]);
  });
});
