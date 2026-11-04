import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launcherReport, miseTool, npmPackage, pointAlias, prune, run, scratch, tokenmaxxingHome } from "./edge-mise-launcher-fixtures.ts";

test("init from a mise installs directory shared with other tools, stray files, dangling and partial aliases writes a launcher that runs the upgraded version after a prune", () => {
  const root = scratch();
  const installs = join(root, "mise", "installs");
  const tool = miseTool(installs, "npm-tokenmaxxing", "npm:tokenmaxxing", "npm:tokenmaxxing");
  const link = npmPackage(join(tool, "1.193.0"), "1.193.0");
  for (const alias of ["1", "1.193", "global", "latest"]) pointAlias(tool, alias, "1.193.0");
  writeFileSync(join(installs, ".mise-installs.toml"), '[npm-tokenmaxxing]\nshort = "npm:tokenmaxxing"\nfull = "npm:tokenmaxxing"\nexplicit_backend = true\n');
  const node = miseTool(installs, "node", "node", "core:node");
  mkdirSync(join(node, "24.11.0", "bin"), { recursive: true });
  writeFileSync(join(node, "24.11.0", "bin", "node"), "");
  pointAlias(node, "latest", "24.11.0");
  pointAlias(miseTool(installs, "gh", "gh", "aqua:cli/cli"), "latest", "2.83.0");
  mkdirSync(join(miseTool(installs, "uv", "uv", "aqua:astral-sh/uv"), "0.9.7"));
  const home = tokenmaxxingHome(root);
  const init = run([process.execPath, link, "init"], home.env);

  npmPackage(join(tool, "1.194.0"), "1.194.0");
  for (const alias of ["1", "1.194", "global", "latest"]) pointAlias(tool, alias, "1.194.0");
  prune(root, join(tool, "1.193"));
  prune(root, join(tool, "1.193.0"));

  expect({ init, after: launcherReport(home, home.launcher, ["status"]) }).toMatchObject({
    init: { exitCode: 0 },
    after: { exitCode: 0, report: { version: "1.194.0", args: ["status"] } },
  });
}, 30_000);
