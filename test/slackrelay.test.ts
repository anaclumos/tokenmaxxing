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
const queryCalls: { prompt: unknown; options: Record<string, unknown> }[] = [];

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
  query: (input: { prompt: unknown; options: Record<string, unknown> }) => {
    queryCalls.push(input);
    const script = queryScripts.shift();
    if (script === undefined) throw new Error("test: query script queue exhausted");
    return script();
  },
  createSdkMcpServer: (def: unknown) => def,
  tool: (...parts: unknown[]) => parts,
}));

/** Drain a captured streaming-input prompt into its user-message texts. The
 *  mocked query never consumes the iterable, so a post-hoc drain replays
 *  everything relayThread pushed, in order; end() has already closed it by
 *  the time an awaited relay returns. */
const StreamedUserMessageSchema = z.object({
  type: z.literal("user"),
  message: z.object({ content: z.array(z.object({ type: z.literal("text"), text: z.string() })) }),
});
async function promptTexts(prompt: unknown): Promise<string[]> {
  const iterable = z.custom<AsyncIterable<unknown>>((v) => typeof v === "object" && v !== null && Symbol.asyncIterator in v).parse(prompt);
  const texts: string[] = [];
  for await (const m of iterable) {
    texts.push(StreamedUserMessageSchema.parse(m).message.content.map((b) => b.text).join(""));
  }
  return texts;
}

const DELAY_CAP_MS = 250;
mock.module("es-toolkit", () => ({
  ...realEsToolkit,
  delay: (ms: number, opts?: { signal?: AbortSignal }) => realEsToolkit.delay(Math.min(Math.max(ms, 0), DELAY_CAP_MS), opts),
}));

