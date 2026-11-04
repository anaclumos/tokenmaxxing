import { expect, test } from "bun:test";
import { join } from "node:path";
import { fakeClaude, listed, miseTool, npmPackage, openStray, openThroughLauncher, pointAlias, run, scratch, tokenmaxxingHome } from "./edge-mise-launcher-fixtures.ts";

test("inverted control: doctor run through the launcher of a mise install lists a claude session a launcher-started tokenmaxxing opened", async () => {
  const root = scratch();
  const tool = miseTool(join(root, "mise", "installs"), "npm-tokenmaxxing", "npm:tokenmaxxing", "npm:tokenmaxxing");
  const link = npmPackage(join(tool, "1.193.0"), "1.193.0");
  pointAlias(tool, "latest", "1.193.0");
  const home = tokenmaxxingHome(root);
  const claude = fakeClaude(root, home);
  const init = run([process.execPath, link, "init"], home.env);
  const opened = await openThroughLauncher(home, claude);
  const stray = openStray(claude);
  try {
    const doctor = run([home.launcher, "doctor"], home.env);
    expect({ init, launcherSessionListed: listed(doctor.stdout, opened.pid), straySessionListed: listed(doctor.stdout, stray.pid), doctor }).toMatchObject({
      init: { exitCode: 0 },
      launcherSessionListed: true,
      straySessionListed: true,
    });
  } finally {
    opened.close();
    stray.close();
  }
}, 30_000);
