import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeCredentials, freshHome, HOUR_MS, pooledClaude, serveTogether } from "./fixtures.ts";

const home = freshHome();
process.env.TOKENMAXXING_CLAUDE_SETTINGS = join(home, "claude-settings.json");
process.env.TOKENMAXXING_SYSTEMD_USER_DIR = join(home, "systemd");
process.env.TOKENMAXXING_LAUNCHD_DIR = join(home, "launchd");

const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
const tokenOf = (id: string) => `token-${id}`;
const bearers = ids.map((id) => `Bearer ${tokenOf(id)}`);
const stub = serveTogether({
  keys: bearers,
  keyOf: (req) => req.headers.get("authorization") ?? "",
  respond: (req) => {
    const id = ids.find((x) => req.headers.get("authorization") === `Bearer ${tokenOf(x)}`) ?? "unknown";
    return { account: { uuid: id, email: `${id}@example.com` }, organization: { uuid: "org-test", name: null } };
  },
});
process.env.TOKENMAXXING_OAUTH_PROFILE_URL = `${stub.base}/profile`;

const { claudePool, storeDirFor } = await import("../src/lib/paths.ts");
const { saveAccounts } = await import("../src/lib/state.ts");
const { cmdDoctor } = await import("../src/cli/doctor.ts");

describe("doctor", () => {
  test("starts every store's identity check before any answers, and prints the results in pool order", async () => {
    saveAccounts(claudePool, { version: 2, accounts: ids.map(pooledClaude) });
    for (const id of ids) {
      mkdirSync(storeDirFor(id), { recursive: true });
      writeFileSync(join(storeDirFor(id), ".credentials.json"), claudeCredentials(tokenOf(id), Date.now() + HOUR_MS), { mode: 0o600 });
    }
    const printed: string[] = [];
    const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      printed.push(args.map(String).join(" "));
    });
    try {
      await cmdDoctor();
    } finally {
      log.mockRestore();
      stub.stop();
    }

    expect(stub.arrived.toSorted()).toEqual(bearers.toSorted());
    const verdicts = ids.map((id) => printed.findIndex((line) => line.includes(`store credential identity matches ${id}`)));
    expect(verdicts.every((i) => i >= 0)).toBe(true);
    expect(verdicts).toEqual(verdicts.toSorted((a, b) => a - b));
    expect(verdicts.every((i) => printed[i]?.includes("✓"))).toBe(true);
  });
});
