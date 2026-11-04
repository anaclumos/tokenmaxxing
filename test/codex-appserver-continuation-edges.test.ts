import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { answerOf, converse, endsTurn, interrupt, RATE_LIMITS_UPDATED, START_RECEIVED, THREAD_ID, timeline, turnStart } from "./codex-appserver-fixtures.ts";

const StartsSchema = z.array(z.record(z.string(), z.unknown()));
const DetailsSchema = z.looseObject({ error: z.looseObject({ additionalDetails: z.string() }) });
const handled = (since: { method?: string }[]): boolean => since.some((m) => m.method === RATE_LIMITS_UPDATED);

describe("a continuation of an overloaded turn", () => {
  test("steered by a client turn/start answers with the original turn's id", async () => {
    const seen = await converse({
      script: ["overload", "hang"],
      windowMs: 60_000,
      steps: [
        { send: [turnStart(3, "Refactor the module.")], until: (since) => since.at(-1)?.method === "item/started" },
        { send: [turnStart(4, "Keep the public API.")], until: endsTurn },
      ],
    });

    expect(seen.find((m) => m.id === 4)?.result).toMatchObject({ turn: { id: "turn-1" } });
    expect(timeline(seen)).toEqual(["turn/started turn-1 inProgress", "turn/completed turn-1 completed"]);
  }, 20_000);

  test("of a tool-output turn continues with Continue. and no tool output", async () => {
    const toolTurn = { id: 3, method: "turn/start", params: { threadId: THREAD_ID, input: [], toolOutput: { name: "lookup", output: "42" } } };
    const seen = await converse({ script: ["overload", "params"], windowMs: 60_000, steps: [{ send: [toolTurn], until: endsTurn }] });
    const starts = StartsSchema.parse(JSON.parse(answerOf(seen).item.text));

    expect(timeline(seen)).toEqual(["turn/started turn-1 inProgress", "turn/completed turn-1 completed"]);
    expect(starts[1]).not.toHaveProperty("toolOutput");
    expect(starts[1]?.input).toEqual([{ type: "text", text: "Continue." }]);
  }, 20_000);

  test("interrupted while its turn/start is in flight ends as the original turn, interrupted", async () => {
    const seen = await converse({
      script: ["overload", "slowHang"],
      windowMs: 60_000,
      steps: [
        { send: [turnStart(3, "Refactor the module.")], until: (since) => since.some((m) => m.method === START_RECEIVED) },
        { send: [interrupt(4, "turn-1")], until: endsTurn },
      ],
    });

    expect(seen.find((m) => m.id === 4)).toEqual({ id: 4, result: {} });
    expect(timeline(seen)).toEqual(["turn/started turn-1 inProgress", "turn/completed turn-1 interrupted"]);
  }, 20_000);

  test("waits no longer than the retry window before the overload reaches the client", async () => {
    const seen = await converse({
      script: ["overload", "overload", "answer"],
      windowMs: 300,
      delaysMs: [5, 60_000],
      steps: [{ send: [turnStart(3, "Review the diff.")], until: endsTurn }],
    });
    const inputs = z.array(z.string()).parse(JSON.parse(DetailsSchema.parse(seen.find((m) => m.method === "error")?.params).error.additionalDetails));

    expect(timeline(seen)).toEqual(["turn/started turn-1 inProgress", "error turn-1 serverOverloaded", "turn/completed turn-1 failed"]);
    expect(inputs).toEqual(["Review the diff.", "Continue."]);
  }, 20_000);

  test("still waiting when the client closes stdin reaches the client as the turn's failure", async () => {
    const seen = await converse({
      script: ["overload"],
      windowMs: 120_000,
      delaysMs: [60_000, 60_000],
      steps: [{ send: [turnStart(3, "Review the diff.")], until: handled }],
    });

    expect(timeline(seen)).toEqual(["turn/started turn-1 inProgress", "error turn-1 serverOverloaded", "turn/completed turn-1 failed"]);
  }, 20_000);
});
