import { expect, test } from "bun:test";
import { answerOf, converse, endsTurn, turnStart } from "./codex-appserver-fixtures.ts";

const FIRST = { cwd: "/repo", model: "gpt-5-codex", effort: "low", approvalPolicy: "never", sandboxPolicy: { type: "readOnly" }, summary: "auto" };
const SECOND = {
  cwd: "/repo/packages/api",
  model: "gpt-5",
  effort: "high",
  approvalPolicy: "on-request",
  sandboxPolicy: { type: "workspaceWrite", writableRoots: ["/repo/packages/api"], networkAccess: false },
  summary: "concise",
  personality: "pragmatic",
};

test("the continuation of an overloaded turn carries the settings of the client's latest turn/start, with only the input replaced", async () => {
  const first = turnStart(3, "Review the diff.", FIRST);
  const second = turnStart(4, "Fix the failing test.", SECOND);
  const seen = await converse({
    script: ["answer", "overload", "params"],
    windowMs: 60_000,
    steps: [
      { send: [first], until: endsTurn },
      { send: [second], until: endsTurn },
    ],
  });
  const answer = answerOf(seen);

  expect(answer.turnId).toBe("turn-2");
  expect(JSON.parse(answer.item.text)).toEqual([first.params, second.params, { ...second.params, input: [{ type: "text", text: "Continue." }] }]);
}, 20_000);
