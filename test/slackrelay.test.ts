// relayThread driven end-to-end against fakes: the REAL segment/post pump and
// depleted-pool recovery loop, with the pool decision (../src/sdk.ts) and the
// Agent SDK query replaced by scriptable stand-ins via mock.module, and
// es-toolkit's delay duration-capped (REAL delay, real abort semantics - only
// the wait is shortened, because RETRY_DELAY_MS and PARK_GRACE_MS are fixed
// constants no parkPlan input can shrink). mock.module patches the shared
// module registry for the whole bun test process, so the mocks live in this
// dedicated file and afterAll restores the captured originals.

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { z } from "zod";

// snapshots taken BEFORE mocking: mock.module patches the live namespace, so
// spreading here is what keeps these the real implementations.
const realSdk = { ...(await import("../src/sdk.ts")) };
const realAgentSdk = { ...(await import("@anthropic-ai/claude-agent-sdk")) };
const realEsToolkit = { ...(await import("es-toolkit")) };

// scriptable state the mocked modules read at call time
const decisionQueue: { swapped: boolean; account: null; reason: string; waitUntil?: number }[] = [];
const queryScripts: (() => AsyncGenerator<unknown, void, unknown>)[] = [];
const queryCalls: { prompt: string; options: Record<string, unknown> }[] = [];

mock.module("../src/sdk.ts", () => ({
  ...realSdk,
  ensureBestAccount: async () => {
    const d = decisionQueue.shift();
    if (d === undefined) throw new Error("test: decision queue exhausted");
    return d;
  },
  pooledOptions: () => ({ pathToClaudeCodeExecutable: "/usr/bin/true", env: {} }),
  stopHookCheck: async () => ({}),
}));

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  ...realAgentSdk,
  query: (input: { prompt: string; options: Record<string, unknown> }) => {
    queryCalls.push(input);
    const script = queryScripts.shift();
    if (script === undefined) throw new Error("test: query script queue exhausted");
    return script();
  },
  createSdkMcpServer: (def: unknown) => def,
  tool: (...parts: unknown[]) => parts,
}));

const DELAY_CAP_MS = 250;
mock.module("es-toolkit", () => ({
  ...realEsToolkit,
  delay: (ms: number, opts?: { signal?: AbortSignal }) => realEsToolkit.delay(Math.min(Math.max(ms, 0), DELAY_CAP_MS), opts),
}));

const { relayThread, MAX_RECOVERIES, PARK_MAX_MS } = await import("../src/lib/slackbridge.ts");
const { SlackLinkSchema } = await import("../src/lib/slackstate.ts");
const { loadUsage, writeUsage } = await import("../src/lib/state.ts");

afterAll(() => {
  mock.module("../src/sdk.ts", () => realSdk);
  mock.module("@anthropic-ai/claude-agent-sdk", () => realAgentSdk);
  mock.module("es-toolkit", () => realEsToolkit);
});

afterEach(() => {
  decisionQueue.length = 0;
  queryScripts.length = 0;
  queryCalls.length = 0;
});

const link = SlackLinkSchema.parse({ channel: "C0RELAY", repo: "/tmp/relay-test-repo" });
const usable = { swapped: false, account: null, reason: "current-best" };
const depleted = (waitUntil?: number) => ({ swapped: false, account: null, reason: "all-depleted", ...(waitUntil === undefined ? {} : { waitUntil }) });

// ---- fake SDK message stream ----------------------------------------------

