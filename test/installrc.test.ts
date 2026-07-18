import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensurePathInRc, findClaudeShadowers, shellRcPath } from "../src/lib/install.ts";
import { paths } from "../src/lib/paths.ts";

const base = globalThis.__TM_TEST_BASE__!;

describe("shell rc PATH line", () => {
  test("shellRcPath honors the hermetic override", () => {
    expect(shellRcPath()).toBe(join(base, "shellrc"));
  });

  test("creates the rc when absent and writes one marked PATH line", () => {
    const rc = join(base, "rc-fresh");
    rmSync(rc, { force: true });
    expect(ensurePathInRc(rc)).toBe("added");
    const content = readFileSync(rc, "utf8");
    expect(content).toContain("# tokenmaxxing PATH");
    expect(content).toContain(":$PATH\"");
    expect(content.endsWith("\n")).toBe(true);
    expect(existsSync(rc)).toBe(true);
  });

  test("is idempotent: a second call adds nothing", () => {
    const rc = join(base, "rc-idem");
    rmSync(rc, { force: true });
    ensurePathInRc(rc);
    const once = readFileSync(rc, "utf8");
    expect(ensurePathInRc(rc)).toBe("present");
    expect(readFileSync(rc, "utf8")).toBe(once);
  });

  test("a hand-added line for the bin dir counts as present", () => {
    const rc = join(base, "rc-manual");
    writeFileSync(rc, `export PATH="${paths.binDir}:$PATH"\n`);
    expect(ensurePathInRc(rc)).toBe("present");
  });

  test("appends after content that lacks a trailing newline", () => {
    const rc = join(base, "rc-noeol");
    writeFileSync(rc, "alias ll='ls -la'");
    expect(ensurePathInRc(rc)).toBe("added");
    const lines = readFileSync(rc, "utf8").split("\n");
    expect(lines[0]).toBe("alias ll='ls -la'");
    expect(lines[1]).toContain("# tokenmaxxing PATH");
  });
});

describe("findClaudeShadowers", () => {
  test("flags a claude alias and a claude function as shadowing", () => {
    const found = findClaudeShadowers(`alias claude="/opt/other/claude"\nclaude() { command claude "$@"; }\n`);
    expect(found.map((s) => s.kind)).toEqual(["shadow", "shadow"]);
  });

  test("flags cc-style aliases that hardcode an absolute claude path as bypasses", () => {
    const found = findClaudeShadowers(`alias cco="/Users/x/.local/bin/claude --dangerously-skip-permissions"\n`);
    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe("bypass");
    expect(found[0]!.name).toBe("cco");
  });

  test("plain-claude alias bodies are supervised via PATH and not flagged", () => {
    expect(findClaudeShadowers(`alias cc="claude"\nalias cco="claude --dangerously-skip-permissions"\n`)).toHaveLength(0);
  });

  test("lines referencing the wrapper itself, comments, and unrelated aliases are skipped", () => {
    const rc = [
      `# alias claude="/old/claude"`,
      `alias claude="${paths.supervisorLink}"`,
      `alias ll='ls -la'`,
      `alias cloud="/usr/bin/cloudctl"`,
    ].join("\n");
    expect(findClaudeShadowers(rc)).toHaveLength(0);
  });
});
