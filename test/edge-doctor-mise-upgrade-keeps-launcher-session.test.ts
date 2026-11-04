import { expect, test } from "bun:test";
import { join } from "node:path";
import { fakeClaude, listed, miseTool, npmPackage, openStray, openThroughLauncher, pointAlias, run, scratch, tokenmaxxingHome } from "./edge-mise-launcher-fixtures.ts";

test("doctor run through the upgraded version's mise bin link does not list a claude session that a launcher-started tokenmaxxing opened before the upgrade, and lists one another process opened", async () => {
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
    const upgraded = npmPackage(join(tool, "1.194.0"), "1.194.0");
    pointAlias(tool, "latest", "1.194.0");
    const doctor = run([process.execPath, upgraded, "doctor"], home.env);
    expect({ init, launcherSessionListed: listed(doctor.stdout, opened.pid), straySessionListed: listed(doctor.stdout, stray.pid), doctor }).toMatchObject({
      init: { exitCode: 0 },
      launcherSessionListed: false,
      straySessionListed: true,
    });
  } finally {
    opened.close();
    stray.close();
  }
}, 30_000);
