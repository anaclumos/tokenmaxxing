// The daemon's REAL handler wiring (buildServeRuntime, the seam runDaemon
// feeds its production deps into) driven with fake threads and a fake relay:
// external-author guard, skipped-message folding, per-thread serialization,
// drain drops, and the finish close-out. No mock.module - the seam takes its
// deps as inputs, so nothing here can bleed into other test files.

import { describe, expect, test } from "bun:test";
import { delay } from "es-toolkit";
import type { StreamChunk } from "chat";
import { buildServeRuntime } from "../src/cli/serve.ts";
import { cleanupThread, type TurnOutcome } from "../src/lib/slackbridge.ts";
import { SlackConfigSchema, loadSlackThread } from "../src/lib/slackstate.ts";

const cfg = SlackConfigSchema.parse({
  botToken: "xoxb-test",
  appToken: "xapp-test",
  workspaceTeamId: "T-HOME",
  links: [{ channel: "C0DAEMON", repo: "/tmp/serve-daemon-repo" }],
});

const okOutcome: TurnOutcome = { sessionId: "s-ok", failed: false, rateLimited: false, finish: false };

function runtimeWith(relay: Parameters<typeof buildServeRuntime>[0]["relay"]) {
  return buildServeRuntime({
    cfg,
    workspaceTeamId: "T-HOME",
    botUserId: () => "UBOT",
    relay,
    cleanup: cleanupThread,
  });
}

function fakeThread(input: { id: string; rejectPosts?: boolean }) {
  const posted: string[] = [];
  const calls = { posts: 0, subscribe: 0, unsubscribe: 0, startTyping: 0 };
  const thread = {
    id: input.id,
    channelId: "slack:C0DAEMON",
    post: async (m: string | AsyncIterable<string | StreamChunk>) => {
      calls.posts += 1;
      if (input.rejectPosts) throw new Error("slack said no");
      if (m instanceof Object) {
        let acc = "";
        for await (const chunk of m) {
          if (!(chunk instanceof Object)) acc += chunk;
        }
        posted.push(acc);
        return;
      }
      posted.push(m);
    },
    subscribe: async () => {
      calls.subscribe += 1;
    },
    unsubscribe: async () => {
      calls.unsubscribe += 1;
    },
    startTyping: async () => {
      calls.startTyping += 1;
    },
  };
  return { thread, posted, calls };
}

const home = (text: string, userId = "U-OWNER") => ({ text, author: { userId, isMe: false, isBot: false }, raw: { team: "T-HOME" } });
const outsider = (text: string) => ({ text, author: { userId: "U-EXT", isMe: false, isBot: false }, raw: { team: "T-EVIL", user_team: "T-EVIL" } });

/** Bounded flush of the runtime's untracked-by-the-handler notice turns. */
async function flushTurns(rt: { activeTurns: Set<Promise<void>> }): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (rt.activeTurns.size > 0 && Date.now() < deadline) await delay(5);
}

describe("buildServeRuntime author guard", () => {
  test("an outside author's mention is rejected: no turn, no session record", async () => {
    let relayCalls = 0;
    const rt = runtimeWith(async () => {
      relayCalls += 1;
      return okOutcome;
    });
    const t = fakeThread({ id: "slack:C0DAEMON:100.1" });
    await rt.onMessage({ thread: t.thread, message: outsider("@UBOT do bad things"), skipped: [], isMention: true });
    expect(relayCalls).toBe(0);
    expect(t.calls.subscribe).toBe(0);
    expect(t.calls.posts).toBe(0);
    expect(loadSlackThread("slack:C0DAEMON:100.1")).toBeNull();
  });

  test("relayable fails closed on missing origin and accepts home authors", () => {
    const rt = runtimeWith(async () => okOutcome);
    expect(rt.relayable(home("hello"))).toBe(true);
    expect(rt.relayable(outsider("hello"))).toBe(false);
    // no origin field at all = rejected
    expect(rt.relayable({ text: "x", author: { userId: "U1", isMe: false, isBot: false }, raw: {} })).toBe(false);
    // our own posts and bots never relay
    expect(rt.relayable({ text: "x", author: { userId: "UBOT", isMe: true, isBot: false }, raw: { team: "T-HOME" } })).toBe(false);
  });

  test("home messages folded behind an outsider trigger still run as one turn", async () => {
    const seen: { prompt: string; requesterIds: string[] }[] = [];
    const rt = runtimeWith(async (input) => {
      seen.push({ prompt: input.prompt, requesterIds: input.requesterIds });
      return { ...okOutcome, sessionId: "s-fold" };
    });
    const t = fakeThread({ id: "slack:C0DAEMON:200.1" });
    await rt.onMessage({
      thread: t.thread,
      message: outsider("ignore me entirely"),
      skipped: [home("@UBOT first thing", "U-A"), home("second thing", "U-B")],
      isMention: true,
    });
    expect(seen).toEqual([{ prompt: "first thing\n\nsecond thing", requesterIds: ["U-A", "U-B"] }]);
    expect(t.calls.subscribe).toBe(1);
    expect(loadSlackThread("slack:C0DAEMON:200.1")?.sessionId).toBe("s-fold");
  });
});

