import { expect, test } from "bun:test";
import { superviseWithMarker } from "./edge-compat-fixtures.ts";

test("inverted: the supervisor relaunches on a respawn marker that carries no launch time", async () => {
  const run = await superviseWithMarker("none");

  expect({ ...run, launchCount: run.launches.length }).toMatchObject({
    launchCount: 2,
  });
}, 30_000);
