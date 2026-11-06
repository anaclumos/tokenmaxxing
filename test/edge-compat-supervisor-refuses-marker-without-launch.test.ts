import { expect, test } from "bun:test";
import { superviseWithMarker } from "./edge-compat-fixtures.ts";

test("the supervisor never relaunches on a respawn marker that carries no launch time", async () => {
  const run = await superviseWithMarker("none");

  expect({ ...run, launchCount: run.launches.length }).toMatchObject({
    launchCount: 1,
  });
}, 30_000);
