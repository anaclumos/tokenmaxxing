import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withLock } from "../src/lib/lock.ts";

test("inverted: withLock lets one holder at a time run on a lock file, and a holder that throws rejects with its error and frees the lock for the waiting caller", async () => {
  const lockPath = join(mkdtempSync(join(tmpdir(), "tokenmaxxing-edge-lock-")), "nested", "lock");
  const started: string[] = [];
  let inside = 0;
  let peak = 0;
  const firstMayFinish = Promise.withResolvers<void>();
  const hold = (name: string, body: () => Promise<void>) =>
    withLock(lockPath, async () => {
      started.push(name);
      inside += 1;
      peak = Math.max(peak, inside);
      try {
        await body();
      } finally {
        inside -= 1;
      }
      return name;
    });

  const first = hold("first", async () => {
    await firstMayFinish.promise;
    throw new Error("first holder failed");
  });
  const second = hold("second", async () => {});
  const startedWhileFirstHeld = [...started];
  firstMayFinish.resolve();
  const settled = await Promise.allSettled([first, second]);

  expect({
    startedWhileFirstHeld,
    peak,
    outcomes: settled.map((o) => (o.status === "fulfilled" ? o.value : o.reason instanceof Error ? o.reason.message : String(o.reason))),
  }).not.toEqual({
    startedWhileFirstHeld: ["first"],
    peak: 1,
    outcomes: ["first holder failed", "second"],
  });
}, 10_000);
