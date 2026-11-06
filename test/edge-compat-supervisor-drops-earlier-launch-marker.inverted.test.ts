import { expect, test } from "bun:test";
import { superviseWithMarker } from "./edge-compat-fixtures.ts";

test("inverted: the supervisor relaunches on a respawn marker stamped with an earlier launch time", async () => {
  const run = await superviseWithMarker("earlier");

  expect({ ...run, launchCount: run.launches.length }).toMatchObject({
    launchCount: 2,
  });
}, 30_000);
