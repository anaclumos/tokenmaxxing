// Maps Claude Agent SDK messages onto Chat SDK stream chunks so a relayed
// Slack turn shows the agent's process natively: task cards for thinking and
// tool calls (pending -> in_progress -> complete/error), streamed text via
// markdown_text, and a closing turn card with model/cost/duration. Structured
// chunks render only when the Slack app has the agent feature + assistant:write
// (the adapter drops them gracefully otherwise); plain text streams either way.

import { z } from "zod";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { StreamChunk } from "chat";

const DETAILS_MAX = 400;
const OUTPUT_MAX = 600;

/** Natural activity labels for tool cards (user ask 2026-07-18: these five raw
 *  names read awkwardly in Slack). Every other tool name renders verbatim; a
 *  Map keeps prototype keys like "toString" from shadowing the fallback. */
const TOOL_TITLES = new Map([
  ["TaskCreate", "Creating task"],
  ["TaskUpdate", "Updating task"],
  ["ToolSearch", "Loading tools"],
  ["WebFetch", "Fetching page"],
  ["WebSearch", "Searching the web"],
]);

export function toolCardTitle(name: string): string {
  return TOOL_TITLES.get(name) ?? name;
}

/** Tool-input fields worth showing on a task card, most human-readable first. */
const SUMMARY_FIELDS = ["command", "description", "file_path", "pattern", "prompt", "query", "url"] as const;

const OpenBlockSchema = z.object({
  kind: z.enum(["thinking", "tool"]),
  id: z.string(),
  title: z.string(),
  /** accumulated thinking text or partial tool-input JSON. */
  acc: z.string(),
});
type OpenBlock = z.infer<typeof OpenBlockSchema>;

export const StreamMapStateSchema = z.object({
  /** open content blocks by stream index. */
  open: z.record(z.string(), OpenBlockSchema),
  /** tool_use id -> tool name, for labeling the eventual tool_result. */
  toolTitles: z.record(z.string(), z.string()),
  thinkingCount: z.number(),
  /** reply text streamed since the last segment break. */
  textSinceBreak: z.boolean(),
});
export type StreamMapState = z.infer<typeof StreamMapStateSchema>;

export function newStreamMapState(): StreamMapState {
  return { open: {}, toolTitles: {}, thinkingCount: 0, textSinceBreak: false };
}

/** Emitted when a tool starts after streamed reply text: the bridge closes the
 *  current Slack message there and posts the rest as a new one, mirroring how
 *  an agent turn reads as separate messages around its tool runs. */
export const SegmentBreakSchema = z.object({ type: z.literal("segment_break") });
export type SegmentBreak = z.infer<typeof SegmentBreakSchema>;

export const StreamPartSchema = z.union([z.string(), z.custom<StreamChunk>(), SegmentBreakSchema]);
export type StreamPart = z.infer<typeof StreamPartSchema>;

function truncate(input: { text: string; max: number }): string {
  return input.text.length > input.max ? `${input.text.slice(0, input.max)}...` : input.text;
}

/** One human line out of a tool-input JSON blob; null when nothing fits. */
export function toolInputSummary(rawJson: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return null; // partial or empty input JSON - show the bare tool name
  }
  const obj = z.record(z.string(), z.unknown()).safeParse(parsed);
  if (!obj.success) return null;
  for (const field of SUMMARY_FIELDS) {
    const value = z.string().min(1).safeParse(obj.data[field]);
    if (value.success) return truncate({ text: value.data, max: DETAILS_MAX });
  }
  const compact = JSON.stringify(parsed);
  return compact === "{}" ? null : truncate({ text: compact, max: DETAILS_MAX });
}

const ToolResultBlockSchema = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  content: z.union([z.string(), z.array(z.unknown())]).optional(),
  is_error: z.boolean().optional(),
});

const TextPartSchema = z.object({ type: z.literal("text"), text: z.string() });

function resultText(content: z.infer<typeof ToolResultBlockSchema>["content"]): string | undefined {
  if (content === undefined) return undefined;
  const joined = Array.isArray(content)
    ? content
        .flatMap((part) => {
          const p = TextPartSchema.safeParse(part);
          return p.success ? [p.data.text] : [];
        })
        .join("\n")
    : content;
  const trimmed = joined.trim();
  return trimmed === "" ? undefined : truncate({ text: trimmed, max: OUTPUT_MAX });
}