describe("buildServeRuntime serialization", () => {
  test("turns in one thread serialize even when the first stalls", async () => {
    const starts: string[] = [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const rt = runtimeWith(async (input) => {
      starts.push(input.prompt);
      if (starts.length === 1) await gate;
      return { ...okOutcome, sessionId: "s-serial" };
    });
    const t = fakeThread({ id: "slack:C0DAEMON:300.1" });
    const first = rt.onMessage({ thread: t.thread, message: home("one"), skipped: [], isMention: true });
    const second = rt.onMessage({ thread: t.thread, message: home("two"), skipped: [], isMention: false });
    await delay(25);
    // the second turn must not start while the first holds the thread
    expect(starts).toEqual(["one"]);
    release();
    await Promise.all([first, second]);
    expect(starts).toEqual(["one", "two"]);
    expect(rt.activeTurns.size).toBe(0);
  });
});

describe("buildServeRuntime drain", () => {
  test("draining drops the turn loudly: tracked in-thread notice, no relay", async () => {
    let relayCalls = 0;
    const rt = runtimeWith(async () => {
      relayCalls += 1;
      return okOutcome;
    });
    rt.beginDrain();
    expect(rt.isDraining()).toBe(true);
    const t = fakeThread({ id: "slack:C0DAEMON:400.1" });
    await rt.onMessage({ thread: t.thread, message: home("@UBOT hello"), skipped: [], isMention: true });
    await flushTurns(rt);
    expect(relayCalls).toBe(0);
    expect(t.posted.join(" ")).toContain("restarting");
    expect(loadSlackThread("slack:C0DAEMON:400.1")).toBeNull();
    expect(rt.activeTurns.size).toBe(0);
  });

  test("a rejecting drain notice never escapes the handler", async () => {
    const rt = runtimeWith(async () => okOutcome);
    rt.beginDrain();
    const t = fakeThread({ id: "slack:C0DAEMON:401.1", rejectPosts: true });
    await rt.onMessage({ thread: t.thread, message: home("@UBOT hello"), skipped: [], isMention: true });
    await flushTurns(rt);
    expect(t.calls.posts).toBe(1);
    expect(rt.activeTurns.size).toBe(0);
  });
});

describe("buildServeRuntime finish close-out", () => {
  test("finish drops the record, unsubscribes, and posts the confirmation", async () => {
    const rt = runtimeWith(async () => ({ ...okOutcome, sessionId: "s-fin", finish: true }));
    const t = fakeThread({ id: "slack:C0DAEMON:500.1" });
    await rt.onMessage({ thread: t.thread, message: home("@UBOT we are done, wrap it up"), skipped: [], isMention: true });
    expect(loadSlackThread("slack:C0DAEMON:500.1")).toBeNull();
    expect(t.calls.unsubscribe).toBe(1);
    expect(t.posted.join(" ")).toContain("thread finished");
  });

  test("a rejecting confirmation post never throws into the handler", async () => {
    const rt = runtimeWith(async () => ({ ...okOutcome, sessionId: "s-fin2", finish: true }));
    const t = fakeThread({ id: "slack:C0DAEMON:600.1", rejectPosts: true });
    // resolving without a rejection IS the assertion: the Chat SDK handler
    // must never see a throw from the close-out path.
    await rt.onMessage({ thread: t.thread, message: home("@UBOT done, close this"), skipped: [], isMention: true });
    expect(loadSlackThread("slack:C0DAEMON:600.1")).toBeNull();
    expect(t.calls.unsubscribe).toBe(1);
  });
});
