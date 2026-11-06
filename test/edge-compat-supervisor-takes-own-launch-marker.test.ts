import { expect, test } from "bun:test";
import { superviseWithMarker } from "./edge-compat-fixtures.ts";

test("the supervisor consumes a respawn marker stamped with its child's launch time and relaunches the same session", async () => {
  const run = await superviseWithMarker("same");
  const launchArgs = run.launches.map((line) => line.split(" ").slice(1).join(" "));

  expect({ ...run, launchCount: run.launches.length, sameSession: launchArgs[0] === launchArgs[1] }).toMatchObject({
    exitCode: 0,
    launchCount: 2,
    sameSession: true,
    markersLeft: [],
  });
}, 30_000);
