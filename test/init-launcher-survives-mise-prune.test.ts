import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshHome } from "./fixtures.ts";

const INSTALL_TS = join(import.meta.dir, "..", "src", "lib", "install.ts");

function miseVersion(tool: string, version: string, main: string): void {
  const src = join(tool, version, "node_modules", "tokenmaxxing", "src");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "main.ts"), main);
}

describe("init from a mise install that tracks latest", () => {
  test("writes a launcher that still runs after mise upgrades and prunes the version init ran from", async () => {
    const home = freshHome();
    const root = realpathSync(mkdtempSync(join(tmpdir(), "tokenmaxxing-mise-")));
    const tool = join(root, "installs", "npm-tokenmaxxing");
    mkdirSync(tool, { recursive: true });
    writeFileSync(join(tool, ".mise.backend.toml"), 'short = "npm:tokenmaxxing"\nfull = "npm:tokenmaxxing"\n');
    miseVersion(tool, "1.193.0", `import { installPiSupervisor } from ${JSON.stringify(INSTALL_TS)};\ninstallPiSupervisor();\n`);
    symlinkSync("./1.193.0", join(tool, "latest"));

    const init = Bun.spawnSync([process.execPath, join(tool, "latest", "node_modules", "tokenmaxxing", "src", "main.ts")], {
      env: { ...process.env, TOKENMAXXING_HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(init.stderr.toString()).toBe("");
    expect(init.exitCode).toBe(0);

    miseVersion(tool, "1.194.0", 'console.log("1.194.0", process.argv.slice(2).join(" "));\n');
    unlinkSync(join(tool, "latest"));
    symlinkSync("./1.194.0", join(tool, "latest"));
    renameSync(join(tool, "1.193.0"), join(root, "pruned-1.193.0"));

    const launcher = join(home, "bin", "tokenmaxxing");
    const run = Bun.spawnSync(["/bin/sh", launcher, "status"], { stdout: "pipe", stderr: "pipe" });
    expect({ launcher: readFileSync(launcher, "utf8"), stdout: run.stdout.toString(), exitCode: run.exitCode }).toEqual({
      launcher: expect.stringContaining(join(tool, "latest")),
      stdout: "1.194.0 status\n",
      exitCode: 0,
    });
  });

  test("names Bun through its latest alias and keeps a version that is not the latest", async () => {
    const { miseStablePath } = await import("../src/lib/install.ts");
    const bun = join(realpathSync(mkdtempSync(join(tmpdir(), "tokenmaxxing-mise-"))), "installs", "bun");
    for (const version of ["1.4.3", "1.4.4"]) {
      mkdirSync(join(bun, version, "bin"), { recursive: true });
      writeFileSync(join(bun, version, "bin", "bun"), "");
    }
    writeFileSync(join(bun, ".mise.backend.toml"), 'short = "bun"\nfull = "core:bun"\n');
    symlinkSync("./1.4.4", join(bun, "latest"));

    expect([miseStablePath(join(bun, "1.4.4", "bin", "bun")), miseStablePath(join(bun, "1.4.3", "bin", "bun"))]).toEqual([
      join(bun, "latest", "bin", "bun"),
      join(bun, "1.4.3", "bin", "bun"),
    ]);
  });

  test("names an identity-layout install through its tool's latest alias", async () => {
    const { miseStablePath } = await import("../src/lib/install.ts");
    const installs = join(realpathSync(mkdtempSync(join(tmpdir(), "tokenmaxxing-mise-"))), "installs");
    const store = join(installs, "tokenmaxxing-hlencrst");
    mkdirSync(join(store, "src"), { recursive: true });
    writeFileSync(join(store, ".mise-install.toml"), 'requested_as = "npm:tokenmaxxing"\n');
    writeFileSync(join(store, "src", "main.ts"), "");
    mkdirSync(join(installs, "npm-tokenmaxxing"));
    symlinkSync("../tokenmaxxing-hlencrst", join(installs, "npm-tokenmaxxing", "1.193.0"));
    symlinkSync("./1.193.0", join(installs, "npm-tokenmaxxing", "latest"));

    expect(miseStablePath(join(store, "src", "main.ts"))).toBe(join(installs, "npm-tokenmaxxing", "latest", "src", "main.ts"));
  });
});
