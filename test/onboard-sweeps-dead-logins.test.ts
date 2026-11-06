import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { freshHome } from "./fixtures.ts";

test("a login removes its own pool's homes whose process is gone, reporting each, and leaves live homes and other pools' homes", async () => {
  const home = freshHome();
  const { onboardHome } = await import("../src/lib/onboard.ts");
  const exited = Bun.spawn(["true"]);
  await exited.exited;
  const onboard = join(home, "onboard");
  const dead = join(onboard, `claude-${exited.pid}-abc123`);
  const live = join(onboard, `claude-${process.pid}-def456`);
  const otherPool = join(onboard, `codex-${exited.pid}-ghi789`);
  for (const dir of [dead, live, otherPool]) mkdirSync(join(dir, ".claude"), { recursive: true });

  const stale: string[] = [];
  const fresh = await onboardHome("claude", async (dir) => {
    stale.push(dir);
  });

  expect({ stale, dead: existsSync(dead), live: existsSync(live), otherPool: existsSync(otherPool), fresh: existsSync(fresh) }).toEqual({
    stale: [dead],
    dead: false,
    live: true,
    otherPool: true,
    fresh: true,
  });
  expect(readdirSync(onboard).toSorted()).toEqual([live, otherPool, fresh].map((dir) => dir.slice(onboard.length + 1)).toSorted());
});
