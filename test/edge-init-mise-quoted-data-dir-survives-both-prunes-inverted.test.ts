import { expect, test } from "bun:test";
import { join } from "node:path";
import { launcherReport, miseTool, npmPackage, placeBun, pointAlias, prune, run, scratch, tokenmaxxingHome } from "./edge-mise-launcher-fixtures.ts";

test("inverted control: init from a mise data directory with a space and a quote writes a launcher that still runs the pruned tokenmaxxing on the pruned Bun", () => {
  const root = scratch();
  const installs = join(root, "Application Support", "mise's data", "installs");
  const bunTool = miseTool(installs, "bun", "bun", "core:bun");
  const bun = placeBun(join(bunTool, "1.4.3", "bin"), "bun");
  pointAlias(bunTool, "latest", "1.4.3");
  const tool = miseTool(installs, "npm-tokenmaxxing", "npm:tokenmaxxing", "npm:tokenmaxxing");
  const link = npmPackage(join(tool, "1.193.0"), "1.193.0");
  pointAlias(tool, "latest", "1.193.0");
  const home = tokenmaxxingHome(root);
  const init = run([bun, link, "init"], home.env);

  placeBun(join(bunTool, "1.4.4", "bin"), "bun");
  pointAlias(bunTool, "latest", "1.4.4");
  npmPackage(join(tool, "1.194.0"), "1.194.0");
  pointAlias(tool, "latest", "1.194.0");
  prune(root, join(bunTool, "1.4.3"));
  prune(root, join(tool, "1.193.0"));

  expect({ init, after: launcherReport(home, home.launcher, ["status", "it's on"]) }).toMatchObject({
    init: { exitCode: 0 },
    after: { exitCode: 0, report: { version: "1.193.0", bun: join(bunTool, "1.4.3", "bin", "bun"), args: ["status", "it's on"] } },
  });
}, 30_000);
