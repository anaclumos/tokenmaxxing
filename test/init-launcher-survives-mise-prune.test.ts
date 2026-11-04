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
});
