// slackstream: Agent SDK message -> Chat SDK stream chunk mapping.

import { describe, expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { agentEventChunks, newStreamMapState, toolInputSummary } from "../src/lib/slackstream.ts";

const UUID = "00000000-0000-0000-0000-000000000000";
const SID = "test-session";

function streamEvent(input: { event: Extract<SDKMessage, { type: "stream_event" }>["event"]; parent?: string }): SDKMessage {
  return { type: "stream_event", event: input.event, parent_tool_use_id: input.parent ?? null, uuid: UUID, session_id: SID };
}

describe("toolInputSummary", () => {
  test("prefers the command field, falls back to compact json, null on junk", () => {
    expect(toolInputSummary('{"command":"bun test","timeout":5}')).toBe("bun test");
    expect(toolInputSummary('{"file_path":"/tmp/x.ts"}')).toBe("/tmp/x.ts");
    expect(toolInputSummary('{"weird":42}')).toBe('{"weird":42}');
    expect(toolInputSummary("{}")).toBeNull();
    expect(toolInputSummary('{"command":')).toBeNull();
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

  test("a tool starting after streamed text emits a segment break first", () => {
    const state = newStreamMapState();
    agentEventChunks({ state, message: streamEvent({ event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "I will check." } } }) });
    const chunks = agentEventChunks({ state, message: streamEvent({ event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_3", name: "Bash", input: {} } } }) });
    expect(chunks).toEqual([
      { type: "segment_break" },
      { type: "task_update", id: "toolu_3", title: "Bash", status: "in_progress" },
    ]);
    // a second tool with no text in between must NOT break again
    const again = agentEventChunks({ state, message: streamEvent({ event: { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_4", name: "Read", input: {} } } }) });
    expect(again).toEqual([{ type: "task_update", id: "toolu_4", title: "Read", status: "in_progress" }]);
  });

  test("subagent events and unknown tool results are skipped", () => {
    const state = newStreamMapState();
    expect(agentEventChunks({ state, message: streamEvent({ event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "sub" } }, parent: "toolu_parent" }) })).toEqual([]);
    const orphan = agentEventChunks({ state, message: {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_unknown", content: "x" }] },
      parent_tool_use_id: null,
      uuid: UUID,
      session_id: SID,
    } });
    expect(orphan).toEqual([]);
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
});
