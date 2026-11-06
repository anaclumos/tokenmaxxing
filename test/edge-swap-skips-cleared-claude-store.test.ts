import { expect, test } from "bun:test";
import { freshHome } from "./fixtures.ts";
import { clearedStoreMove, IDS } from "./edge-minesweep-fixtures.ts";

const home = freshHome();

test("a move skips the roomiest account when its Claude store was cleared, flags it for re-auth, and lands on the next account", async () => {
  const { decision, accounts } = await clearedStoreMove(home);

  expect({ swapped: decision.swapped, account: decision.account?.id, reauth: accounts.filter((a) => a.needsReauth === true).map((a) => a.id) }).toEqual({
    swapped: true,
    account: IDS.backup,
    reauth: [IDS.spare],
  });
});
