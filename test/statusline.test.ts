import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderStatusline, type RenderCtx } from "../src/entries/statusline.ts";
import { fmtResetShort } from "../src/cli/render.ts";
import { worktreeName } from "../src/lib/worktree.ts";
import type { Account, AccountsIndex } from "../src/lib/types.ts";

const NOW = 1_783_750_000_000;
const sec = (ms: number) => Math.round(ms / 1000);
const H = 3_600_000;

function acct(over: Partial<Account>): Account {
  return {
    accountUuid: "uuid-x",
    email: "x@e.com",
    organizationUuid: "org-x",
    label: "x",
    keychainItem: "tokenmaxxing-cred-x",
    oauthAccount: { accountUuid: "uuid-x", emailAddress: "x@e.com", organizationUuid: "org-x" },
    addedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function ctx(over: Partial<RenderCtx>): RenderCtx {
  return {
    accounts: { version: 1, activeAccountUuid: null, accounts: [] },
    perModel: {},
    switchModels: ["fable", "opus"],
    threshold: 95,
    worktree: null,
    now: NOW,
    color: false,
    ...over,
  };
}

const fullStdin = {
  model: { id: "claude-fable-5", display_name: "Fable 5" },
  context_window: { used_percentage: 42 },
  cost: { total_lines_added: 156, total_lines_removed: 23 },
  effort: { level: "high" },
  rate_limits: {
    five_hour: { used_percentage: 5, resets_at: sec(NOW + 2 * H + 13 * 60_000) },
    seven_day: { used_percentage: 38, resets_at: sec(NOW + 30 * H) },
  },
};

describe("renderStatusline", () => {
  test("renders one line: infos, active account's windows, parked accounts, blocks double-spaced", () => {
    const accounts: AccountsIndex = {
      version: 1,
      activeAccountUuid: "uuid-sis",
      accounts: [
        acct({
          accountUuid: "uuid-sis",
          label: "sister",
          lastUsage: {
            fiveHour: { usedPercentage: 5, resetsAt: NOW + 2 * H },
            sevenDay: { usedPercentage: 38, resetsAt: NOW + 30 * H },
          },
        }),
        acct({
          accountUuid: "uuid-pri",
          label: "primary",
          lastUsage: {
            fiveHour: { usedPercentage: 1, resetsAt: NOW + H },
            sevenDay: { usedPercentage: 40, resetsAt: NOW + 65 * H },
          },
          lastPerModel: { Fable: { usedPercentage: 67, resetsAt: NOW + 65 * H } },
        }),
      ],
    };
    const out = renderStatusline(fullStdin, ctx({ accounts, perModel: { Fable: { usedPercentage: 26, resetsAt: NOW + 30 * H } } }));
    expect(out).toBe("Fable 5 (high) ctx 42 +156/-23  ◆ F26 2h5 1d38  ◇ F67 2d40");
  });

  test("renders nothing from no stdin, no per-model, no accounts", () => {
    expect(renderStatusline(null, ctx({}))).toBe("");
  });

  test("windows line renders per-model alone when stdin has no rate limits", () => {
    const out = renderStatusline({}, ctx({ perModel: { Fable: { usedPercentage: 26, resetsAt: null } } }));
    expect(out).toBe("◆ F26");
  });

  test("a capacity-constrained model with no fresh per-model sample renders F?", () => {
    const out = renderStatusline(fullStdin, ctx({}));
    expect(out).toBe("Fable 5 (high) ctx 42 +156/-23  ◆ F? 2h5 1d38");
  });

  test("a model outside switchModels never renders the unmeasured marker", () => {
    const stdin = { ...fullStdin, model: { id: "claude-sonnet-5", display_name: "Sonnet 5" } };
    const out = renderStatusline(stdin, ctx({}));
    expect(out).toBe("Sonnet 5 (high) ctx 42 +156/-23  ◆ 2h5 1d38");
  });

  test("an active account with no usable windows anchors as ◆ ?", () => {
    const accounts: AccountsIndex = { version: 1, activeAccountUuid: "uuid-x", accounts: [acct({})] };
    expect(renderStatusline(null, ctx({ accounts }))).toBe("◆ ?");
  });

  test("a linked worktree name leads the info block", () => {
    const out = renderStatusline(fullStdin, ctx({ worktree: "tm-fix-auth" }));
    expect(out).toStartWith("tm-fix-auth Fable 5 (high) ctx 42");
  });

  test("parked accounts render in swap-preference order, exhausted last", () => {
    const accounts: AccountsIndex = {
      version: 1,
      activeAccountUuid: null,
      accounts: [
        acct({
          accountUuid: "uuid-late",
          lastUsage: {
            fiveHour: { usedPercentage: 0, resetsAt: null },
            sevenDay: { usedPercentage: 20, resetsAt: NOW + 80 * H },
          },
        }),
        acct({
          accountUuid: "uuid-hot",
          lastUsage: {
            fiveHour: { usedPercentage: 0, resetsAt: null },
            sevenDay: { usedPercentage: 96, resetsAt: NOW + 90 * H },
          },
        }),
        acct({
          accountUuid: "uuid-soon",
          lastUsage: {
            fiveHour: { usedPercentage: 0, resetsAt: null },
            sevenDay: { usedPercentage: 50, resetsAt: NOW + 10 * H },
          },
        }),
      ],
    };
    expect(renderStatusline(null, ctx({ accounts }))).toBe("◇ 10h50  ◇ 3d20  ◇ 3d96");
  });

  test("adjacent untouched and unsampled parked runs collapse into counted tokens", () => {
    const untouched = (uuid: string) =>
      acct({
        accountUuid: uuid,
        lastUsage: {
          fiveHour: { usedPercentage: 0, resetsAt: NOW + H },
          sevenDay: { usedPercentage: 0, resetsAt: NOW + 100 * H },
        },
      });
    const accounts: AccountsIndex = {
      version: 1,
      activeAccountUuid: null,
      accounts: [
        untouched("uuid-f1"),
        acct({ accountUuid: "uuid-fresh1" }),
        acct({
          accountUuid: "uuid-used",
          lastUsage: {
            fiveHour: { usedPercentage: 1, resetsAt: NOW + H },
            sevenDay: { usedPercentage: 40, resetsAt: NOW + 65 * H },
          },
        }),
        untouched("uuid-f2"),
        acct({ accountUuid: "uuid-fresh2" }),
      ],
    };
    expect(renderStatusline(null, ctx({ accounts }))).toBe("◇ 2d40  ◇ 2 full  ◇ 2 ?");
  });

  test("a lone untouched parked account still renders plain full", () => {
    const accounts: AccountsIndex = {
      version: 1,
      activeAccountUuid: null,
      accounts: [
        acct({
          lastUsage: {
            fiveHour: { usedPercentage: 0, resetsAt: NOW + H },
            sevenDay: { usedPercentage: 0, resetsAt: NOW + 100 * H },
          },
        }),
      ],
    };
    expect(renderStatusline(null, ctx({ accounts }))).toBe("◇ full");
  });

  test("a parked account whose weekly reset passed renders as full", () => {
    const accounts: AccountsIndex = {
      version: 1,
      activeAccountUuid: null,
      accounts: [
        acct({
          label: "stale",
          lastUsage: {
            fiveHour: { usedPercentage: 90, resetsAt: NOW - H },
            sevenDay: { usedPercentage: 80, resetsAt: NOW - H },
          },
        }),
      ],
    };
    const out = renderStatusline(null, ctx({ accounts }));
    // the recorded 80% usage no longer applies: the window already reset
    expect(out).toBe("◇ full");
  });

  test("an account with no sampled usage shows ? and no reset", () => {
    const accounts: AccountsIndex = { version: 1, activeAccountUuid: null, accounts: [acct({ label: "fresh" })] };
    expect(renderStatusline(null, ctx({ accounts }))).toBe("◇ ?");
  });

  test("needs-reauth accounts are marked ✗ and never merge", () => {
    const accounts: AccountsIndex = {
      version: 1,
      activeAccountUuid: null,
      accounts: [acct({ accountUuid: "uuid-b1", needsReauth: true }), acct({ accountUuid: "uuid-b2", needsReauth: true })],
    };
    expect(renderStatusline(null, ctx({ accounts }))).toBe("✗ ?  ✗ ?");
  });

  test("color mode paints percentages bold by severity", () => {
    const accounts: AccountsIndex = {
      version: 1,
      activeAccountUuid: null,
      accounts: [
        acct({
          label: "x",
          lastUsage: {
            fiveHour: { usedPercentage: 0, resetsAt: NOW + H },
            sevenDay: { usedPercentage: 96, resetsAt: NOW + 30 * H },
          },
        }),
      ],
    };
    const out = renderStatusline(null, ctx({ accounts, color: true }));
    expect(out).toContain("\x1b[1m\x1b[31m96\x1b[0m\x1b[0m"); // 95+ used weekly bold red
    expect(out).toContain("\x1b[36m◇\x1b[0m"); // parked marker cyan
  });

  test("the diff's removed count stays unpainted so red only ever means quota", () => {
    const out = renderStatusline(fullStdin, ctx({ color: true }));
    expect(out).toContain("\x1b[0m/-23");
    expect(out).not.toContain("\x1b[31m-23");
  });

  test("null stdin sub-objects do not erase line 1", () => {
    const stdin = {
      model: { display_name: "Fable 5" },
      context_window: null,
      cost: null,
      effort: null,
    };
    expect(renderStatusline(stdin, ctx({ switchModels: [] }))).toBe("Fable 5");
  });

  test("a wrong-shaped stdin field degrades to absent instead of erasing the info block", () => {
    const stdin = { ...fullStdin, effort: "high" };
    const out = renderStatusline(stdin, ctx({ perModel: { Fable: { usedPercentage: 26, resetsAt: NOW + 30 * H } } }));
    expect(out).toBe("Fable 5 ctx 42 +156/-23  ◆ F26 2h5 1d38");
  });

  test("severity tiers switch exactly at 75 and 95 used", () => {
    const at = (u: number) => renderStatusline({ context_window: { used_percentage: u } }, ctx({ color: true }));
    expect(at(74)).toContain("\x1b[1m\x1b[32m74\x1b[0m\x1b[0m"); // green below 75
    expect(at(75)).toContain("\x1b[1m\x1b[33m75\x1b[0m\x1b[0m"); // yellow from 75
    expect(at(94)).toContain("\x1b[1m\x1b[33m94\x1b[0m\x1b[0m");
    expect(at(95)).toContain("\x1b[1m\x1b[31m95\x1b[0m\x1b[0m"); // red from 95
  });
});

describe("fmtResetShort", () => {
  test("formats compact durations", () => {
    expect(fmtResetShort(null, NOW)).toBe("");
    expect(fmtResetShort(NOW - 1, NOW)).toBe("");
    expect(fmtResetShort(NOW + 30_000, NOW)).toBe("1m");
    expect(fmtResetShort(NOW + 45 * 60_000, NOW)).toBe("45m");
    expect(fmtResetShort(NOW + 3 * H + 5 * 60_000, NOW)).toBe("3h");
    expect(fmtResetShort(NOW + 30 * H, NOW)).toBe("1d");
    expect(fmtResetShort(NOW + 6 * 24 * H + 23 * H, NOW)).toBe("6d");
  });

  test("non-empty output always ends in a unit letter, keeping glued tokens parseable", () => {
    for (const ms of [1_000, 30_000, 59_000, 60_000, 45 * 60_000, H, 3 * H + 5 * 60_000, 30 * H, 6 * 24 * H + 23 * H]) {
      const s = fmtResetShort(NOW + ms, NOW);
      expect(s).not.toBe("");
      expect(s).toMatch(/\D$/);
    }
  });
});

describe("worktreeName", () => {
  const base = mkdtempSync(join(tmpdir(), "tm-wt-"));
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  test("a linked worktree (gitdir-pointer .git file) yields its root basename", () => {
    const wt = join(base, "repo-fix");
    mkdirSync(join(wt, "src"), { recursive: true });
    writeFileSync(join(wt, ".git"), "gitdir: /main/.git/worktrees/repo-fix\n");
    expect(worktreeName(wt)).toBe("repo-fix");
    expect(worktreeName(join(wt, "src"))).toBe("repo-fix");
  });

  test("a main checkout (.git directory) yields null", () => {
    const main = join(base, "repo");
    mkdirSync(join(main, ".git"), { recursive: true });
    expect(worktreeName(main)).toBe(null);
  });

  test("a directory outside any repository yields null", () => {
    const bare = join(base, "plain");
    mkdirSync(bare, { recursive: true });
    expect(worktreeName(bare)).toBe(null);
  });

  test("fs errors while walking (path component is a file) yield null instead of throwing", () => {
    const file = join(base, "afile");
    writeFileSync(file, "");
    expect(worktreeName(join(file, "child"))).toBe(null);
  });
});
