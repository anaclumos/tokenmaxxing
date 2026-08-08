import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  checkTimerHealthy,
  installSupervisor,
  isNixPackaged,
  skipImperativeTimer,
} from "../src/lib/install.ts";
import { paths } from "../src/lib/paths.ts";

const savedNix = process.env.TOKENMAXXING_NIX;
const savedSkip = process.env.TOKENMAXXING_SKIP_TIMER;

function restoreEnv(): void {
  if (savedNix === undefined) delete process.env.TOKENMAXXING_NIX;
  else process.env.TOKENMAXXING_NIX = savedNix;
  if (savedSkip === undefined) delete process.env.TOKENMAXXING_SKIP_TIMER;
  else process.env.TOKENMAXXING_SKIP_TIMER = savedSkip;
}

function wipeInstallArtifacts(): void {
  rmSync(join(paths.binDir, "tokenmaxxing"), { force: true });
  rmSync(paths.supervisorLink, { force: true });
  rmSync(join(paths.binDir, "xx"), { force: true });
  rmSync(join(paths.systemdUserDir, "tokenmaxxing-check.timer"), { force: true });
  rmSync(join(paths.systemdUserDir, "tokenmaxxing-check.service"), { force: true });
  rmSync(join(paths.launchdAgentsDir, "com.tokenmaxxing.check.plist"), { force: true });
}

describe("nix packaging install path", () => {
  test("TOKENMAXXING_NIX writes a PATH-indirect shim (no store/bun hardcode)", () => {
    process.env.TOKENMAXXING_NIX = "1";
    process.env.TOKENMAXXING_SKIP_TIMER = "1"; // don't leave imperative units for later tests
    expect(isNixPackaged()).toBe(true);
    try {
      const out = installSupervisor();
      const shim = readFileSync(out.installedBin, "utf8");
      expect(shim).toContain("exec tokenmaxxing");
      expect(shim).toContain("for p in $PATH");
      expect(shim).not.toContain(" bun ");
      expect(shim).not.toContain("/nix/store/");
      expect(readFileSync(paths.supervisorLink, "utf8")).toContain(out.installedBin);
    } finally {
      restoreEnv();
      wipeInstallArtifacts();
    }
  });

  test("TOKENMAXXING_SKIP_TIMER skips imperative timer install and looks healthy", () => {
    wipeInstallArtifacts();
    delete process.env.TOKENMAXXING_NIX;
    process.env.TOKENMAXXING_SKIP_TIMER = "1";
    expect(skipImperativeTimer()).toBe(true);
    try {
      const out = installSupervisor();
      expect(out.timerLoaded).toBe(true);
      expect(checkTimerHealthy()).toBe(true);
      expect(existsSync(join(paths.systemdUserDir, "tokenmaxxing-check.timer"))).toBe(false);
      expect(existsSync(join(paths.launchdAgentsDir, "com.tokenmaxxing.check.plist"))).toBe(false);
    } finally {
      restoreEnv();
      wipeInstallArtifacts();
    }
  });

  test("unset flags leave the bun+entry shim (not PATH-indirect)", () => {
    wipeInstallArtifacts();
    delete process.env.TOKENMAXXING_NIX;
    delete process.env.TOKENMAXXING_SKIP_TIMER;
    expect(isNixPackaged()).toBe(false);
    expect(skipImperativeTimer()).toBe(false);
    try {
      const out = installSupervisor();
      const shim = readFileSync(out.installedBin, "utf8");
      // bun test's Bun.main is this test file; the shim still uses `bun run <entry>`.
      expect(shim.startsWith("#!/bin/sh\nexec ")).toBe(true);
      expect(shim).toContain(" run ");
      expect(shim).not.toContain("for p in $PATH");
      expect(shim).not.toContain("exec tokenmaxxing");
    } finally {
      restoreEnv();
      wipeInstallArtifacts();
    }
  });
});
