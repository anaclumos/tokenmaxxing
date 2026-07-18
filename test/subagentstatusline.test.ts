import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { renderSubagentRows, type RowCtx } from "../src/entries/subagentstatusline.ts";

const plain: RowCtx = { color: false, truecolor: false };

describe("renderSubagentRows", () => {
  test("renders the model family painted by ctx fill, effort, then the label", () => {
    const stdin = {
      columns: 120,
      tasks: [
        {
          id: "t1",
          label: "explore the repo",
          model: "claude-fable-5",
          effort: "high",
          tokenCount: 20_000,
          contextWindowSize: 200_000,
        },
      ],
    };
    expect(renderSubagentRows(stdin, plain)).toEqual([JSON.stringify({ id: "t1", content: "fable (high) ctx 10  explore the repo" })]);
    // ANSI reaches claude through the JSON line (control chars escaped there,
    // restored by its JSON.parse), so assert on the parsed content: the family
    // name carries the ctx-fill color and the ctx token disappears.
    const colored = z
      .object({ id: z.string(), content: z.string() })
      .parse(JSON.parse(renderSubagentRows(stdin, { color: true, truecolor: true })[0]!));
    expect(colored.content).toContain("\x1b[1m\x1b[38;2;34;255;0mfable\x1b[0m\x1b[0m (high)");
    expect(colored.content).not.toContain("ctx");
  });

  test("absent fields degrade token by token, never to a fake zero", () => {
    const stdin = {
      tasks: [
        { id: "no-model", label: "grep the tree", tokenCount: 1000, contextWindowSize: 200_000 },
        { id: "no-ctx", label: "read docs", model: "claude-haiku-4-5-20251001" },
        { id: "label-only", description: "a bare task" },
        { id: "empty" },
        { label: "no id, no row" },
      ],
    };
    expect(renderSubagentRows(stdin, plain)).toEqual([
      JSON.stringify({ id: "no-model", content: "ctx 1  grep the tree" }),
      JSON.stringify({ id: "no-ctx", content: "haiku  read docs" }),
      JSON.stringify({ id: "label-only", content: "a bare task" }),
    ]);
  });

  test("a model id without the claude- prefix passes through whole", () => {
    const stdin = { tasks: [{ id: "t", model: "gpt-5-4-codex", label: "x" }] };
    expect(renderSubagentRows(stdin, plain)).toEqual([JSON.stringify({ id: "t", content: "gpt-5-4-codex  x" })]);
  });

  test("malformed or empty stdin renders nothing", () => {
    expect(renderSubagentRows(null, plain)).toEqual([]);
    expect(renderSubagentRows("nope", plain)).toEqual([]);
    expect(renderSubagentRows({}, plain)).toEqual([]);
    expect(renderSubagentRows({ tasks: "wrong shape" }, plain)).toEqual([]);
  });
});
