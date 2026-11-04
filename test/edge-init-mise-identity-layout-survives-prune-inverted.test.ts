import { expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launcherReport, npmPackage, pointAlias, prune, run, scratch, tokenmaxxingHome } from "./edge-mise-launcher-fixtures.ts";

function identityInstall(installs: string, dir: string, version: string): string {
  npmPackage(join(installs, dir), version);
  writeFileSync(
    join(installs, dir, ".mise-install.toml"),
    `dir = "${dir}"\nrequested_as = "npm:tokenmaxxing"\n\n[identity]\nmode = "fallback"\nbackend = "npm:tokenmaxxing"\nversion = "${version}"\nplatform = "linux-x64"\n`,
  );
  symlinkSync(`../${dir}`, join(installs, "npm-tokenmaxxing", version));
  return join(installs, "npm-tokenmaxxing", version, "bin", "tokenmaxxing");
}

test("inverted control: init from an identity-layout mise install writes a launcher that still runs the pruned installation", () => {
  const root = scratch();
  const installs = join(root, "mise", "installs");
  mkdirSync(join(installs, ".mise"), { recursive: true });
  mkdirSync(join(installs, "npm-tokenmaxxing"));
  const link = identityInstall(installs, "tokenmaxxing-hlencrst", "1.193.0");
  pointAlias(join(installs, "npm-tokenmaxxing"), "latest", "1.193.0");
  const home = tokenmaxxingHome(root);
  const init = run([process.execPath, link, "init"], home.env);

  identityInstall(installs, "tokenmaxxing-q4v7mz2k", "1.194.0");
  pointAlias(join(installs, "npm-tokenmaxxing"), "latest", "1.194.0");
  prune(root, join(installs, "tokenmaxxing-hlencrst"));
  prune(root, join(installs, "npm-tokenmaxxing", "1.193.0"));

  expect({ init, after: launcherReport(home, home.launcher, ["status"]) }).toMatchObject({
    init: { exitCode: 0 },
    after: { exitCode: 0, report: { version: "1.193.0", args: ["status"] } },
  });
}, 30_000);
