// cleanupThread: the finish_thread garbage collector. Hermetic real-git
// fixtures under the sandboxed TOKENMAXXING_HOME (test/setup.ts); the gates
// under test are the residue check (stricter than git: ignored files refuse
// too) plus git's own branch -d refusal, so mocking git would test nothing.

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
  writeFileSync(join(repo, ".gitignore"), "ignored.txt\n");
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
    const out = cleanupThread({ threadId: t.threadId, cwd: t.cwd, repo: t.repo });
    expect(out.removed).toBe(true);
    expect(existsSync(t.cwd)).toBe(false);
    expect(branchExists(t.repo, t.branch)).toBe(false);
    expect(loadSlackThread(t.threadId)).toBeNull();
    expect(out.message).toContain("worktree removed");
  });

  test("dirty worktree refuses and lists the residue", () => {
    const t = makeThread({ name: "dirty" });
    writeFileSync(join(t.cwd, "scratch.txt"), "uncommitted\n");
    const out = cleanupThread({ threadId: t.threadId, cwd: t.cwd, repo: t.repo });
    expect(out.removed).toBe(false);
    expect(out.message).toContain("scratch.txt");
    expect(out.message).toContain("say finish again");
    expect(existsSync(join(t.cwd, "scratch.txt"))).toBe(true);
    expect(branchExists(t.repo, t.branch)).toBe(true);
    expect(loadSlackThread(t.threadId)).not.toBeNull();
  });

  test("gitignored residue refuses too: nothing outside git is discarded", () => {
    const t = makeThread({ name: "ignored" });
    writeFileSync(join(t.cwd, "ignored.txt"), "would be silently destroyed\n");
    const out = cleanupThread({ threadId: t.threadId, cwd: t.cwd, repo: t.repo });
    expect(out.removed).toBe(false);
    expect(out.message).toContain("ignored.txt");
    expect(existsSync(join(t.cwd, "ignored.txt"))).toBe(true);
    expect(loadSlackThread(t.threadId)).not.toBeNull();
  });

  test("unmerged branch is archived off the canonical name; revival cuts fresh from HEAD", () => {
    const t = makeThread({ name: "unmerged" });
    writeFileSync(join(t.cwd, "work.md"), "real work\n");
    run(t.cwd, ["config", "user.email", "t@t.invalid"]);
    run(t.cwd, ["config", "user.name", "t"]);
    run(t.cwd, ["config", "commit.gpgsign", "false"]);
    run(t.cwd, ["add", "."]);
    run(t.cwd, ["commit", "-m", "unmerged work"]);
    const tip = run(t.cwd, ["rev-parse", "--short", "HEAD"]);
    const out = cleanupThread({ threadId: t.threadId, cwd: t.cwd, repo: t.repo });
    expect(out.removed).toBe(true);
    expect(existsSync(t.cwd)).toBe(false);
    expect(out.message).toContain("archived as");
    expect(branchExists(t.repo, t.branch)).toBe(false);
    expect(branchExists(t.repo, `${t.branch}-kept-${tip}`)).toBe(true);
    expect(loadSlackThread(t.threadId)).toBeNull();
    // revival regression pin: a fresh mention must NOT resurrect the stale tip.
    const cwd2 = ensureThreadCwd({ link: t.link, threadId: t.threadId });
    expect(run(cwd2, ["rev-parse", "HEAD"])).toBe(run(t.repo, ["rev-parse", "HEAD"]));
  });

  test("worktree dir deleted by hand: prunes the registration, still collects", () => {
    const t = makeThread({ name: "handgone" });
    rmSync(t.cwd, { recursive: true, force: true });
    const out = cleanupThread({ threadId: t.threadId, cwd: t.cwd, repo: t.repo });
    expect(out.removed).toBe(true);
    expect(out.message).toContain("already gone");
    expect(branchExists(t.repo, t.branch)).toBe(false);
    expect(loadSlackThread(t.threadId)).toBeNull();
  });

  test("in-place link: only the record is dropped, the repo is untouched", () => {
    const t = makeThread({ name: "inplace", worktree: false });
    expect(t.cwd).toBe(t.repo);
    const out = cleanupThread({ threadId: t.threadId, cwd: t.cwd, repo: t.repo });
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
    const out = cleanupThread({ threadId, cwd: repo, repo });
    expect(out.removed).toBe(true);
    expect(existsSync(join(repo, "readme.md"))).toBe(true);
    expect(loadSlackThread(threadId)).toBeNull();
  });
});
