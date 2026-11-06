import { expect, test } from "bun:test";
import { superviseWithMarker } from "./edge-compat-fixtures.ts";

test("the supervisor discards a respawn marker stamped with an earlier launch time and ends the session without a relaunch", async () => {
  const run = await superviseWithMarker("earlier");

  expect({ ...run, launchCount: run.launches.length }).toMatchObject({
    exitCode: 0,
    launchCount: 1,
    markersLeft: [],
  });
}, 30_000);
