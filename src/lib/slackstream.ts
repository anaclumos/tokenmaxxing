// Maps Claude Agent SDK messages onto Chat SDK stream chunks so a relayed
// Slack turn shows the agent's process natively: task cards for thinking and
// tool calls (pending -> in_progress -> complete/error), streamed text via
// markdown_text, and a closing turn card with model/cost/duration. All task
// cards in a turn group into ONE collapsible Slack plan block (user ask
// 2026-07-20: "squash them into one dropdown"; the serve edge posts each turn
// as a StreamingPlan with groupTasks "plan", superseding the 2026-07-18
// separate-messages-around-tool-runs shape), so this mapper emits no segment
// breaks: a turn is one streamed message. TodoWrite is special-cased into one
// stable "Todos" checklist card per stream that updates in place as items
// progress. Structured chunks render only when the Slack app has the agent
// feature + assistant:write (the adapter drops them gracefully otherwise);
// plain text streams either way.

import { truncate } from "es-toolkit/compat";
import { z } from "zod";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { StreamChunk } from "chat";

const DETAILS_MAX = 400;
const OUTPUT_MAX = 600;
/** Slack docs claim a 256-char cap on task_update chunks, yet 400/600-char
 *  card fields render fine (live-verified 2026-07-18). 600 is the largest
 *  size observed rendering; staying inside that envelope beats trusting an
 *  unverified bigger budget (a ~15-line checklist still fits). */
const TODO_DETAILS_MAX = 600;

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
  kind: z.enum(["thinking", "tool", "todo"]),
  id: z.string(),
  title: z.string(),
  /** accumulated thinking text or partial tool-input JSON. */
  acc: z.string(),
});
type OpenBlock = z.infer<typeof OpenBlockSchema>;

const StreamMapStateSchema = z.object({
  /** open content blocks by stream index. */
  open: z.record(z.string(), OpenBlockSchema),
  /** tool_use id -> tool name, for labeling the eventual tool_result. */
  toolTitles: z.record(z.string(), z.string()),
  /** TodoWrite tool_use id -> stable checklist-card id: a successful result
   *  is suppressed as noise, but a FAILED write must flip the card to error
   *  (the optimistic checklist would otherwise claim a state that never took
   *  effect). */
  todoCards: z.record(z.string(), z.string()),
  thinkingCount: z.number(),
});
export type StreamMapState = z.infer<typeof StreamMapStateSchema>;

export function newStreamMapState(): StreamMapState {
  return { open: {}, toolTitles: {}, todoCards: {}, thinkingCount: 0 };
}

const StreamPartSchema = z.union([z.string(), z.custom<StreamChunk>()]);
export type StreamPart = z.infer<typeof StreamPartSchema>;

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
    if (value.success) return truncate(value.data, { length: DETAILS_MAX });
  }
  const compact = JSON.stringify(parsed);
  return compact === "{}" ? null : truncate(compact, { length: DETAILS_MAX });
}

const TodoItemSchema = z.object({
  content: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]),
  activeForm: z.string(),
});
const TodoListSchema = z.object({ todos: z.array(TodoItemSchema) });

/** Same status iconography the Chat SDK's own Plan object renders with. */
const TODO_ICONS = { completed: "✅", in_progress: "🔄", pending: "⬜" } as const;

/** The stable checklist-card id: every TodoWrite in the same stream updates
 *  one card in place instead of stacking a new card per call. */
function todoCardId(parent: string | null): string {
  return parent === null ? "todos" : `todos-${parent}`;
}

/** Checklist text out of a TodoWrite input blob; null when empty or junk.
 *  The in-progress item shows its activeForm ("Running tests") so the card
 *  reads as live narration, not a static list. An empty todos list maps to
 *  null on purpose: claude clears the list only after everything completed,
 *  and skipping that update keeps the finished all-checked card visible
 *  instead of blanking it (intentional tradeoff, PR #5 review). */
export function todoChecklist(rawJson: string): { text: string; allDone: boolean } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return null;
  }
  const list = TodoListSchema.safeParse(parsed);
  if (!list.success || list.data.todos.length === 0) return null;
  const lines = list.data.todos.map((t) => {
    const label = t.status === "in_progress" && t.activeForm !== "" ? t.activeForm : t.content;
    return `${TODO_ICONS[t.status]} ${label}`;
  });
  return {
    text: truncate(lines.join("\n"), { length: TODO_DETAILS_MAX }),
    allDone: list.data.todos.every((t) => t.status === "completed"),
  };
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
  return trimmed === "" ? undefined : truncate(trimmed, { length: OUTPUT_MAX });
}

/**
 * Consume one SDK message, mutating state, and return the stream chunks it
 * produces (strings are streamed reply text; objects are native task cards,
 * all of which Slack folds into the turn's single plan block). Subagent
 * events (parent_tool_use_id set) contribute their TOOL cards to that plan
 * (user ask 2026-07-18: subagent activity shows alongside tool calls) but
 * never reply text or thinking cards: a subagent runs inside a top-level Task
 * tool, so its churn decorates the turn rather than reshaping it. Open blocks
 * are keyed per stream (parent + index) because concurrent subagent streams
 * reuse index space.
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
        if (name === "TodoWrite") {
          // bookkeeping, not a real tool run: no card until the list arrives,
          // and no toolTitles entry (its "Todos have been modified" success
          // result is noise; failures still surface via todoCards below).
          const cardId = todoCardId(message.parent_tool_use_id);
          state.open[key] = { kind: "todo", id: cardId, title: "Todos", acc: "" };
          state.todoCards[id] = cardId;
          return [];
        }
        const title = toolCardTitle(name);
        state.open[key] = { kind: "tool", id, title, acc: "" };
        state.toolTitles[id] = title;
        return [{ type: "task_update", id, title, status: "in_progress" }];
      }
      return [];
    }
    if (event.type === "content_block_delta") {
      const open = state.open[`${message.parent_tool_use_id ?? "main"}:${event.index}`];
      if (event.delta.type === "text_delta") {
        if (!isMain) return [];
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
        return [{ type: "task_update", id: open.id, title: open.title, status: "complete", details: truncate(open.acc.trim(), { length: DETAILS_MAX }) }];
      }
      if (open.kind === "todo") {
        const list = todoChecklist(open.acc);
        if (list === null) return [];
        return [{ type: "task_update", id: open.id, title: open.title, status: list.allDone ? "complete" : "in_progress", details: list.text }];
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
      const todoCard = state.todoCards[parsed.data.tool_use_id];
      if (todoCard !== undefined) {
        if (parsed.data.is_error !== true) continue;
        const output = resultText(parsed.data.content);
        chunks.push({ type: "task_update", id: todoCard, title: "Todos", status: "error", ...(output ? { output } : {}) });
        continue;
      }
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
      // is_error can ride subtype "success" (a mid-turn usage limit does),
      // and that turn must not render as complete.
      status: message.subtype === "success" && message.is_error !== true ? "complete" : "error",
      details: [models, cost, secs].filter((p) => p !== "").join("  "),
    }];
  }
  return [];
}
