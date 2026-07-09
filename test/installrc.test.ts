import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensurePathInRc, shellRcPath } from "../src/lib/install.ts";
import { paths } from "../src/lib/paths.ts";

const base = (globalThis as { __TM_TEST_BASE__?: string }).__TM_TEST_BASE__!;

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
