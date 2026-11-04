import { expect, test } from "bun:test";
import { join } from "node:path";
import { bunGlobalPackage, launcherReport, run, scratch, tokenmaxxingHome } from "./edge-mise-launcher-fixtures.ts";

test("inverted control: init from a Bun global install writes a launcher on the bin link instead of the script's real path", () => {
  const root = scratch();
  const { link, main } = bunGlobalPackage(root, "1.193.0");
  const home = tokenmaxxingHome(root);
  const init = run([process.execPath, link, "init"], home.env);

  bunGlobalPackage(root, "1.194.0");

  const after = launcherReport(home, join(home.tm, "bin", "xx"), ["status"]);
  expect({ init, namesRealScript: after.launcher?.includes(main), namesBinLink: after.launcher?.includes(link), after }).toMatchObject({
    init: { exitCode: 0 },
    namesRealScript: false,
    namesBinLink: true,
    after: { exitCode: 0, report: { version: "1.194.0", args: ["status"] } },
  });
}, 30_000);
