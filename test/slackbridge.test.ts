// cleanupThread: the finish_thread garbage collector. Hermetic real-git
// fixtures under the sandboxed TOKENMAXXING_HOME (test/setup.ts); the safety
// gates under test are git's own (worktree remove refuses dirty, branch -d
// refuses unmerged), so mocking git would test nothing.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupThread, ensureThreadCwd } from "../src/lib/slackbridge.ts";
import { SlackLinkSchema, loadSlackThread, saveSlackThread, threadKey } from "../src/lib/slackstate.ts";
import { paths } from "../src/lib/paths.ts";

function run(cwd: string, args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(r.stderr)}`);
  return new TextDecoder().decode(r.stdout).trim();
}

function makeRepo(name: string): string {
  const repo = join(paths.home, "gc-fixtures", name);
  mkdirSync(repo, { recursive: true });
  run(repo, ["init"]);
  run(repo, ["config", "user.email", "t@t.invalid"]);
  run(repo, ["config", "user.name", "t"]);
  run(repo, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(repo, "readme.md"), "fixture\n");
  run(repo, ["add", "."]);
  run(repo, ["commit", "-m", "init"]);
  return repo;
}

function makeThread(input: { name: string; worktree?: boolean }) {
  const repo = makeRepo(input.name);
  const link = SlackLinkSchema.parse({ channel: "C0GCTEST", repo, worktree: input.worktree ?? true });
  const threadId = `slack:C0GCTEST:${input.name}`;
  const cwd = ensureThreadCwd({ link, threadId });
  saveSlackThread({ threadId, repo, cwd, sessionId: null, createdAt: new Date().toISOString() });
  return { repo, link, threadId, cwd, branch: `tm-slack-${threadKey(threadId)}` };
}

function branchExists(repo: string, branch: string): boolean {
  return run(repo, ["branch", "--list", branch]) !== "";
}

describe("cleanupThread", () => {
  test("clean worktree: removes worktree, branch, and record", () => {
    const t = makeThread({ name: "clean" });
    const out = cleanupThread({ link: t.link, threadId: t.threadId, cwd: t.cwd });
    expect(out.removed).toBe(true);
    expect(existsSync(t.cwd)).toBe(false);
    expect(branchExists(t.repo, t.branch)).toBe(false);
    expect(loadSlackThread(t.threadId)).toBeNull();
    expect(out.message).toContain("worktree removed");
  });

  test("dirty worktree refuses: uncommitted work is never discarded", () => {
    const t = makeThread({ name: "dirty" });
    writeFileSync(join(t.cwd, "scratch.txt"), "uncommitted\n");
    const out = cleanupThread({ link: t.link, threadId: t.threadId, cwd: t.cwd });
    expect(out.removed).toBe(false);
    expect(out.message).toContain("commit or push");
    expect(existsSync(join(t.cwd, "scratch.txt"))).toBe(true);
    expect(branchExists(t.repo, t.branch)).toBe(true);
    expect(loadSlackThread(t.threadId)).not.toBeNull();
  });

  test("committed-but-unmerged branch is kept, worktree and record still go", () => {
    const t = makeThread({ name: "unmerged" });
    writeFileSync(join(t.cwd, "work.md"), "real work\n");
    run(t.cwd, ["config", "user.email", "t@t.invalid"]);
    run(t.cwd, ["config", "user.name", "t"]);
    run(t.cwd, ["config", "commit.gpgsign", "false"]);
    run(t.cwd, ["add", "."]);
    run(t.cwd, ["commit", "-m", "unmerged work"]);
    const out = cleanupThread({ link: t.link, threadId: t.threadId, cwd: t.cwd });
    expect(out.removed).toBe(true);
    expect(existsSync(t.cwd)).toBe(false);
    expect(branchExists(t.repo, t.branch)).toBe(true);
    expect(out.message).toContain("kept");
    expect(loadSlackThread(t.threadId)).toBeNull();
  });

  test("worktree dir deleted by hand: prunes the registration, still collects", () => {
    const t = makeThread({ name: "handgone" });
    rmSync(t.cwd, { recursive: true, force: true });
    const out = cleanupThread({ link: t.link, threadId: t.threadId, cwd: t.cwd });
    expect(out.removed).toBe(true);
    expect(out.message).toContain("already gone");
    expect(branchExists(t.repo, t.branch)).toBe(false);
    expect(loadSlackThread(t.threadId)).toBeNull();
  });

  test("in-place link: only the record is dropped, the repo is untouched", () => {
    const t = makeThread({ name: "inplace", worktree: false });
    expect(t.cwd).toBe(t.repo);
    const out = cleanupThread({ link: t.link, threadId: t.threadId, cwd: t.cwd });
    expect(out.removed).toBe(true);
    expect(existsSync(join(t.repo, "readme.md"))).toBe(true);
    expect(out.message).not.toContain("worktree");
    expect(loadSlackThread(t.threadId)).toBeNull();
  });

  test("worktree link whose record cwd is the repo itself never touches git", () => {
    const repo = makeRepo("drifted");
    const link = SlackLinkSchema.parse({ channel: "C0GCTEST", repo, worktree: true });
    const threadId = "slack:C0GCTEST:drifted";
    saveSlackThread({ threadId, repo, cwd: repo, sessionId: null, createdAt: new Date().toISOString() });
    const out = cleanupThread({ link, threadId, cwd: repo });
    expect(out.removed).toBe(true);
    expect(existsSync(join(repo, "readme.md"))).toBe(true);
    expect(loadSlackThread(threadId)).toBeNull();
  });
});
