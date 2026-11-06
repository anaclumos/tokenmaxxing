import { expect, test } from "bun:test";
import { freshHome } from "./fixtures.ts";
import { clearedStoreMove, logFields } from "./edge-minesweep-fixtures.ts";

const home = freshHome();

test("inverted: the rejected-candidate log line for a cleared Claude store names the store and the re-auth command with no invalid_grant prefix", async () => {
  await clearedStoreMove(home);

  expect(logFields(home, "decide.candidate_rejected")).toEqual(["account=8a4e6c2b error=invalid_grant: spare's store was cleared after a failed refresh - re-auth with `tokenmaxxing auth spare`"]);
});
