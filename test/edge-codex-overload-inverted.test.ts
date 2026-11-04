import { expect, test } from "bun:test";
import { z } from "zod";
import { answerOf, type ClientMessage, converse, endsTurn, interrupt, RATE_LIMITS_UPDATED, runTurnThroughProxy, steer, timeline, turnStart } from "./codex-appserver-fixtures.ts";

const TurnRefSchema = z.looseObject({ turnId: z.string().optional(), turn: z.looseObject({ id: z.string() }).optional() });
const turnIds = (m: ClientMessage): string[] => {
  const ref = TurnRefSchema.safeParse(m.params ?? m.result).data;
  return [ref?.turnId, ref?.turn?.id].filter((id) => id != null);
};
const DetailsSchema = z.looseObject({ error: z.looseObject({ additionalDetails: z.string() }) });
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

test("inverted: the steer reply for the continued turn names the continuation's own id", async () => {
  const seen = await converse({
    script: ["overload", "hang"],
    windowMs: 60_000,
    steps: [
      { send: [turnStart(3, "Refactor the module.")], until: (since) => since.at(-1)?.method === "item/started" },
      { send: [steer(4, "turn-1", "Keep the public API.")], until: (since) => since.some((m) => m.method === "turn/completed" || m.error != null) },
    ],
  });

  expect(seen.find((m) => m.id === 4)).toEqual({ id: 4, result: { turnId: "turn-2" } });
}, 20_000);

test("inverted: after an overload that omits willRetry, the continued turn's messages reach the client under the continuation's own id", async () => {
  const seen = await converse({
    script: ["overloadUnflagged", "approval"],
    windowMs: 60_000,
    steps: [
      { send: [turnStart(3, "Run the tests.")], until: (since) => since.at(-1)?.method === "item/commandExecution/requestApproval" },
      { send: (prior) => [{ id: prior.at(-1)?.id, result: { decision: "accept" } }], until: endsTurn },
    ],
  });

  expect([...new Set(seen.flatMap(turnIds))]).toEqual(["turn-1", "turn-2"]);
}, 20_000);

test("inverted: a later turn after a recovered overload is reported under the recovered turn's id", async () => {
  const seen = await converse({
    script: ["overload", "answer"],
    windowMs: 60_000,
    steps: [
      { send: [turnStart(3, "Review the diff.")], until: endsTurn },
      { send: [turnStart(4, "Now fix it.")], until: endsTurn },
    ],
  });

  expect(timeline(seen).at(-1)).toBe("turn/completed turn-1 completed");
}, 20_000);

test("inverted: after interrupting a waiting second continuation, the next turn's start never reaches the client", async () => {
  const seen = await converse({
    script: ["overload", "overload", "answer"],
    windowMs: 60_000,
    delaysMs: [5, 60_000],
    steps: [
      { send: [turnStart(3, "Review the diff.")], until: (since) => since.filter((m) => m.method === RATE_LIMITS_UPDATED).length === 2 },
      { send: [interrupt(4, "turn-1")], until: endsTurn },
      { send: [turnStart(5, "Try again.")], until: endsTurn },
    ],
  });

  expect(timeline(seen)).not.toContain("turn/started turn-3 inProgress");
}, 20_000);

test("inverted: a new turn/start while a continuation waits never delivers the old turn's failure", async () => {
  const seen = await converse({
    script: ["overload", "answer"],
    windowMs: 60_000,
    delaysMs: [60_000, 60_000],
    steps: [
      { send: [turnStart(3, "Review the diff.")], until: (since) => since.at(-1)?.method === RATE_LIMITS_UPDATED },
      { send: [turnStart(4, "Use a smaller change.")], until: (since) => since.filter((m) => m.method === "turn/completed").length === 2 },
    ],
  });

  expect(timeline(seen)).not.toContain("turn/completed turn-1 failed");
}, 20_000);

test("inverted: a turn that fails with contextWindowExceeded is withheld from the client", async () => {
  const seen = await converse({
    script: ["contextFull", "answer"],
    windowMs: 60_000,
    steps: [
      { send: [turnStart(3, "Review the diff.")], until: endsTurn },
      { send: [turnStart(4, "Summarize instead.")], until: endsTurn },
    ],
  });

  expect(seen.filter((m) => m.method === "error")).toEqual([]);
}, 20_000);

test("inverted: an overload that codex says it will retry is withheld from the client", async () => {
  const seen = await runTurnThroughProxy({ script: ["retriedOverload"], windowMs: 60_000 });

  expect(seen.filter((m) => m.method === "error")).toEqual([]);
}, 20_000);

test("inverted: an overload that outlasts the window reaches the client before any continuation", async () => {
  const seen = await runTurnThroughProxy({ script: ["overload"], windowMs: 1_000, delaysMs: [100, 100] });
  const inputs = z.array(z.string()).parse(JSON.parse(DetailsSchema.parse(seen.find((m) => m.method === "error")?.params).error.additionalDetails));

  expect(inputs).toEqual(["Review the diff."]);
}, 20_000);

test("inverted: the continuation of an overloaded turn carries the settings of the client's first turn/start", async () => {
  const first = turnStart(3, "Review the diff.", FIRST);
  const seen = await converse({
    script: ["answer", "overload", "params"],
    windowMs: 60_000,
    steps: [
      { send: [first], until: endsTurn },
      { send: [turnStart(4, "Fix the failing test.", SECOND)], until: endsTurn },
    ],
  });

  expect(JSON.parse(answerOf(seen).item.text)[2]).toEqual({ ...first.params, input: [{ type: "text", text: "Continue." }] });
}, 20_000);

test("inverted: interrupting under the original id while the continued turn runs leaves that turn running", async () => {
  const seen = await converse({
    script: ["overload", "hang"],
    windowMs: 60_000,
    steps: [
      { send: [turnStart(3, "Refactor the module.")], until: (since) => since.at(-1)?.method === "item/started" },
      { send: [interrupt(4, "turn-1")], until: (since) => since.some((m) => m.method === "turn/completed" || m.error != null) },
    ],
  });

  expect(timeline(seen)).toEqual(["turn/started turn-1 inProgress"]);
}, 20_000);
