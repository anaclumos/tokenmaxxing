// The flock acquire must never block the event loop. Before 2026-07-19 it was
// a blocking synchronous LOCK_EX via FFI: in `xx serve` (one process, many
// actors) a contender's blocking acquire froze the runtime while the holder
// awaited network work, so the holder could never resume to release - a true
// single-process deadlock. The non-blocking acquire makes contenders queue on
// an async retry loop instead; under the old code the first test here hangs.

import { expect, test } from "bun:test";
import { join } from "node:path";
import { delay } from "es-toolkit";
import { withLock } from "../src/lib/lock.ts";
import { paths } from "../src/lib/paths.ts";

test("same-process contenders serialize instead of deadlocking", async () => {
  const lockPath = join(paths.home, "test-lock");
  const events: string[] = [];
  const holder = withLock(lockPath, async () => {
    events.push("holder-start");
    await delay(250); // the holder awaits (the serve deadlock shape)
    events.push("holder-end");
  });
  await delay(40); // let the holder acquire first
  const contender = withLock(lockPath, async () => {
    events.push("contender");
  });
  await Promise.all([holder, contender]);
  expect(events).toEqual(["holder-start", "holder-end", "contender"]);
});

test("sequential holds acquire cleanly after release", async () => {
  const lockPath = join(paths.home, "test-lock-seq");
  const out: number[] = [];
  await withLock(lockPath, () => { out.push(1); });
  await withLock(lockPath, () => { out.push(2); });
  expect(out).toEqual([1, 2]);
});
