import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { freshHome } from "./fixtures.ts";

test("a codex login reports and then removes each dead codex login home, and leaves live homes, other pools' homes, and entries that are not login homes", async () => {
  const home = freshHome();
  try {
    const { onboardHome } = await import("../src/lib/onboard.ts");
    const exited = Bun.spawn(["true"]);
    await exited.exited;
    const onboard = join(home, "onboard");
    const names = {
      deadA: `codex-${exited.pid}-aaa111`,
      deadB: `codex-${exited.pid}-bbb222`,
      live: `codex-${process.pid}-ccc333`,
      otherPool: `claude-${exited.pid}-ddd444`,
      noSuffix: `codex-${exited.pid}`,
      plainDir: "codex-notes",
    };
    for (const name of Object.values(names)) mkdirSync(join(onboard, name, ".codex"), { recursive: true });
    writeFileSync(join(onboard, "README"), "kept\n");

    const reported: { dir: string; presentWhenReported: boolean }[] = [];
    const fresh = await onboardHome("codex", async (dir) => {
      reported.push({ dir, presentWhenReported: existsSync(join(dir, ".codex")) });
    });

    expect({
      reported: reported.toSorted((a, b) => a.dir.localeCompare(b.dir)),
      left: readdirSync(onboard).toSorted(),
    }).toEqual({
      reported: [names.deadA, names.deadB].map((name) => ({ dir: join(onboard, name), presentWhenReported: true })),
      left: [names.live, names.otherPool, names.noSuffix, names.plainDir, "README", basename(fresh)].toSorted(),
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