const { relayThread, MAX_RECOVERIES, MAX_TRANSIENT_RETRIES, PARK_MAX_MS, SEGMENT_ROTATION, SEGMENT_TEXT_MAX } = await import("../src/lib/slackbridge.ts");
const { StreamingMarkdownRenderer } = await import("chat");
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
const textStart = (index = 0) => ({
  type: "stream_event",
  parent_tool_use_id: null,
  event: { type: "content_block_start", index, content_block: { type: "text", text: "" } },
});
const textDelta = (text: string, index = 0) => ({
  type: "stream_event",
  parent_tool_use_id: null,
  event: { type: "content_block_delta", index, delta: { type: "text_delta", text } },
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

// Renderer-faithful fake of @chat-adapter/slack 4.34.0 stream(): per pulled
// text chunk it pushes into the REAL StreamingMarkdownRenderer (same options
// as the adapter) and appends the committable delta; card chunks flush text
// first; after the iterable exhausts, finish() + one forced final append flush
// the renderer-held tail. An append whose delta contains an armed poison fails
// ONCE (Slack finalizing an idle stream kills one message; the salvage re-send
// then lands) - so a poison in text the renderer holds back fires at the
// post-iteration forced flush, exactly like the live incident (pullfrog catch
// on PR #45).
function rendererCollector(input?: { poisons?: string[] }) {
  const remaining = new Set(input?.poisons ?? []);
  const posts: { deltas: string[]; cards: unknown[] }[] = [];
  let calls = 0;
  const post = async (m: AsyncIterable<unknown>) => {
    calls += 1;
    const renderer = new StreamingMarkdownRenderer({ wrapTablesForAppend: false });
    let appended = "";
    const rec: { deltas: string[]; cards: unknown[] } = { deltas: [], cards: [] };
    posts.push(rec);
    const flush = () => {
      const committable = renderer.getCommittableText();
      const delta = committable.slice(appended.length);
      if (delta.length === 0) return;
      const hit = [...remaining].find((p) => delta.includes(p));
      if (hit !== undefined) {
        remaining.delete(hit);
        throw new Error("An API error occurred: message_not_in_streaming_state");
      }
      rec.deltas.push(delta);
      appended = committable;
    };
    for await (const c of m) {
      const s = z.string().safeParse(c);
      if (s.success) {
        renderer.push(s.data);
        flush();
      } else {
        flush();
        rec.cards.push(c);
      }
    }
    renderer.finish();
    flush();
  };
  const delivered = () => posts.map((p) => p.deltas.join(""));
  return { posts, post, calls: () => calls, delivered };
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

const relay = (input: {
  post: (m: AsyncIterable<unknown>) => Promise<unknown>;
  sessionId?: string | null;
  drainSignal?: AbortSignal;
  onSteer?: (steer: ((text: string) => boolean) | null) => void;
}) =>
  relayThread({
    cwd: "/tmp/relay-test-repo",
    sessionId: input.sessionId ?? null,
    prompt: "do the thing",
    requesterIds: ["U-REQ"],
    link,
    post: input.post,
    drainSignal: input.drainSignal,
    onSteer: input.onSteer,
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
    // strict message order across segments: the park notice fully posts
    // before the turn's message opens (the invariant relayThread's push
    // pins with `await lastPost`).
    expect(col.timeline).toEqual(["open:1", "close:1", "open:2", "close:2"]);
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

  test("DEFERS when recovery lands past the message deadline: resume promise, never a re-send ask", async () => {
    const wake = Date.now() + PARK_MAX_MS + 120_000;
    decisionQueue.push(depleted(wake));
    const col = collector();
    const out = await relay({ post: col.post });
    expect(out.failed).toBe(true);
    expect(out.rateLimited).toBe(true);
    expect(out.deferUntil).toBe(wake + 5_000);
    expect(out.announcedDrop).toBe(false);
    expect(queryCalls.length).toBe(0);
    expect(strings(col.posts[0])).toContain("resume automatically");
    expect(strings(col.posts[0])).not.toContain("re-send");
  });

  test("an unclassifiable child failure against an exhausted pool converts to a deferral", async () => {
    // the 2026-07-20 death: "Claude Code process exited with code 1" carries
    // no limit phrase, but the pool state is the evidence.
    const wake = Date.now() + 3_600_000;
    decisionQueue.push(usable, depleted(wake));
    queryScripts.push(() =>
      (async function* () {
        yield init("s-crash");
        throw new Error("Claude Code process exited with code 1");
      })(),
    );
    const col = collector();
    const out = await relay({ post: col.post });
    expect(out.failed).toBe(true);
    expect(out.rateLimited).toBe(true);
    expect(out.deferUntil).toBe(wake + 5_000);
    const allText = col.posts.map(strings).join(" ");
    expect(allText).toContain("resume automatically");
    // the raw failure line is held back on a deferral: it would invite a
    // manual re-send of work the daemon resumes itself (cubic catch).
    expect(allText).not.toContain("turn failed");
  });

  test("an unclassifiable failure with a USABLE pool stays a plain failure", async () => {
    decisionQueue.push(usable, usable);
    queryScripts.push(() =>
      (async function* () {
        yield init("s-crash2");
        throw new Error("something unrelated broke");
      })(),
    );
    const col = collector();
    const out = await relay({ post: col.post });
    expect(out.failed).toBe(true);
    expect(out.rateLimited).toBe(false);
    expect(out.deferUntil).toBeNull();
    expect(col.posts.map(strings).join(" ")).toContain("turn failed");
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

  test("burnt retries DEFER when the post-burn probe knows the pool's recovery clock", async () => {
    const now = Date.now();
    seedIdentityAndUsage("org-relay", now);
    const wake = now + 7_200_000;
    const attempts = MAX_RECOVERIES + 1;
    for (let i = 0; i < attempts; i += 1) {
      decisionQueue.push(usable);
      queryScripts.push(script([init("s-burnt"), limitErrored("s-burnt", "You've hit your weekly limit.")]));
    }
    decisionQueue.push(depleted(wake)); // the post-burn probe
    const col = collector();
    const out = await relay({ post: col.post });
    expect(out.failed).toBe(true);
    expect(out.rateLimited).toBe(true);
    expect(out.deferUntil).toBe(wake + 5_000);
    expect(queryCalls.length).toBe(attempts);
    const allText = col.posts.map(strings).join(" ");
    expect(allText).toContain("still at a usage limit after retries");
    expect(allText).toContain("resume automatically");
    expect(allText).not.toContain("dropped");
  });

  test("burnt retries still drop honestly when the probe reports no recovery clock", async () => {
    const now = Date.now();
    seedIdentityAndUsage("org-relay", now);
    const attempts = MAX_RECOVERIES + 1;
    for (let i = 0; i < attempts; i += 1) {
      decisionQueue.push(usable);
      queryScripts.push(script([init("s-burnt2"), limitErrored("s-burnt2", "You've hit your weekly limit.")]));
    }
    decisionQueue.push(depleted()); // depleted, wake unknown
    const col = collector();
    const out = await relay({ post: col.post });
    expect(out.failed).toBe(true);
    expect(out.rateLimited).toBe(true);
    expect(out.deferUntil).toBeNull();
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
  test("a tool call after streamed text stays in ONE Slack message: cards group into the turn's plan block, text blocks separated by a paragraph break", async () => {
    decisionQueue.push(usable);
    queryScripts.push(script([
      init("s-seg"),
      textStart(0),
      textDelta("before tools", 0),
      toolStart("tool-1", "Bash"),
      toolStop(),
      textStart(2),
      textDelta("after tools", 2),
      success("s-seg"),
    ]));
    const col = collector();
    const out = await relay({ post: col.post });
    expect(out.failed).toBe(false);
    expect(col.posts.length).toBe(1);
    expect(col.timeline).toEqual(["open:1", "close:1"]);
    expect(strings(col.posts[0])).toBe("before tools\n\nafter tools");
    const cardIds = (col.posts[0] ?? []).flatMap((c) => {
      const card = TaskCardSchema.safeParse(c);
      return card.success ? [card.data.id] : [];
    });
    expect(cardIds).toContain("tool-1");
  });

  test("a rejected post salvages its chunks into the next message instead of dropping them", async () => {
    decisionQueue.push(usable);
    queryScripts.push(() =>
      (async function* () {
        yield init("s-dead");
        yield textDelta("lost text");
        // give the rejected post's catch a beat to open the salvage segment
        await realEsToolkit.delay(15);
        yield textDelta("fresh text");
        yield success("s-dead");
      })(),
    );
    const col = collector({ rejectTimes: 1 });
    const out = await relay({ post: col.post });
    expect(out.failed).toBe(false);
    expect(col.calls()).toBe(2);
    // one delivered message carrying BOTH the salvaged and the fresh text
    expect(col.posts.length).toBe(1);
    expect(strings(col.posts[0])).toContain("lost text");
    expect(strings(col.posts[0])).toContain("fresh text");
  });

  test("an append failure mid-stream salvages exactly the undelivered text, without duplicating the delivered prefix", async () => {
    decisionQueue.push(usable);
    queryScripts.push(script([
      init("s-gap"),
      textDelta("line one\nheld "),
      textDelta("line two tail"),
      success("s-gap"),
    ]));
    const col = rendererCollector({ poisons: ["line two"] });
    const out = await relay({ post: col.post });
    expect(out.failed).toBe(false);
    expect(col.calls()).toBe(2);
    // message 1 delivered exactly the committable prefix before the death
    expect(col.delivered()[0]).toBe("line one\n");
    // the salvage message carries the renderer-held text plus the tail, once
    expect(col.delivered()[1]).toBe("held line two tail");
  });

  test("salvage reopens a fence the delivered prefix opened, so the remainder still renders as code", async () => {
    // the dead message committed an open fence; the salvage message must
    // reopen it before the remainder or the recovered code renders as plain
    // text (pullfrog catch on PR #42's salvage integration). Whichever side
    // of the death the opener landed on, the salvage message must begin
    // inside a fence.
    decisionQueue.push(usable);
    queryScripts.push(script([
      init("s-fensal"),
      textDelta("intro\n```\ncode line one\n"),
      textDelta("more code tail"),
      success("s-fensal"),
    ]));
    const col = rendererCollector({ poisons: ["more code"] });
    const out = await relay({ post: col.post });
    expect(out.failed).toBe(false);
    const delivered = col.delivered();
    // the opener committed in the dead message (open-fence content commits
    // eagerly: that is why Slack streams code live)
    expect(delivered[0]).toContain("```");
    const salvage = delivered.at(-1) ?? "";
    expect(salvage.startsWith("```")).toBe(true);
    expect(salvage).toContain("more code tail");
    // nothing lost or duplicated: every content piece reaches Slack once
    const all = delivered.join("");
    for (const piece of ["intro", "code line one", "more code tail"]) {
      expect(all.split(piece).length - 1).toBe(1);
    }
  });

  test("a card-only salvage holds the fence reopen for the first LATER text joining the segment", async () => {
    // the death loses only a card; streamed text arriving afterward joins
    // the already-open salvage segment and was authored mid-fence, so the
    // pending reopen must materialize before IT, not be skipped for lack of
    // salvaged text (pullfrog catch on PR #42).
    decisionQueue.push(usable);
    queryScripts.push(() =>
      (async function* () {
        yield init("s-cardfence");
        yield textDelta("intro\n```\ncode line one\n");
        yield toolStart("tool-cf", "Bash");
        yield toolStop();
        // give the doomed post a beat to reject with only cards unconfirmed
        await realEsToolkit.delay(30);
        yield textDelta("later code\n");
        yield success("s-cardfence");
      })(),
    );
    let calls = 0;
    const posts: unknown[][] = [];
    const post = async (m: AsyncIterable<unknown>) => {
      calls += 1;
      if (calls === 1) {
        // consume the text (its append lands), then die holding the card
        for await (const c of m) {
          if (z.string().safeParse(c).success === false) {
            throw new Error("An API error occurred: message_not_in_streaming_state");
          }
        }
        return;
      }
      const chunks: unknown[] = [];
      posts.push(chunks);
      for await (const c of m) chunks.push(c);
    };
    const out = await relay({ post });
    expect(out.failed).toBe(false);
    const salvaged = posts[0] ?? [];
    const texts = salvaged.flatMap((c) => {
      const s = z.string().safeParse(c);
      return s.success ? [s.data] : [];
    });
    const reopen = texts.indexOf("```\n");
    const later = texts.findIndex((t) => t.includes("later code"));
    expect(reopen).not.toBe(-1);
    expect(later).not.toBe(-1);
    expect(reopen).toBeLessThan(later);
  });

  test("a chained card-only salvage death propagates the pending fence to the next salvage", async () => {
    // salvage 1 inherits an open fence (card-only, reopen armed but never
    // materialized) and DIES too; salvage 2 must inherit the open state via
    // the parity fold or its later text renders unfenced (vercel + cubic
    // chained-salvage catch on PR #42).
    decisionQueue.push(usable);
    queryScripts.push(() =>
      (async function* () {
        yield init("s-chainfence");
        yield textDelta("intro\n```\ncode line one\n");
        yield toolStart("tool-chain", "Bash");
        yield toolStop();
        // let BOTH deaths settle before the later text arrives
        await realEsToolkit.delay(60);
        yield textDelta("later code\n");
        yield success("s-chainfence");
      })(),
    );
    let calls = 0;
    const posts: unknown[][] = [];
    const post = async (m: AsyncIterable<unknown>) => {
      calls += 1;
      if (calls === 1) {
        for await (const c of m) {
          if (z.string().safeParse(c).success === false) {
            throw new Error("An API error occurred: message_not_in_streaming_state");
          }
        }
        return;
      }
      if (calls === 2) throw new Error("An API error occurred: message_not_in_streaming_state");
      const chunks: unknown[] = [];
      posts.push(chunks);
      for await (const c of m) chunks.push(c);
    };
    const out = await relay({ post });
    expect(out.failed).toBe(false);
    const texts = (posts[0] ?? []).flatMap((c) => {
      const s = z.string().safeParse(c);
      return s.success ? [s.data] : [];
    });
    const reopen = texts.indexOf("```\n");
    const later = texts.findIndex((t) => t.includes("later code"));
    expect(reopen).not.toBe(-1);
    expect(later).not.toBe(-1);
    expect(reopen).toBeLessThan(later);
  });

  test("a final reply with no trailing newline dies in the forced final flush and still re-posts (the live incident)", async () => {
    // the renderer holds back the unterminated last line for the ENTIRE
    // iteration, so the only append happens after the iterable exhausts, when
    // every chunk is already consumed - chunk-granular salvage sees nothing
    // (pullfrog catch on PR #45); text-space salvage must recover it.
    decisionQueue.push(usable);
    queryScripts.push(script([init("s-tail"), textDelta("final answer"), success("s-tail")]));
    const col = rendererCollector({ poisons: ["final answer"] });
    const out = await relay({ post: col.post });
    expect(out.failed).toBe(false);
    const allText = col.delivered().join(" ");
    expect(allText).toContain("final answer");
    expect(allText).not.toContain("could not be posted");
  });

  test("repeated stream deaths with delivery progress between them all salvage (futility budget refills)", async () => {
    decisionQueue.push(usable);
    const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliett", "kilo", "lima"];
    queryScripts.push(script([init("s-refill"), ...words.map((w) => textDelta(`${w}\n`)), success("s-refill")]));
    // 6 separate deaths (more than the flat budget of 5), each poisoned word
    // leading a message that already delivered the previous disarmed word:
    // delivery progress must refill the budget so every death salvages.
    const col = rendererCollector({ poisons: ["alpha", "charlie", "echo", "golf", "india", "kilo"] });
    const out = await relay({ post: col.post });
    expect(out.failed).toBe(false);
    const allText = col.delivered().join(" ");
    for (const w of words) expect(allText.split(w).length - 1).toBe(1);
  });

  test("a prior attempt's late salvage does not suppress the retry's result fallback", async () => {
    // attempt 1 streams text and hits a mid-turn limit while its post is
    // still stalled; the post rejects DURING attempt 2 (after the per-attempt
    // postedText reset) and the salvage must not re-arm postedText - attempt
    // 2 answers only via result, and that fallback is its sole delivery path.
    const now = Date.now();
    seedIdentityAndUsage("org-relay", now);
    const resetEpochSec = Math.floor((now + 3_600_000) / 1000);
    decisionQueue.push(usable, usable);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    queryScripts.push(script([init("s-late"), textDelta("partial before limit"), limitErrored("s-late", `Claude AI usage limit reached|${resetEpochSec}`)]));
    queryScripts.push(() =>
      (async function* () {
        // attempt 2 has begun (postedText already reset): let the stalled
        // post reject and its salvage land before this attempt streams.
        release();
        await realEsToolkit.delay(20);
        yield init("s-late");
        yield success("s-late", "command output");
      })(),
    );
    const posts: unknown[][] = [];
    let calls = 0;
    const post = async (m: AsyncIterable<unknown>) => {
      calls += 1;
      if (calls === 1) {
        await gate;
        throw new Error("An API error occurred: message_not_in_streaming_state");
      }
      const chunks: unknown[] = [];
      posts.push(chunks);
      for await (const c of m) chunks.push(c);
    };
    const out = await relay({ post });
    expect(out.failed).toBe(false);
    const allText = posts.map(strings).join(" ");
    expect(allText).toContain("partial before limit");
    expect(allText).toContain("command output");
  });

  test("reply text past the per-message cap splits into ordered Slack messages", async () => {
    // one 100-char line repeated 250x = 25,000 chars: Slack rejects a single
    // message that long with msg_too_long, so the relay must split BEFORE
    // the cap (live incident 2026-07-20).
    const line = `${"x".repeat(99)}\n`;
    const long = line.repeat(250);
    decisionQueue.push(usable);
    queryScripts.push(script([init("s-split"), textDelta(long), success("s-split")]));
    const col = collector();
    const out = await relay({ post: col.post });
    expect(out.failed).toBe(false);
    expect(col.posts.length).toBe(3);
    for (const [i, p] of col.posts.entries()) {
      expect(strings(p).length).toBeLessThanOrEqual(SEGMENT_TEXT_MAX);
      expect(col.timeline).toContain(`open:${i + 1}`);
    }
    // strict order and no content lost or reordered
    expect(col.timeline).toEqual(["open:1", "close:1", "open:2", "close:2", "open:3", "close:3"]);
    expect(col.posts.map(strings).join("")).toBe(long);
    // the preferred cut is a line boundary, not mid-line
    expect(strings(col.posts[0]).endsWith("\n")).toBe(true);
  });

  test("small deltas accumulating past the cap split without losing content", async () => {
    const delta = "y".repeat(400);
    const deltas = Array.from({ length: 60 }, () => textDelta(delta));
    decisionQueue.push(usable);
    queryScripts.push(script([init("s-acc"), ...deltas, success("s-acc")]));
    const col = collector();
    const out = await relay({ post: col.post });
    expect(out.failed).toBe(false);
    expect(col.posts.length).toBeGreaterThan(1);
    for (const p of col.posts) expect(strings(p).length).toBeLessThanOrEqual(SEGMENT_TEXT_MAX);
    expect(col.posts.map(strings).join("")).toBe(delta.repeat(60));
  });

  test("a break forced inside a code fence closes and reopens it", async () => {
    const long = `intro\n\`\`\`\n${"z".repeat(SEGMENT_TEXT_MAX + 500)}\n\`\`\`\nafter`;
    decisionQueue.push(usable);
    queryScripts.push(script([init("s-fence"), textDelta(long), success("s-fence")]));
    const col = collector();
    const out = await relay({ post: col.post });
    expect(out.failed).toBe(false);
    expect(col.posts.length).toBe(2);
    // both halves render as code: the first closes the fence, the next reopens
    expect(strings(col.posts[0]).endsWith("\n```")).toBe(true);
    expect(strings(col.posts[1]).startsWith("```\n")).toBe(true);
    expect(strings(col.posts[1]).endsWith("after")).toBe(true);
    // stripping the inserted markers restores the original text
    const first = strings(col.posts[0]);
    const second = strings(col.posts[1]);
    expect(first.slice(0, -4) + second.slice(4)).toBe(long);
  });

  test("a fence delimiter split across SDK deltas still tracks as one fence", async () => {
    // deltas do not respect markdown token boundaries: ``` can arrive as
    // "``" + "`\n..." (pullfrog review catch, PR #42) - parity must be
    // computed over the segment's accumulated text, never per chunk.
    const z = "z".repeat(SEGMENT_TEXT_MAX);
    decisionQueue.push(usable);
    queryScripts.push(script([
      init("s-splitfence"),
      textDelta("intro\n``"),
      textDelta(`\`\n${z}\n\`\`\`\nafter`),
      success("s-splitfence"),
    ]));
    const col = collector();
    const out = await relay({ post: col.post });
    expect(out.failed).toBe(false);
    expect(col.posts.length).toBe(2);
    expect(strings(col.posts[0]).includes("intro\n```\n")).toBe(true);
    expect(strings(col.posts[0]).endsWith("\n```")).toBe(true);
    expect(strings(col.posts[1]).startsWith("```\n")).toBe(true);
    expect(strings(col.posts[1]).endsWith("after")).toBe(true);
    const first = strings(col.posts[0]);
    const second = strings(col.posts[1]);
    expect(first.slice(0, -4) + second.slice(4)).toBe(`intro\n\`\`\`\n${z}\n\`\`\`\nafter`);
  });

  test("a hard cut never slices through a backtick run", async () => {
    // position ``` exactly straddling the cap with no newline to prefer: the
    // cut must back up past the whole run instead of stranding a partial
    // delimiter on each side (cubic review catch, PR #42).
    const long = `${"a".repeat(SEGMENT_TEXT_MAX - 1)}\`\`\`${"b".repeat(50)}`;
    decisionQueue.push(usable);
    queryScripts.push(script([init("s-run"), textDelta(long), success("s-run")]));
    const col = collector();
    const out = await relay({ post: col.post });
    expect(out.failed).toBe(false);
    expect(col.posts.length).toBe(2);
    expect(strings(col.posts[0])).toBe("a".repeat(SEGMENT_TEXT_MAX - 1));
    expect(strings(col.posts[1])).toBe(`\`\`\`${"b".repeat(50)}`);
  });

  test("a huge no-stream result still splits instead of dying on one post", async () => {
    const result = `${"r".repeat(150)}\n`.repeat(100); // 15,100 chars, no streamed text
    decisionQueue.push(usable);
    queryScripts.push(script([init("s-res"), success("s-res", result)]));
    const col = collector();
    const out = await relay({ post: col.post });
    expect(out.failed).toBe(false);
    expect(col.posts.length).toBe(2);
    for (const p of col.posts) expect(strings(p).length).toBeLessThanOrEqual(SEGMENT_TEXT_MAX);
    expect(col.posts.map(strings).join("")).toBe(result);
  });

  test("a surface that never delivers stays bounded, fails the turn, and the rejecting diagnostic never escapes", async () => {
    decisionQueue.push(usable);
    queryScripts.push(() =>
      (async function* () {
        yield init("s-tail2");
        yield textDelta("final answer");
        yield success("s-tail2");
      })(),
    );
    const col = collector({ rejectTimes: Number.POSITIVE_INFINITY });
    const out = await relay({ post: col.post }); // resolving IS the assertion
    expect(out.failed).toBe(true);
    expect(col.posts.length).toBe(0);
    // zero-delivery rejections burn the futility budget instead of looping
    expect(col.calls()).toBeLessThanOrEqual(10);
  });

  test("a persistently failing forced flush burns the budget: consumption alone never refills it", async () => {
    // every chunk is consumed (confirmed advances) but the single
    // no-trailing-newline line is renderer-held, so its only append is the
    // post-iteration forced flush - if THAT fails persistently, refilling on
    // consumption would salvage the same held text forever (vercel review
    // catch on PR #45).
    decisionQueue.push(usable);
    queryScripts.push(() =>
      (async function* () {
        yield init("s-flushloop");
        yield textDelta("single line without newline");
        yield success("s-flushloop");
      })(),
    );
    let calls = 0;
    const post = async (m: AsyncIterable<unknown>) => {
      calls += 1;
      for await (const c of m) void c;
      throw new Error("An API error occurred: message_not_in_streaming_state");
    };
    const out = await relay({ post }); // resolving IS the assertion
    expect(out.failed).toBe(true);
    expect(calls).toBeLessThanOrEqual(10);
  });

  test("salvage preserves stream order: an unconfirmed card re-posts ahead of the text that followed it", async () => {
    decisionQueue.push(usable);
    queryScripts.push(() =>
      (async function* () {
        yield init("s-order");
        yield toolStart("tool-ord", "Bash");
        yield toolStop();
        yield textDelta("tail line");
        // give the doomed post's delay a beat so both chunks queue before it
        // rejects with nothing confirmed
        await realEsToolkit.delay(30);
        yield success("s-order");
      })(),
    );
    let calls = 0;
    const posts: unknown[][] = [];
    const post = async (m: AsyncIterable<unknown>) => {
      calls += 1;
      if (calls === 1) {
        await realEsToolkit.delay(15);
        throw new Error("An API error occurred: message_not_in_streaming_state");
      }
      const chunks: unknown[] = [];
      posts.push(chunks);
      for await (const c of m) chunks.push(c);
    };
    const out = await relay({ post });
    expect(out.failed).toBe(false);
    const salvaged = posts[0] ?? [];
    const firstText = salvaged.findIndex((c) => z.string().safeParse(c).success);
    // only the tool's own card: the closing Turn card is also a task_update
    // and legitimately follows the text
    const cardIndexes = salvaged.flatMap((c, i) => {
      const card = TaskCardSchema.safeParse(c);
      return card.success && card.data.id === "tool-ord" ? [i] : [];
    });
    expect(strings(salvaged)).toContain("tail line");
    expect(cardIndexes.length).toBeGreaterThan(0);
    // the card originally preceded the text; salvage must keep it there
    for (const i of cardIndexes) expect(i).toBeLessThan(firstText);
  });
});

describe("relayThread steering", () => {
  test("a steer mid-attempt joins the running attempt's stdin stream", async () => {
    decisionQueue.push(usable);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    queryScripts.push(() =>
      (async function* () {
        yield init("s-steer");
        yield textStart();
        yield textDelta("working");
        await gate;
        yield success("s-steer");
      })(),
    );
    const col = collector();
    const steers: (((text: string) => boolean) | null)[] = [];
    const turn = relay({ post: col.post, onSteer: (s) => steers.push(s) });
    for (let i = 0; i < 400 && steers.length === 0; i++) await realEsToolkit.delay(5);
    const steer = steers[0];
    if (!steer) throw new Error("test: steer never registered");
    expect(steer("also cover the edge case")).toBe(true);
    release();
    const out = await turn;
    expect(out.failed).toBe(false);
    // the attempt's input stream carried the prompt AND the steered text
    expect(await promptTexts(queryCalls[0]?.prompt)).toEqual(["do the thing", "also cover the edge case"]);
    // the hook is cleared when the attempt ends, and a late steer is refused
    expect(steers.at(-1)).toBeNull();
    expect(steer("too late")).toBe(false);
  });

  test("a steer after the attempt's result is refused: it must queue as its own turn instead", async () => {
    decisionQueue.push(usable);
    let resultYielded = false;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    queryScripts.push(() =>
      (async function* () {
        yield init("s-late");
        yield textStart();
        yield textDelta("answer");
        yield success("s-late");
        resultYielded = true;
        await gate;
      })(),
    );
    const col = collector();
    const steers: (((text: string) => boolean) | null)[] = [];
    const turn = relay({ post: col.post, onSteer: (s) => steers.push(s) });
    for (let i = 0; i < 400 && !resultYielded; i++) await realEsToolkit.delay(5);
    const steer = steers[0];
    if (!steer) throw new Error("test: steer never registered");
    expect(steer("after the result")).toBe(false);
    release();
    const out = await turn;
    expect(out.failed).toBe(false);
    // the refused text never reached the input stream
    expect(await promptTexts(queryCalls[0]?.prompt)).toEqual(["do the thing"]);
  });

  test("steered texts fold into a retry attempt's prompt: a steer must survive a mid-turn limit", async () => {
    const now = Date.now();
    seedIdentityAndUsage("org-relay", now);
    const resetEpochSec = Math.floor((now + 3_600_000) / 1000);
    decisionQueue.push(usable, usable);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    queryScripts.push(() =>
      (async function* () {
        yield init("s-steer-limit");
        await gate;
        yield limitErrored("s-steer-limit", `Claude AI usage limit reached|${resetEpochSec}`);
      })(),
    );
    queryScripts.push(script([init("s-steer-limit"), textDelta("recovered"), success("s-steer-limit")]));
    const col = collector();
    const steers: (((text: string) => boolean) | null)[] = [];
    const turn = relay({ post: col.post, onSteer: (s) => steers.push(s) });
    for (let i = 0; i < 400 && steers.length === 0; i++) await realEsToolkit.delay(5);
    const steer = steers[0];
    if (!steer) throw new Error("test: steer never registered");
    expect(steer("and rename the flag")).toBe(true);
    release();
    const out = await turn;
    expect(out.failed).toBe(false);
    expect(queryCalls.length).toBe(2);
    // the retry resumes the session AND re-sends the steered text with the
    // prompt (the resend-the-full-prompt duplication tradeoff, extended)
    expect(queryCalls[1]?.options.resume).toBe("s-steer-limit");
    expect(await promptTexts(queryCalls[1]?.prompt)).toEqual(["do the thing\n\nand rename the flag"]);
    // each attempt registered a fresh hook and cleared it
    expect(steers.length).toBe(4);
    expect(steers[1]).toBeNull();
    expect(steers[3]).toBeNull();
  });
});

describe("relayThread trailing steered-turn results", () => {
  test("an errored result AFTER a success never re-runs the turn: announced loss, no retry", async () => {
    const now = Date.now();
    seedIdentityAndUsage("org-relay", now);
    const resetEpochSec = Math.floor((now + 3_600_000) / 1000);
    // exactly ONE decision: a retry would exhaust the queue and throw
    decisionQueue.push(usable);
    queryScripts.push(
      script([
        init("s-trail"),
        textStart(),
        textDelta("primary answer"),
        success("s-trail"),
        // the post-fold-window steer's own drained turn, dying at a limit
        limitErrored("s-trail", `Claude AI usage limit reached|${resetEpochSec}`),
      ]),
    );
    const col = collector();
    const out = await relay({ post: col.post });
    // success is sticky: the delivered primary answer stays delivered
    expect(out.failed).toBe(false);
    expect(out.rateLimited).toBe(false);
    expect(out.resultReceived).toBe(true);
    expect(queryCalls.length).toBe(1);
    const allText = col.posts.map(strings).join(" ");
    expect(allText).toContain("primary answer");
    // the lost steer is announced, never silently retried
    expect(allText).toContain("steered follow-up");
    expect(allText).toContain("re-send");
    // the limit observation still lands for the NEXT spawn decision
    expect(loadUsage()?.fiveHour).toEqual({ usedPercentage: 100, resetsAt: resetEpochSec * 1000 });
  });
});

describe("relayThread multi-result turns (round-2 review fixes)", () => {
  test("a tool-only primary answer survives a trailing errored steer turn: flushed at its own result", async () => {
    const now = Date.now();
    seedIdentityAndUsage("org-relay", now);
    const resetEpochSec = Math.floor((now + 3_600_000) / 1000);
    decisionQueue.push(usable);
    // NO streamed text: the primary answer lives only in result.result
    queryScripts.push(
      script([
        init("s-toolonly"),
        success("s-toolonly", "the primary tool-only answer"),
        limitErrored("s-toolonly", `Claude AI usage limit reached|${resetEpochSec}`),
      ]),
    );
    const col = collector();
    const out = await relay({ post: col.post });
    expect(out.failed).toBe(false);
    expect(out.steerLost).toBe(true);
    expect(queryCalls.length).toBe(1);
    const allText = col.posts.map(strings).join(" ");
    // the primary answer was flushed at ITS result, before the trailing
    // turn's notice could suppress it
    expect(allText).toContain("the primary tool-only answer");
    expect(allText).toContain("steered follow-up");
  });

  test("two result-only turns in one child both deliver their answers", async () => {
    decisionQueue.push(usable);
    queryScripts.push(
      script([
        init("s-two"),
        success("s-two", "first answer"),
        success("s-two", "second answer"),
      ]),
    );
    const col = collector();
    const out = await relay({ post: col.post });
    expect(out.failed).toBe(false);
    expect(out.steerLost).toBe(false);
    const allText = col.posts.map(strings).join(" ");
    expect(allText).toContain("first answer");
    expect(allText).toContain("second answer");
  });

  test("a limit classification is sticky across a child's errored results", async () => {
    const now = Date.now();
    seedIdentityAndUsage("org-relay", now);
    const resetEpochSec = Math.floor((now + 3_600_000) / 1000);
    decisionQueue.push(usable, usable);
    // primary turn dies at a LIMIT, then the drained steer turn dies with a
    // generic error: the limit classification must survive last-writer-wins
    queryScripts.push(
      script([
        init("s-sticky"),
        limitErrored("s-sticky", `Claude AI usage limit reached|${resetEpochSec}`),
        {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          session_id: "s-sticky",
          result: "stream disconnected",
          modelUsage: {},
          total_cost_usd: 0,
          duration_ms: 50,
        },
      ]),
    );
    queryScripts.push(script([init("s-sticky"), textDelta("recovered"), success("s-sticky")]));
    const col = collector();
    const out = await relay({ post: col.post });
    // the silent limit retry ran (a plain failure would have posted "turn
    // failed" and never spawned again)
    expect(out.failed).toBe(false);
    expect(queryCalls.length).toBe(2);
    expect(col.posts.map(strings).join(" ")).toContain("recovered");
  });
});

describe("relayThread PR #50 review fixes", () => {
  const toolHandler = (call: (typeof queryCalls)[number] | undefined, name: string) => {
    const server = z
      .object({ tools: z.array(z.tuple([z.string(), z.string(), z.record(z.string(), z.unknown()), z.custom<() => Promise<unknown>>()])) })
      .parse(z.object({ options: z.object({ mcpServers: z.object({ tokenmaxxing: z.unknown() }) }) }).parse(call).options.mcpServers.tokenmaxxing);
    const tool = server.tools.find((t) => t[0] === name);
    if (!tool) throw new Error(`test: tool ${name} not found`);
    return tool[3];
  };

  test("a steer answers a LIVE ask: the sticky attention flag clears, a later ask re-arms it", async () => {
    decisionQueue.push(usable);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    queryScripts.push(() =>
      (async function* () {
        yield init("s-liveask");
        yield textStart();
        yield textDelta("which option?");
        await gate;
        yield success("s-liveask");
      })(),
    );
    const col = collector();
    const steers: (((text: string) => boolean) | null)[] = [];
    const turn = relay({ post: col.post, onSteer: (s) => steers.push(s) });
    for (let i = 0; i < 400 && steers.length === 0; i++) await realEsToolkit.delay(5);
    const steer = steers[0];
    if (!steer) throw new Error("test: steer never registered");
    // the model asks mid-turn, then the user's steered reply answers it
    await toolHandler(queryCalls[0], "need_attention")();
    expect(steer("option B please")).toBe(true);
    release();
    const out = await turn;
    expect(out.attention).toBe(false);
  });

  test("an ask AFTER the last steer still marks the thread waiting", async () => {
    decisionQueue.push(usable);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    queryScripts.push(() =>
      (async function* () {
        yield init("s-lateask");
        await gate;
        yield success("s-lateask");
      })(),
    );
    const col = collector();
    const steers: (((text: string) => boolean) | null)[] = [];
    const turn = relay({ post: col.post, onSteer: (s) => steers.push(s) });
    for (let i = 0; i < 400 && steers.length === 0; i++) await realEsToolkit.delay(5);
    const steer = steers[0];
    if (!steer) throw new Error("test: steer never registered");
    expect(steer("more context")).toBe(true);
    // the ask lands AFTER the steer: it is a new, unanswered question
    await toolHandler(queryCalls[0], "need_attention")();
    release();
    const out = await turn;
    expect(out.attention).toBe(true);
  });

  test("consecutive result-only answers get a paragraph break, never mid-line concatenation", async () => {
    decisionQueue.push(usable);
    queryScripts.push(script([init("s-sep"), success("s-sep", "first answer"), success("s-sep", "second answer")]));
    const col = collector();
    await relay({ post: col.post });
    const allText = col.posts.map(strings).join(" ");
    expect(allText).toContain("first answer\n\nsecond answer");
    expect(allText).not.toContain("first answersecond answer");
  });
});

// the non-limit errored-result shape: a child that died without completing.
const errored = (sessionId: string, resultText: string) => ({
  type: "result",
  subtype: "error_during_execution",
  is_error: true,
  session_id: sessionId,
  result: resultText,
  modelUsage: {},
  total_cost_usd: 0,
  duration_ms: 100,
});

describe("relayThread transient-failure retry", () => {
  test("a non-limit child failure retries silently into the same session and the thread sees only the recovered answer", async () => {
    // spawn 1, post-failure defer probe, spawn 2
    decisionQueue.push(usable, usable, usable);
    queryScripts.push(script([init("s-tr"), errored("s-tr", "Claude Code process exited with code 1")]));
    queryScripts.push(script([init("s-tr"), textStart(), textDelta("recovered answer"), success("s-tr")]));
    const col = collector();
    const out = await relay({ post: col.post });
    expect(out.failed).toBe(false);
    expect(queryCalls.length).toBe(2);
    // the retry CONTINUES the session the failed attempt opened
    expect(queryCalls[1]!.options.resume).toBe("s-tr");
    const all = col.posts.map((p) => strings(p)).join("\n");
    expect(all).toContain("recovered answer");
    expect(all).not.toContain("turn failed");
    expect(all).not.toContain("trying again may help");
  });

  test("retries are bounded and the terminal line reports the total attempts", async () => {
    const attempts = MAX_TRANSIENT_RETRIES + 1;
    for (let i = 0; i < attempts; i += 1) {
      decisionQueue.push(usable, usable); // spawn, then post-failure probe
      queryScripts.push(script([init("s-tf"), errored("s-tf", "Claude Code process exited with code 1")]));
    }
    const col = collector();
    const out = await relay({ post: col.post });
    expect(out.failed).toBe(true);
    expect(out.rateLimited).toBe(false);
    expect(queryCalls.length).toBe(attempts);
    // the retries continue the session with an explicit continuation prompt,
    // never a verbatim replay that would re-run completed side effects
    for (let i = 1; i < attempts; i += 1) {
      expect(queryCalls[i]!.options.resume).toBe("s-tf");
      expect((await promptTexts(queryCalls[i]!.prompt))[0]).toContain("Pick up exactly where you left off");
    }
    const all = col.posts.map((p) => strings(p)).join("\n");
    // the terminal line carries the REAL child error, not a generic stub
    expect(all).toContain("Claude Code process exited with code 1");
    expect(all).toContain(`after ${attempts} attempts`);
  });

  test("a depleted pool with an unknown wake outranks the transient retry: no doomed respawns", async () => {
    decisionQueue.push(usable, depleted()); // spawn, then the post-failure probe finds the pool exhausted
    queryScripts.push(script([init("s-td"), errored("s-td", "Claude Code process exited with code 1")]));
    const col = collector();
    const out = await relay({ post: col.post });
    expect(out.failed).toBe(true);
    expect(queryCalls.length).toBe(1);
    const all = col.posts.map((p) => strings(p)).join("\n");
    expect(all).toContain("Claude Code process exited with code 1");
  });

  test("a turn that streamed text and then errored explains the truncation instead of a bare failed reaction", async () => {
    const attempts = MAX_TRANSIENT_RETRIES + 1;
    for (let i = 0; i < attempts; i += 1) {
      decisionQueue.push(usable, usable);
      queryScripts.push(script([init("s-tp"), textStart(), textDelta("partial answer"), errored("s-tp", "boom detail")]));
    }
    const col = collector();
    const out = await relay({ post: col.post });
    expect(out.failed).toBe(true);
    const all = col.posts.map((p) => strings(p)).join("\n");
    expect(all).toContain("partial answer");
    expect(all).toContain("boom detail");
    expect(all).toContain("may be incomplete");
  });
});

describe("relayThread segment rotation", () => {
  test("an idle segment closes cleanly before Slack's stream expiry and the next chunk opens a fresh message", async () => {
    const prev = SEGMENT_ROTATION.idleMs;
    SEGMENT_ROTATION.idleMs = 40;
    try {
      decisionQueue.push(usable);
      queryScripts.push(() =>
        (async function* () {
          yield init("s-rot");
          yield textStart();
          yield textDelta("part one");
          await realEsToolkit.delay(150);
          yield textDelta("part two");
          yield success("s-rot");
        })(),
      );
      const col = collector();
      const out = await relay({ post: col.post });
      expect(out.failed).toBe(false);
      expect(col.calls()).toBe(2);
      expect(strings(col.posts[0])).toContain("part one");
      expect(strings(col.posts[1])).toContain("part two");
      // the idle segment fully closed BEFORE the fresh one opened
      expect(col.timeline).toEqual(["open:1", "close:1", "open:2", "close:2"]);
    } finally {
      SEGMENT_ROTATION.idleMs = prev;
    }
  });

  test("a status notice after a mid-fence rotation never renders inside the fence", async () => {
    const prev = SEGMENT_ROTATION.idleMs;
    SEGMENT_ROTATION.idleMs = 40;
    try {
      // spawn, then the post-failure probe defers on a depleted pool
      decisionQueue.push(usable, depleted(Date.now() + 3_600_000));
      queryScripts.push(() =>
        (async function* () {
          yield init("s-fn");
          yield textStart();
          yield textDelta("```\ncode half");
          await realEsToolkit.delay(150); // rotation closes the fence, arms the reopen
          yield errored("s-fn", "boom");
        })(),
      );
      const col = collector();
      const out = await relay({ post: col.post });
      expect(out.deferUntil).not.toBeNull();
      const notice = col.posts.map((p) => strings(p)).find((s) => s.includes("pausing this turn"));
      expect(notice).toBeDefined();
      expect(notice).not.toContain("```");
    } finally {
      SEGMENT_ROTATION.idleMs = prev;
    }
  });

  test("a rejected notice's salvage never eats the interrupted reply's fence opener", async () => {
    const prev = SEGMENT_ROTATION.idleMs;
    SEGMENT_ROTATION.idleMs = 40;
    try {
      // spawn 1, park (depleted, near wake), spawn 2
      decisionQueue.push(usable, depleted(Date.now() + 60_000), usable);
      queryScripts.push(() =>
        (async function* () {
          yield init("s-fs");
          yield textStart();
          yield textDelta("```\ncode half");
          await realEsToolkit.delay(150); // rotation closes the fence, arms the reopen
          yield limitErrored("s-fs", "Claude AI usage limit reached|9999999999");
        })(),
      );
      queryScripts.push(script([init("s-fs"), textStart(), textDelta("code rest"), success("s-fs")]));
      const col = collector();
      let calls = 0;
      const post = async (m: AsyncIterable<unknown>) => {
        calls += 1;
        // the park notice's own post dies; its salvage re-post must not
        // consume the pending fence reopen the rotation armed
        if (calls === 2) throw new Error("message_not_in_streaming_state");
        return col.post(m);
      };
      const out = await relay({ post });
      expect(out.failed).toBe(false);
      const texts = col.posts.map((p) => strings(p));
      expect(texts.some((s) => s.includes("holding this message"))).toBe(true); // salvaged notice landed
      const continuation = texts.find((s) => s.includes("code rest"));
      expect(continuation).toBeDefined();
      // the continuation still opens inside the fence the rotation closed
      expect(continuation!.startsWith("```")).toBe(true);
    } finally {
      SEGMENT_ROTATION.idleMs = prev;
    }
  });

  test("a continuously active segment still rotates at its max age, losing no text", async () => {
    const prev = SEGMENT_ROTATION.maxAgeMs;
    SEGMENT_ROTATION.maxAgeMs = 60;
    try {
      decisionQueue.push(usable);
      queryScripts.push(() =>
        (async function* () {
          yield init("s-age");
          yield textStart();
          for (let i = 1; i <= 8; i += 1) {
            yield textDelta(`chunk-${i} `);
            await realEsToolkit.delay(20);
          }
          yield success("s-age");
        })(),
      );
      const col = collector();
      const out = await relay({ post: col.post });
      expect(out.failed).toBe(false);
      expect(col.calls()).toBeGreaterThanOrEqual(2);
      const all = col.posts.map((p) => strings(p)).join("");
      for (let i = 1; i <= 8; i += 1) expect(all).toContain(`chunk-${i}`);
    } finally {
      SEGMENT_ROTATION.maxAgeMs = prev;
    }
  });
});
