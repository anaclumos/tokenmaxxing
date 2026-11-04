import { expect, test } from "bun:test";
import { join } from "node:path";
import { launcherReport, miseTool, npmPackage, pointAlias, prune, run, scratch, tokenmaxxingHome } from "./edge-mise-launcher-fixtures.ts";

test("inverted control: init run from a pinned version writes a launcher that follows latest", () => {
  const root = scratch();
  const tool = miseTool(join(root, "mise", "installs"), "npm-tokenmaxxing", "npm:tokenmaxxing", "npm:tokenmaxxing");
  const pinned = npmPackage(join(tool, "1.192.0"), "1.192.0");
  npmPackage(join(tool, "1.193.0"), "1.193.0");
  pointAlias(tool, "latest", "1.193.0");
  const home = tokenmaxxingHome(root);
  const init = run([process.execPath, pinned, "init"], home.env);

  npmPackage(join(tool, "1.194.0"), "1.194.0");
  pointAlias(tool, "latest", "1.194.0");
  prune(root, join(tool, "1.193.0"));

  expect({ init, after: launcherReport(home, home.launcher, ["status"]) }).toMatchObject({
    init: { exitCode: 0 },
    after: { exitCode: 0, report: { version: "1.194.0", args: ["status"] } },
  });
}, 30_000);