const init = (sessionId: string) => ({ type: "system", subtype: "init", session_id: sessionId });
const textDelta = (text: string) => ({
  type: "stream_event",
  parent_tool_use_id: null,
  event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
});
const toolStart = (id: string, name: string) => ({
  type: "stream_event",
  parent_tool_use_id: null,
  event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id, name } },
});
const toolStop = () => ({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_stop", index: 1 } });
const success = (sessionId: string, result = "done") => ({
  type: "result",
  subtype: "success",
  is_error: false,
  session_id: sessionId,
  result,
  modelUsage: {},
  total_cost_usd: 0.01,
  duration_ms: 1000,
});
// the exact mid-turn limit shape: is_error rides subtype "success".
const limitErrored = (sessionId: string, resultText: string) => ({
  type: "result",
  subtype: "success",
  is_error: true,
  session_id: sessionId,
  result: resultText,
  modelUsage: {},
  total_cost_usd: 0,
  duration_ms: 100,
});

function script(messages: unknown[]): () => AsyncGenerator<unknown, void, unknown> {
  return async function* () {
    for (const m of messages) yield m;
  };
}

// ---- fake Slack post -------------------------------------------------------

function collector(input?: { rejectTimes?: number }) {
  let rejectLeft = input?.rejectTimes ?? 0;
  const posts: unknown[][] = [];
  const timeline: string[] = [];
  let calls = 0;
  const post = async (m: AsyncIterable<unknown>) => {
    calls += 1;
    const n = calls;
    if (rejectLeft > 0) {
      rejectLeft -= 1;
      throw new Error("message_not_in_streaming_state");
    }
    timeline.push(`open:${n}`);
    const chunks: unknown[] = [];
    posts.push(chunks);
    for await (const c of m) chunks.push(c);
    timeline.push(`close:${n}`);
  };
  return { posts, timeline, post, calls: () => calls };
}

const strings = (chunks: unknown[] | undefined) =>
  (chunks ?? [])
    .flatMap((c) => {
      const s = z.string().safeParse(c);
      return s.success ? [s.data] : [];
    })
    .join("");

const TaskCardSchema = z.looseObject({ type: z.literal("task_update"), id: z.string() });

function seedIdentityAndUsage(org: string, now: number): void {
  writeFileSync(process.env.TOKENMAXXING_CLAUDE_JSON!, JSON.stringify({ oauthAccount: { accountUuid: "u-relay", emailAddress: "relay@e.com", organizationUuid: org } }));
  writeUsage({
    fiveHour: { usedPercentage: 40, resetsAt: now + 3_600_000 },
    sevenDay: { usedPercentage: 10, resetsAt: now + 86_400_000 },
    org,
    ts: now - 60_000,
    model: null,
  });
}

const relay = (input: { post: (m: AsyncIterable<unknown>) => Promise<unknown>; sessionId?: string | null; drainSignal?: AbortSignal }) =>
  relayThread({
    cwd: "/tmp/relay-test-repo",
    sessionId: input.sessionId ?? null,
    prompt: "do the thing",
    requesterIds: ["U-REQ"],
    link,
    post: input.post,
    drainSignal: input.drainSignal,
  });

describe("relayThread depleted-pool recovery", () => {
  test("parks on a near recovery, notifies the thread, then runs the turn after the wake", async () => {
    decisionQueue.push(depleted(Date.now() + 60_000), usable);
    queryScripts.push(script([init("s-park"), textDelta("hi there"), success("s-park")]));
    const col = collector();
    const out = await relay({ post: col.post });
    expect(out.failed).toBe(false);
    expect(out.rateLimited).toBe(false);
    expect(out.sessionId).toBe("s-park");
    expect(queryCalls.length).toBe(1);
    expect(strings(col.posts[0])).toContain("holding this message");
    expect(strings(col.posts[1])).toContain("hi there");
  });

  test("drops honestly when recovery is unknown, without spawning", async () => {
    decisionQueue.push(depleted());
    const col = collector();
    const out = await relay({ post: col.post });
    expect(out.failed).toBe(true);
    expect(out.rateLimited).toBe(true);
    expect(queryCalls.length).toBe(0);
    expect(strings(col.posts[0])).toContain("unknown time");
    expect(strings(col.posts[0])).toContain("dropped");
  });

  test("drops honestly when recovery lands past the message deadline", async () => {
    decisionQueue.push(depleted(Date.now() + PARK_MAX_MS + 120_000));
    const col = collector();
    const out = await relay({ post: col.post });
    expect(out.failed).toBe(true);
    expect(out.rateLimited).toBe(true);
    expect(queryCalls.length).toBe(0);
    expect(strings(col.posts[0])).toContain("recovers in ~");
    expect(strings(col.posts[0])).toContain("dropped");
  });

  test("persists a mid-turn limit and silently retries into the SAME session", async () => {
    const now = Date.now();
    seedIdentityAndUsage("org-relay", now);
    const resetEpochSec = Math.floor((now + 3_600_000) / 1000);
    decisionQueue.push(usable, usable);
    queryScripts.push(script([init("s-limit"), limitErrored("s-limit", `Claude AI usage limit reached|${resetEpochSec}`)]));
    queryScripts.push(script([init("s-limit"), textDelta("recovered"), success("s-limit")]));
    const col = collector();
    const out = await relay({ post: col.post });
    expect(out.failed).toBe(false);
    expect(out.sessionId).toBe("s-limit");
    expect(queryCalls.length).toBe(2);
    // the retry resumes the session the failed attempt opened
    expect(queryCalls[1]?.options.resume).toBe("s-limit");
    // the observation was persisted before the retry re-decides
    const u = loadUsage();
    expect(u?.fiveHour).toEqual({ usedPercentage: 100, resetsAt: resetEpochSec * 1000 });
    // silent: no limit notice ever reaches the thread
    const allText = col.posts.map(strings).join(" ");
    expect(allText).not.toContain("usage limit");
    expect(allText).toContain("recovered");
  });

  test("announces the drop once MAX_RECOVERIES limit retries are burnt", async () => {
    const now = Date.now();
    seedIdentityAndUsage("org-relay", now);
    const attempts = MAX_RECOVERIES + 1;
    for (let i = 0; i < attempts; i += 1) {
      decisionQueue.push(usable);
      queryScripts.push(script([init("s-burnt"), limitErrored("s-burnt", "You've hit your weekly limit.")]));
    }
    const col = collector();
    const out = await relay({ post: col.post });
    expect(out.failed).toBe(true);
    expect(out.rateLimited).toBe(true);
    expect(queryCalls.length).toBe(attempts);
    const allText = col.posts.map(strings).join(" ");
    expect(allText).toContain("still at a usage limit after retries");
    expect(allText).toContain("dropped");
  });

  test("a drain abort mid-park posts the restart notice and stops", async () => {
    decisionQueue.push(depleted(Date.now() + 600_000));
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);
    const col = collector();
    const out = await relay({ post: col.post, drainSignal: ac.signal });
    expect(out.failed).toBe(true);
    expect(queryCalls.length).toBe(0);
    expect(strings(col.posts[0])).toContain("holding this message");
    expect(strings(col.posts[1])).toContain("restarting");
  });
});

describe("relayThread segment ordering", () => {
  test("a tool call after streamed text stays in ONE Slack message: cards group into the turn's plan block", async () => {
    decisionQueue.push(usable);
    queryScripts.push(script([
      init("s-seg"),
      textDelta("before tools"),
      toolStart("tool-1", "Bash"),
      toolStop(),
      textDelta("after tools"),
      success("s-seg"),
    ]));
    const col = collector();
    const out = await relay({ post: col.post });
    expect(out.failed).toBe(false);
    expect(col.posts.length).toBe(1);
    expect(col.timeline).toEqual(["open:1", "close:1"]);
    expect(strings(col.posts[0])).toBe("before toolsafter tools");
    const cardIds = (col.posts[0] ?? []).flatMap((c) => {
      const card = TaskCardSchema.safeParse(c);
      return card.success ? [card.data.id] : [];
    });
    expect(cardIds).toContain("tool-1");
  });

  test("a rejected post drops the dead segment and the next chunk opens a fresh message", async () => {
    decisionQueue.push(usable);
    queryScripts.push(() =>
      (async function* () {
        yield init("s-dead");
        yield textDelta("lost text");
        // give the rejected post's catch a beat to drop the dead segment
        await realEsToolkit.delay(15);
        yield textDelta("fresh text");
        yield success("s-dead");
      })(),
    );
    const col = collector({ rejectTimes: 1 });
    const out = await relay({ post: col.post });
    expect(out.failed).toBe(false);
    expect(col.calls()).toBe(2);
    // only the second post survived; the dead segment's chunks vanished with it
    expect(col.posts.length).toBe(1);
    expect(strings(col.posts[0])).toContain("fresh text");
    expect(strings(col.posts[0])).not.toContain("lost text");
  });

  test("lost reply text with no re-delivery fails the turn and posts a diagnostic", async () => {
    // The closing Turn card opens its own (successful) post after the rejected
    // text segment - the stream "recovers" but the ANSWER is gone. Card-only
    // recovery must not read as success.
    decisionQueue.push(usable);
    queryScripts.push(() =>
      (async function* () {
        yield init("s-tail");
        yield textDelta("final answer");
        yield success("s-tail");
      })(),
    );
    const col = collector({ rejectTimes: 1 });
    const out = await relay({ post: col.post });
    expect(out.failed).toBe(true);
    const delivered = col.posts.map((p) => strings(p));
    expect(delivered.some((s) => s.includes("could not be posted"))).toBe(true);
    expect(delivered.some((s) => s.includes("final answer"))).toBe(false);
  });

  test("a rejecting diagnostic never escapes relayThread", async () => {
    decisionQueue.push(usable);
    queryScripts.push(() =>
      (async function* () {
        yield init("s-tail2");
        yield textDelta("final answer");
        yield success("s-tail2");
      })(),
    );
    const col = collector({ rejectTimes: 3 }); // text, card, and the diagnostic all reject
    const out = await relay({ post: col.post }); // resolving IS the assertion
    expect(out.failed).toBe(true);
    expect(col.posts.length).toBe(0);
  });
});
