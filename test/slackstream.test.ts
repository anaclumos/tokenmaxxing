// slackstream: Agent SDK message -> Chat SDK stream chunk mapping.

import { describe, expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { agentEventChunks, newStreamMapState, todoChecklist, toolCardTitle, toolInputSummary } from "../src/lib/slackstream.ts";

const UUID = "00000000-0000-0000-0000-000000000000";
const SID = "test-session";

function streamEvent(input: { event: Extract<SDKMessage, { type: "stream_event" }>["event"]; parent?: string }): SDKMessage {
  return { type: "stream_event", event: input.event, parent_tool_use_id: input.parent ?? null, uuid: UUID, session_id: SID };
}

describe("toolCardTitle", () => {
  test("maps the five awkward names to natural labels, leaves the rest verbatim", () => {
    expect(toolCardTitle("TaskCreate")).toBe("Creating task");
    expect(toolCardTitle("ToolSearch")).toBe("Loading tools");
    expect(toolCardTitle("TaskUpdate")).toBe("Updating task");
    expect(toolCardTitle("WebSearch")).toBe("Searching the web");
    expect(toolCardTitle("WebFetch")).toBe("Fetching page");
    expect(toolCardTitle("Bash")).toBe("Bash");
    expect(toolCardTitle("mcp__plugin_linear_linear__get_issue")).toBe("mcp__plugin_linear_linear__get_issue");
    // inherited Object.prototype keys must not shadow the verbatim fallback
    expect(toolCardTitle("toString")).toBe("toString");
    expect(toolCardTitle("constructor")).toBe("constructor");
  });
});

describe("toolInputSummary", () => {
  test("prefers the command field, falls back to compact json, null on junk", () => {
    expect(toolInputSummary('{"command":"bun test","timeout":5}')).toBe("bun test");
    expect(toolInputSummary('{"file_path":"/tmp/x.ts"}')).toBe("/tmp/x.ts");
    expect(toolInputSummary('{"weird":42}')).toBe('{"weird":42}');
    expect(toolInputSummary("{}")).toBeNull();
    expect(toolInputSummary('{"command":')).toBeNull();
  });
});

describe("todoChecklist", () => {
  test("renders icon lines, activeForm for the in-progress item, allDone flag", () => {
    const list = todoChecklist(JSON.stringify({ todos: [
      { content: "Fix parser", status: "completed", activeForm: "Fixing parser" },
      { content: "Run tests", status: "in_progress", activeForm: "Running tests" },
      { content: "Ship it", status: "pending", activeForm: "Shipping it" },
    ] }));
    expect(list).toEqual({ text: "✅ Fix parser\n🔄 Running tests\n⬜ Ship it", allDone: false });
    const done = todoChecklist(JSON.stringify({ todos: [
      { content: "Fix parser", status: "completed", activeForm: "Fixing parser" },
    ] }));
    expect(done).toEqual({ text: "✅ Fix parser", allDone: true });
  });

  test("null on junk, partial json, and an empty list", () => {
    expect(todoChecklist("")).toBeNull();
    expect(todoChecklist('{"todos":')).toBeNull();
    expect(todoChecklist('{"other":1}')).toBeNull();
    expect(todoChecklist('{"todos":[]}')).toBeNull();
  });

  test("an empty activeForm falls back to content", () => {
    const list = todoChecklist(JSON.stringify({ todos: [
      { content: "Run tests", status: "in_progress", activeForm: "" },
    ] }));
    expect(list).toEqual({ text: "🔄 Run tests", allDone: false });
  });

  test("a long emoji-heavy checklist truncates without splitting a surrogate pair", () => {
    const list = todoChecklist(JSON.stringify({ todos: [
      { content: "🔄".repeat(700), status: "pending", activeForm: "" },
    ] }));
    if (list === null) throw new Error("expected a checklist");
    expect(list.text.endsWith("...")).toBe(true);
    expect(Array.from(list.text).length).toBe(600);
    const hasLoneSurrogate = Array.from(list.text).some(
      (c) => c.length === 1 && c.charCodeAt(0) >= 0xd800 && c.charCodeAt(0) <= 0xdfff,
    );
    expect(hasLoneSurrogate).toBe(false);
  });
});

describe("agentEventChunks", () => {
  test("text deltas pass through as strings", () => {
    const state = newStreamMapState();
    const chunks = agentEventChunks({ state, message: streamEvent({ event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } } }) });
    expect(chunks).toEqual(["hi"]);
  });

  test("thinking block lifecycle emits in_progress then complete with details", () => {
    const state = newStreamMapState();
    const start = agentEventChunks({ state, message: streamEvent({ event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } } }) });
    expect(start).toEqual([{ type: "task_update", id: "thinking-1", title: "Thinking", status: "in_progress" }]);
    agentEventChunks({ state, message: streamEvent({ event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "pondering deeply", estimated_tokens: 4 } } }) });
    const stop = agentEventChunks({ state, message: streamEvent({ event: { type: "content_block_stop", index: 0 } }) });
    expect(stop).toEqual([{ type: "task_update", id: "thinking-1", title: "Thinking", status: "complete", details: "pondering deeply" }]);
  });

  test("tool block emits in_progress with input summary, then result completes it", () => {
    const state = newStreamMapState();
    const start = agentEventChunks({ state, message: streamEvent({ event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "Bash", input: {} } } }) });
    expect(start).toEqual([{ type: "task_update", id: "toolu_1", title: "Bash", status: "in_progress" }]);
    agentEventChunks({ state, message: streamEvent({ event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"command":"xx status"}' } } }) });
    const stop = agentEventChunks({ state, message: streamEvent({ event: { type: "content_block_stop", index: 1 } }) });
    expect(stop).toEqual([{ type: "task_update", id: "toolu_1", title: "Bash", status: "in_progress", details: "xx status" }]);
    const result = agentEventChunks({ state, message: {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "4 accounts" }] },
      parent_tool_use_id: null,
      uuid: UUID,
      session_id: SID,
    } });
    expect(result).toEqual([{ type: "task_update", id: "toolu_1", title: "Bash", status: "complete", output: "4 accounts" }]);
  });

  test("a mapped tool name carries its natural label through start and result cards", () => {
    const state = newStreamMapState();
    const start = agentEventChunks({ state, message: streamEvent({ event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_ws", name: "WebSearch", input: {} } } }) });
    expect(start).toEqual([{ type: "task_update", id: "toolu_ws", title: "Searching the web", status: "in_progress" }]);
    const result = agentEventChunks({ state, message: {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_ws", content: "3 results" }] },
      parent_tool_use_id: null,
      uuid: UUID,
      session_id: SID,
    } });
    expect(result).toEqual([{ type: "task_update", id: "toolu_ws", title: "Searching the web", status: "complete", output: "3 results" }]);
  });

  test("tool_result is_error maps to an error card", () => {
    const state = newStreamMapState();
    agentEventChunks({ state, message: streamEvent({ event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_2", name: "Bash", input: {} } } }) });
    const result = agentEventChunks({ state, message: {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_2", content: [{ type: "text", text: "boom" }], is_error: true }] },
      parent_tool_use_id: null,
      uuid: UUID,
      session_id: SID,
    } });
    expect(result).toEqual([{ type: "task_update", id: "toolu_2", title: "Bash", status: "error", output: "boom" }]);
  });

  test("a tool starting after streamed text emits only its card: tasks group into one plan block, never a new message", () => {
    const state = newStreamMapState();
    agentEventChunks({ state, message: streamEvent({ event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "I will check." } } }) });
    const chunks = agentEventChunks({ state, message: streamEvent({ event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_3", name: "Bash", input: {} } } }) });
    expect(chunks).toEqual([{ type: "task_update", id: "toolu_3", title: "Bash", status: "in_progress" }]);
    const again = agentEventChunks({ state, message: streamEvent({ event: { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_4", name: "Read", input: {} } } }) });
    expect(again).toEqual([{ type: "task_update", id: "toolu_4", title: "Read", status: "in_progress" }]);
  });

  test("subagent text is skipped but subagent tool calls emit cards", () => {
    const state = newStreamMapState();
    agentEventChunks({ state, message: streamEvent({ event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "main text" } } }) });
    expect(agentEventChunks({ state, message: streamEvent({ event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "sub" } }, parent: "toolu_parent" }) })).toEqual([]);
    // same index as the main stream: keys must not collide.
    const card = agentEventChunks({ state, message: streamEvent({ event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_sub", name: "Grep", input: {} } }, parent: "toolu_parent" }) });
    expect(card).toEqual([{ type: "task_update", id: "toolu_sub", title: "Grep", status: "in_progress" }]);
    const result = agentEventChunks({ state, message: {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_sub", content: "hit" }] },
      parent_tool_use_id: "toolu_parent",
      uuid: UUID,
      session_id: SID,
    } });
    expect(result).toEqual([{ type: "task_update", id: "toolu_sub", title: "Grep", status: "complete", output: "hit" }]);
    const orphan = agentEventChunks({ state, message: {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_unknown", content: "x" }] },
      parent_tool_use_id: null,
      uuid: UUID,
      session_id: SID,
    } });
    expect(orphan).toEqual([]);
  });

  test("TodoWrite maps to one stable checklist card: no generic card, no result card", () => {
    const state = newStreamMapState();
    agentEventChunks({ state, message: streamEvent({ event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Planning." } } }) });
    // start emits nothing: no card until the list arrives
    const start = agentEventChunks({ state, message: streamEvent({ event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_td1", name: "TodoWrite", input: {} } } }) });
    expect(start).toEqual([]);
    const input = JSON.stringify({ todos: [
      { content: "Fix parser", status: "in_progress", activeForm: "Fixing parser" },
      { content: "Run tests", status: "pending", activeForm: "Running tests" },
    ] });
    agentEventChunks({ state, message: streamEvent({ event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: input } } }) });
    const stop = agentEventChunks({ state, message: streamEvent({ event: { type: "content_block_stop", index: 1 } }) });
    expect(stop).toEqual([{ type: "task_update", id: "todos", title: "Todos", status: "in_progress", details: "🔄 Fixing parser\n⬜ Run tests" }]);
    // the "Todos have been modified successfully" result is suppressed
    const result = agentEventChunks({ state, message: {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_td1", content: "Todos have been modified successfully" }] },
      parent_tool_use_id: null,
      uuid: UUID,
      session_id: SID,
    } });
    expect(result).toEqual([]);
    // ...but a FAILED TodoWrite flips the checklist card to error: the
    // optimistic checklist must not claim a state that never took effect
    const failed = agentEventChunks({ state, message: {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_td1", content: "write failed", is_error: true }] },
      parent_tool_use_id: null,
      uuid: UUID,
      session_id: SID,
    } });
    expect(failed).toEqual([{ type: "task_update", id: "todos", title: "Todos", status: "error", output: "write failed" }]);
    // a later TodoWrite reuses the SAME card id, completing it when all done
    agentEventChunks({ state, message: streamEvent({ event: { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_td2", name: "TodoWrite", input: {} } } }) });
    const allDone = JSON.stringify({ todos: [
      { content: "Fix parser", status: "completed", activeForm: "Fixing parser" },
      { content: "Run tests", status: "completed", activeForm: "Running tests" },
    ] });
    agentEventChunks({ state, message: streamEvent({ event: { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: allDone } } }) });
    const stop2 = agentEventChunks({ state, message: streamEvent({ event: { type: "content_block_stop", index: 2 } }) });
    expect(stop2).toEqual([{ type: "task_update", id: "todos", title: "Todos", status: "complete", details: "✅ Fix parser\n✅ Run tests" }]);
    // a REAL tool after the todo card still gets its own generic card
    const tool = agentEventChunks({ state, message: streamEvent({ event: { type: "content_block_start", index: 3, content_block: { type: "tool_use", id: "toolu_5", name: "Bash", input: {} } } }) });
    expect(tool).toEqual([{ type: "task_update", id: "toolu_5", title: "Bash", status: "in_progress" }]);
  });

  test("a subagent TodoWrite gets its own per-subagent card id", () => {
    const state = newStreamMapState();
    agentEventChunks({ state, message: streamEvent({ event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_td3", name: "TodoWrite", input: {} } }, parent: "toolu_parent" }) });
    const input = JSON.stringify({ todos: [{ content: "Scan repo", status: "in_progress", activeForm: "Scanning repo" }] });
    agentEventChunks({ state, message: streamEvent({ event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: input } }, parent: "toolu_parent" }) });
    const stop = agentEventChunks({ state, message: streamEvent({ event: { type: "content_block_stop", index: 0 }, parent: "toolu_parent" }) });
    expect(stop).toEqual([{ type: "task_update", id: "todos-toolu_parent", title: "Todos", status: "in_progress", details: "🔄 Scanning repo" }]);
  });

  test("local_command_output posts its content as reply text, empty stays silent", () => {
    const state = newStreamMapState();
    const chunks = agentEventChunks({ state, message: {
      type: "system",
      subtype: "local_command_output",
      content: "Current session: 13% used",
      uuid: UUID,
      session_id: SID,
    } });
    expect(chunks).toEqual(["Current session: 13% used"]);
    const empty = agentEventChunks({ state, message: {
      type: "system",
      subtype: "local_command_output",
      content: "   ",
      uuid: UUID,
      session_id: SID,
    } });
    expect(empty).toEqual([]);
  });

  test("result message emits the closing turn card", () => {
    const state = newStreamMapState();
    const chunks = agentEventChunks({ state, message: {
      type: "result",
      subtype: "success",
      duration_ms: 12400,
      duration_api_ms: 9000,
      is_error: false,
      num_turns: 1,
      result: "done",
      stop_reason: null,
      total_cost_usd: 0.0123,
      usage: {
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        inference_geo: "us",
        input_tokens: 1,
        iterations: [],
        output_tokens: 1,
        output_tokens_details: { thinking_tokens: 0 },
        server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
        service_tier: "standard" as const,
        speed: "standard" as const,
      },
      modelUsage: {},
      permission_denials: [],
      uuid: UUID,
      session_id: SID,
    } });
    expect(chunks).toEqual([{ type: "task_update", id: "turn", title: "Turn", status: "complete", details: "$0.0123  12s" }]);
  });

  test("is_error riding a success subtype closes the turn card as error", () => {
    // a mid-turn usage limit arrives exactly this way; the card must not
    // render a completed turn right before the silent retry.
    const state = newStreamMapState();
    const chunks = agentEventChunks({ state, message: {
      type: "result",
      subtype: "success",
      duration_ms: 12400,
      duration_api_ms: 9000,
      is_error: true,
      num_turns: 1,
      result: "Claude AI usage limit reached|1784369046",
      stop_reason: null,
      total_cost_usd: 0.0123,
      usage: {
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        inference_geo: "us",
        input_tokens: 1,
        iterations: [],
        output_tokens: 1,
        output_tokens_details: { thinking_tokens: 0 },
        server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
        service_tier: "standard" as const,
        speed: "standard" as const,
      },
      modelUsage: {},
      permission_denials: [],
      uuid: UUID,
      session_id: SID,
    } });
    expect(chunks).toEqual([{ type: "task_update", id: "turn", title: "Turn", status: "error", details: "$0.0123  12s" }]);
  });
});
