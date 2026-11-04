import { expect, test } from "bun:test";
import { bunGlobalPackage, fakeClaude, listed, openStray, openThroughLauncher, run, scratch, tokenmaxxingHome } from "./edge-mise-launcher-fixtures.ts";

test("doctor run through a Bun global install's bin link does not list a claude session a launcher-started tokenmaxxing opened, and lists one another process opened", async () => {
  const root = scratch();
  const { link } = bunGlobalPackage(root, "1.193.0");
  const home = tokenmaxxingHome(root);
  const claude = fakeClaude(root, home);
  const init = run([process.execPath, link, "init"], home.env);
  const opened = await openThroughLauncher(home, claude);
  const stray = openStray(claude);
  try {
    const doctor = run([process.execPath, link, "doctor"], home.env);
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
