import { expect, test } from "bun:test";
import { superviseWithMarker } from "./edge-compat-fixtures.ts";

test("inverted: the supervisor ignores a respawn marker stamped with its child's launch time", async () => {
  const run = await superviseWithMarker("same");

  expect({ ...run, launchCount: run.launches.length }).toMatchObject({
    launchCount: 1,
  });
}, 30_000);