/**
 * Consume one SDK message, mutating state, and return the stream chunks it
 * produces (strings are streamed reply text; objects are native task cards).
 * Subagent events (parent_tool_use_id set) contribute their TOOL cards to the
 * timeline (user ask 2026-07-18: subagent activity shows as accordions like
 * tool calls) but never reply text, thinking cards, or segment breaks: a
 * subagent runs inside a top-level Task tool, so its churn decorates the
 * current message rather than reshaping it. Open blocks are keyed per stream
 * (parent + index) because concurrent subagent streams reuse index space.
 */
export function agentEventChunks(input: { state: StreamMapState; message: SDKMessage }): StreamPart[] {
  const { state, message } = input;
  if (message.type === "stream_event") {
    const isMain = message.parent_tool_use_id === null;
    const event = message.event;
    if (event.type === "content_block_start") {
      const key = `${message.parent_tool_use_id ?? "main"}:${event.index}`;
      if (event.content_block.type === "thinking" && isMain) {
        state.thinkingCount += 1;
        const id = `thinking-${state.thinkingCount}`;
        state.open[key] = { kind: "thinking", id, title: "Thinking", acc: "" };
        return [{ type: "task_update", id, title: "Thinking", status: "in_progress" }];
      }
      if (event.content_block.type === "tool_use") {
        const { id, name } = event.content_block;
        const title = toolCardTitle(name);
        state.open[key] = { kind: "tool", id, title, acc: "" };
        state.toolTitles[id] = title;
        const card: StreamPart = { type: "task_update", id, title, status: "in_progress" };
        if (isMain && state.textSinceBreak) {
          state.textSinceBreak = false;
          return [{ type: "segment_break" }, card];
        }
        return [card];
      }
      return [];
    }
    if (event.type === "content_block_delta") {
      const open = state.open[`${message.parent_tool_use_id ?? "main"}:${event.index}`];
      if (event.delta.type === "text_delta") {
        if (!isMain) return [];
        // whitespace-only deltas must not count as reply text: a "\n\n"
        // before a tool call would otherwise break the segment and strand a
        // near-blank Slack message.
        if (event.delta.text.trim() !== "") state.textSinceBreak = true;
        return [event.delta.text];
      }
      if (event.delta.type === "thinking_delta" && open) open.acc += event.delta.thinking;
      if (event.delta.type === "input_json_delta" && open) open.acc += event.delta.partial_json;
      return [];
    }
    if (event.type === "content_block_stop") {
      const key = `${message.parent_tool_use_id ?? "main"}:${event.index}`;
      const open = state.open[key];
      if (!open) return [];
      delete state.open[key];
      if (open.kind === "thinking") {
        return [{ type: "task_update", id: open.id, title: open.title, status: "complete", details: truncate({ text: open.acc.trim(), max: DETAILS_MAX }) }];
      }
      const details = toolInputSummary(open.acc);
      return [{ type: "task_update", id: open.id, title: open.title, status: "in_progress", ...(details ? { details } : {}) }];
    }
    return [];
  }
  if (message.type === "user") {
    const content = message.message.content;
    if (!Array.isArray(content)) return [];
    const chunks: StreamChunk[] = [];
    for (const block of content) {
      const parsed = ToolResultBlockSchema.safeParse(block);
      if (!parsed.success) continue;
      const title = state.toolTitles[parsed.data.tool_use_id];
      if (title === undefined) continue;
      const output = resultText(parsed.data.content);
      chunks.push({
        type: "task_update",
        id: parsed.data.tool_use_id,
        title,
        status: parsed.data.is_error === true ? "error" : "complete",
        ...(output ? { output } : {}),
      });
    }
    return chunks;
  }
  if (message.type === "system" && message.subtype === "local_command_output") {
    // Slash-command relay (user ask 2026-07-18): a leading-slash prompt runs
    // as a claude slash command CLI-side, and a local command's output
    // (/usage, /context, ...) arrives as a non-streamed assistant message
    // plus result.result with num_turns 0 - relayThread's no-text fallback
    // posts that (verified live on SDK 0.3.214 + claude 2.1.214, fresh and
    // resumed). This subtype is the SDK's documented wire surface for the
    // same output, so map it too: if a claude update flips the engine to
    // emitting it, the output still posts, and having posted text suppresses
    // the result fallback so it never double-posts.
    if (message.content.trim() === "") return [];
    state.textSinceBreak = true;
    return [message.content];
  }
  if (message.type === "result") {
    const models = Object.keys(message.modelUsage).join(" ");
    const cost = `$${message.total_cost_usd.toFixed(4)}`;
    const secs = `${Math.round(message.duration_ms / 1000)}s`;
    return [{
      type: "task_update",
      id: "turn",
      title: "Turn",
      status: message.subtype === "success" ? "complete" : "error",
      details: [models, cost, secs].filter((p) => p !== "").join("  "),
    }];
  }
  return [];
}
