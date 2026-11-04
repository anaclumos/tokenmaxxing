import { expect, test } from "bun:test";
import { join } from "node:path";
import { bunGlobalPackage, launcherReport, miseTool, placeBun, pointAlias, prune, run, scratch, tokenmaxxingHome } from "./edge-mise-launcher-fixtures.ts";

test("inverted control: init run on a mise Bun writes a launcher that still runs on the pruned Bun", () => {
  const root = scratch();
  const bunTool = miseTool(join(root, "mise", "installs"), "bun", "bun", "core:bun");
  const bun = placeBun(join(bunTool, "1.4.3", "bin"), "bun");
  pointAlias(bunTool, "latest", "1.4.3");
  const { link } = bunGlobalPackage(root, "1.193.0");
  const home = tokenmaxxingHome(root);
  const init = run([bun, link, "init"], home.env);

  placeBun(join(bunTool, "1.4.4", "bin"), "bun");
  pointAlias(bunTool, "latest", "1.4.4");
  prune(root, join(bunTool, "1.4.3"));

  expect({ init, after: launcherReport(home, home.launcher, ["status"]) }).toMatchObject({
    init: { exitCode: 0 },
    after: { exitCode: 0, report: { version: "1.193.0", bun: join(bunTool, "1.4.3", "bin", "bun"), args: ["status"] } },
  });
}, 30_000);
