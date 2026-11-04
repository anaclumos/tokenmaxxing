import { expect, test } from "bun:test";
import { z } from "zod";
import { runTurnThroughProxy, timeline } from "./codex-appserver-fixtures.ts";

const DetailsSchema = z.looseObject({ error: z.looseObject({ additionalDetails: z.string() }) });

test("an overload that outlasts the window after several continuations reaches the client once, as the original turn's failure", async () => {
  const seen = await runTurnThroughProxy({ script: ["overload"], windowMs: 1_000, delaysMs: [100, 100] });
  const inputs = z.array(z.string()).parse(JSON.parse(DetailsSchema.parse(seen.find((m) => m.method === "error")?.params).error.additionalDetails));

  expect(timeline(seen)).toEqual(["turn/started turn-1 inProgress", "error turn-1 serverOverloaded", "turn/completed turn-1 failed"]);
  expect(inputs.length).toBeGreaterThan(1);
  expect(inputs).toEqual(["Review the diff.", ...Array.from({ length: inputs.length - 1 }, () => "Continue.")]);
}, 20_000);
