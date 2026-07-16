import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  LOOP_DIAGNOSIS,
  WRAP_RATE_MAX,
  WRAP_RATE_WINDOW_MS,
  pointsBackAtUs,
  resolveRealClaude,
  resolveVerifiedClaude,
  scanPathForClaude,
  verifyRealClaude,
  wrapDepth,
  wrapperEntryRateTripped,
} from "../src/lib/claudebin.ts";
import { paths } from "../src/lib/paths.ts";
import { saveConfig } from "../src/lib/state.ts";

const cfg = (claudeBin: string) => ({
  thresholds: { session: 95, weekly: 98 },
  claudeBin,
  policy: { projectionMargin: 0, greedySessionFloor: 50, switchModels: ["fable"], usagePollTtlMs: 90_000, maxWaitMs: 3_600_000 },
});

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

const scratch = join(paths.home, "claudebin-test");
const ORIGINAL_PATH = process.env.PATH;

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  rmSync(scratch, { recursive: true, force: true });
  rmSync(paths.binDir, { recursive: true, force: true });
  rmSync(paths.configJson, { force: true });
  rmSync(join(paths.home, "spawnrate.json"), { force: true });
});

describe("wrapDepth", () => {
  test("unset, garbage, and negative values read as 0", () => {
    expect(wrapDepth({})).toBe(0);
    expect(wrapDepth({ TOKENMAXXING_WRAP_DEPTH: "" })).toBe(0);
    expect(wrapDepth({ TOKENMAXXING_WRAP_DEPTH: "bogus" })).toBe(0);
    expect(wrapDepth({ TOKENMAXXING_WRAP_DEPTH: "-2" })).toBe(0);
  });
  test("a numeric depth reads through", () => {
    expect(wrapDepth({ TOKENMAXXING_WRAP_DEPTH: "3" })).toBe(3);
  });
});

describe("pointsBackAtUs / resolveRealClaude identity guard", () => {
  test("a claudeBin pinned to the installed wrapper throws instead of recursing", () => {
    mkdirSync(paths.binDir, { recursive: true });
    writeExecutable(paths.supervisorLink, "#!/bin/sh\nexit 0\n");
    saveConfig(cfg(paths.supervisorLink));
    expect(pointsBackAtUs(paths.supervisorLink)).toBe(true);
    expect(() => resolveRealClaude()).toThrow(/own wrapper/);
  });

  test("a symlink from elsewhere into binDir is still recognized as us", () => {
    mkdirSync(paths.binDir, { recursive: true });
    mkdirSync(scratch, { recursive: true });
    writeExecutable(paths.supervisorLink, "#!/bin/sh\nexit 0\n");
    const link = join(scratch, "claude");
    symlinkSync(paths.supervisorLink, link);
    saveConfig(cfg(link));
    expect(pointsBackAtUs(link)).toBe(true);
    expect(() => resolveRealClaude()).toThrow(/own wrapper/);
  });

  test("a real binary outside binDir resolves", () => {
    saveConfig(cfg("/usr/bin/true"));
    expect(pointsBackAtUs("/usr/bin/true")).toBe(false);
    expect(resolveRealClaude()).toBe("/usr/bin/true");
  });
});

describe("scanPathForClaude", () => {
  test("skips the wrapper even through a symlinked PATH dir, finds the real one after it", () => {
    mkdirSync(paths.binDir, { recursive: true });
    writeExecutable(paths.supervisorLink, "#!/bin/sh\nexit 0\n");
    const realDir = join(scratch, "realbin");
    mkdirSync(realDir, { recursive: true });
    writeExecutable(join(realDir, "claude"), "#!/bin/sh\nexit 0\n");
    const aliasDir = join(scratch, "alias-to-bindir");
    symlinkSync(paths.binDir, aliasDir);

    // the old exact-string compare (`d === paths.binDir`) missed the alias dir
    process.env.PATH = `${aliasDir}:${realDir}`;
    expect(scanPathForClaude()).toBe(join(realDir, "claude"));
  });
});

describe("verifyRealClaude", () => {
  test("a binary whose --version identifies claude passes", () => {
    mkdirSync(scratch, { recursive: true });
    const fake = join(scratch, "fake-claude");
    writeExecutable(fake, `#!/bin/sh\necho "2.1.207 (Claude Code)"\n`);
    expect(verifyRealClaude(fake)).toBeNull();
  });
  test("exit 0 without claude-identifying output fails", () => {
    expect(verifyRealClaude("/usr/bin/true")).toContain("does not identify claude");
  });
  test("a loop abort is named as recursion", () => {
    mkdirSync(scratch, { recursive: true });
    const fake = join(scratch, "looper");
    writeExecutable(fake, `#!/bin/sh\necho "tokenmaxxing: ${LOOP_DIAGNOSIS} (depth 5)" >&2\nexit 1\n`);
    expect(verifyRealClaude(fake)).toContain("recursion");
  });
  test("a plain failure reports the exit code", () => {
    mkdirSync(scratch, { recursive: true });
    const fake = join(scratch, "broken");
    writeExecutable(fake, "#!/bin/sh\nexit 3\n");
    expect(verifyRealClaude(fake)).toContain("exited 3");
  });
});

describe("wrapperEntryRateTripped", () => {
  test("trips only past the cap within one window", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < WRAP_RATE_MAX; i++) {
      expect(wrapperEntryRateTripped(t0 + i)).toBe(false);
    }
    expect(wrapperEntryRateTripped(t0 + WRAP_RATE_MAX)).toBe(true);
  });

  test("entries outside the window are forgotten", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < WRAP_RATE_MAX; i++) wrapperEntryRateTripped(t0 + i);
    expect(wrapperEntryRateTripped(t0 + WRAP_RATE_WINDOW_MS + 1)).toBe(false);
  });
});

describe("resolveVerifiedClaude", () => {
  test("walks past a failing user wrapper on PATH to the real binary behind it", () => {
    const badDir = join(scratch, "user-wrappers");
    const goodDir = join(scratch, "realbin");
    mkdirSync(badDir, { recursive: true });
    mkdirSync(goodDir, { recursive: true });
    writeExecutable(join(badDir, "claude"), "#!/bin/sh\nexit 3\n");
    writeExecutable(join(goodDir, "claude"), `#!/bin/sh\necho "2.1.207 (Claude Code)"\n`);
    process.env.PATH = `${badDir}:${goodDir}`;
    expect(resolveVerifiedClaude()).toBe(join(goodDir, "claude"));
  });

  test("a poisoned config pin falls back to a verified PATH candidate", () => {
    const goodDir = join(scratch, "realbin2");
    mkdirSync(paths.binDir, { recursive: true });
    mkdirSync(goodDir, { recursive: true });
    writeExecutable(paths.supervisorLink, "#!/bin/sh\nexit 0\n");
    writeExecutable(join(goodDir, "claude"), `#!/bin/sh\necho "2.1.207 (Claude Code)"\n`);
    saveConfig(cfg(paths.supervisorLink));
    process.env.PATH = goodDir;
    expect(resolveVerifiedClaude()).toBe(join(goodDir, "claude"));
  });

  test("throws with per-candidate detail when nothing verifies", () => {
    const badDir = join(scratch, "only-bad");
    mkdirSync(badDir, { recursive: true });
    writeExecutable(join(badDir, "claude"), "#!/bin/sh\nexit 3\n");
    process.env.PATH = badDir;
    expect(() => resolveVerifiedClaude()).toThrow(/exited 3/);
  });
});
