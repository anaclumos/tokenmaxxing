import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { type ClientMessage, runTurnThroughProxy } from "./codex-appserver-fixtures.ts";

const TurnParamsSchema = z.looseObject({ turn: z.looseObject({ id: z.string(), status: z.string() }) });
const turnOf = (msg: ClientMessage | undefined) => TurnParamsSchema.safeParse(msg?.params).data?.turn ?? null;

describe("a bare codex app-server turn that fails with serverOverloaded", () => {
  test("is continued on the same app-server until it completes, and the client sees one completed turn under its own id", async () => {
    const seen = await runTurnThroughProxy({ script: ["overload", "overload", "answer"], windowMs: 60_000 });
    const reply = seen.find((m) => m.id === 3);
    const completed = seen.at(-1);
    const answer = seen.find((m) => m.method === "item/completed");

    expect(reply?.result).toMatchObject({ turn: { id: "turn-1" } });
    expect(turnOf(completed)).toMatchObject({ id: "turn-1", status: "completed" });
    expect(seen.filter((m) => m.method === "error")).toEqual([]);
    expect(seen.filter((m) => m.method === "turn/started").map((m) => turnOf(m))).toMatchObject([{ id: "turn-1" }]);
    expect(answer?.params).toMatchObject({ turnId: "turn-1", item: { text: JSON.stringify(["Review the diff.", "Continue.", "Continue."]) } });
  }, 20_000);

  test("reaches the client as that turn's failure once the retry window has passed", async () => {
    const seen = await runTurnThroughProxy({ script: ["overload"], windowMs: 0 });

    expect(seen.filter((m) => m.method === "error").map((m) => m.params)).toMatchObject([{ turnId: "turn-1", error: { codexErrorInfo: "serverOverloaded" } }]);
    expect(turnOf(seen.at(-1))).toMatchObject({ id: "turn-1", status: "failed" });
  }, 20_000);
});
