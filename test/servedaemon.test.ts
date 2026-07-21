// The daemon's REAL handler wiring (buildServeRuntime, the seam runDaemon
// feeds its production deps into) driven with fake threads and a fake relay:
// external-author guard, skipped-message folding, per-thread serialization,
// drain drops, and the finish close-out. No mock.module - the seam takes its
// deps as inputs, so nothing here can bleed into other test files.

import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { delay } from "es-toolkit";
import { StreamingPlan, type StreamChunk } from "chat";
import { buildServeRuntime } from "../src/cli/serve.ts";
import { cleanupThread, type TurnOutcome } from "../src/lib/slackbridge.ts";
import { setLogEcho } from "../src/lib/log.ts";
import { pidStartTime } from "../src/lib/proc.ts";
import { MAX_TURN_RESUMES, SlackConfigSchema, loadSlackThread, saveSlackThread } from "../src/lib/slackstate.ts";

const cfg = SlackConfigSchema.parse({
  botToken: "xoxb-test",
  appToken: "xapp-test",
  workspaceTeamId: "T-HOME",
  links: [{ channel: "C0DAEMON", repo: "/tmp/serve-daemon-repo" }],
});

const okOutcome: TurnOutcome = { sessionId: "s-ok", failed: false, rateLimited: false, finish: false, announcedDrop: false, resultReceived: true, deferUntil: null };

function runtimeWith(
  relay: Parameters<typeof buildServeRuntime>[0]["relay"],
  streamable?: Parameters<typeof buildServeRuntime>[0]["streamable"],
  decide?: Parameters<typeof buildServeRuntime>[0]["decide"],
) {
  return buildServeRuntime({
    cfg,
    workspaceTeamId: "T-HOME",
    botUserId: () => "UBOT",
    relay,
    cleanup: cleanupThread,
    streamable:
      streamable ??
      (async () => {
        throw new Error("streamable not stubbed in this test");
      }),
    // a usable pool by default, so deferred wakes proceed to the resume
    decide: decide ?? (async () => ({ swapped: false, account: null, reason: "current-best" })),
  });
}

function fakeThread(input: { id: string; rejectPosts?: boolean; channelId?: string }) {
  const posted: string[] = [];
  /** groupTasks value of each StreamingPlan-wrapped post, pinning the
   *  plan-dropdown wrap runTurn applies to every relayed segment. */
  const planPosts: (string | undefined)[] = [];
  const calls = { posts: 0, subscribe: 0, unsubscribe: 0, startTyping: 0 };
  const thread = {
    id: input.id,
    channelId: input.channelId ?? "slack:C0DAEMON",
    post: async (m: string | AsyncIterable<string | StreamChunk> | StreamingPlan) => {
      calls.posts += 1;
      if (input.rejectPosts) throw new Error("slack said no");
      if (m instanceof Object) {
        // runTurn wraps every relayed segment in a StreamingPlan (groupTasks
        // "plan"); the fake drains the wrapped iterable like the real
        // Thread.post would.
        const plan = m instanceof StreamingPlan;
        if (plan) planPosts.push(m.options.groupTasks);
        const iterable = plan ? m.stream : m;
        let acc = "";
        for await (const chunk of iterable) {
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
  return { thread, posted, planPosts, calls };
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

  test("runTurn posts every relayed segment as a StreamingPlan with groupTasks plan", async () => {
    // the plan-dropdown squash (user ask 2026-07-20) lives entirely in this
    // wrap; without this pin, regressing groupTasks to "timeline" (the
    // card-per-task flood) leaves the whole suite green.
    const rt = runtimeWith(async (input) => {
      await input.post(
        (async function* () {
          yield "streamed reply";
          yield { type: "task_update", id: "tool-1", title: "Bash", status: "complete" };
        })(),
      );
      return { ...okOutcome, sessionId: "s-plan" };
    });
    const t = fakeThread({ id: "slack:C0DAEMON:250.1" });
    await rt.onMessage({ thread: t.thread, message: home("@UBOT run it"), skipped: [], isMention: true });
    expect(t.planPosts).toEqual(["plan"]);
    expect(t.posted).toContain("streamed reply");
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

  test("an unlinked channel stays silent even while draining", async () => {
    // the unlinked check runs BEFORE the drain branch: a drop notice posted
    // into a log-only-silent channel would tell a user to resend a message
    // that will never be served (closing-review catch).
    let relayCalls = 0;
    const rt = runtimeWith(async () => {
      relayCalls += 1;
      return okOutcome;
    });
    rt.beginDrain();
    const t = fakeThread({ id: "slack:C0OTHER:402.1", channelId: "slack:C0OTHER" });
    await rt.onMessage({ thread: t.thread, message: home("@UBOT hello"), skipped: [], isMention: true });
    await flushTurns(rt);
    expect(relayCalls).toBe(0);
    expect(t.calls.posts).toBe(0);
  });

  test("unlinked-channel traffic logs once per channel per run, with the shared-app diagnosis", async () => {
    // several daemons sharing one Slack app load-balance every envelope, so a
    // sibling's channel fires this constantly (live incident 2026-07-20): one
    // diagnostic line per channel, not a stream.
    const events: { event: string; parts: string }[] = [];
    setLogEcho({ printer: (e) => events.push(e) });
    try {
      const rt = runtimeWith(async () => okOutcome);
      const t1 = fakeThread({ id: "slack:C0OTHER:410.1", channelId: "slack:C0OTHER" });
      const t2 = fakeThread({ id: "slack:C0OTHER:410.2", channelId: "slack:C0OTHER" });
      const t3 = fakeThread({ id: "slack:C0THIRD:410.3", channelId: "slack:C0THIRD" });
      await rt.onMessage({ thread: t1.thread, message: home("@UBOT hello"), skipped: [], isMention: true });
      await rt.onMessage({ thread: t2.thread, message: home("@UBOT again"), skipped: [], isMention: true });
      await rt.onMessage({ thread: t3.thread, message: home("@UBOT other"), skipped: [], isMention: true });
      const unlinked = events.filter((e) => e.event === "serve.unlinked_channel");
      expect(unlinked.length).toBe(2); // C0OTHER once, C0THIRD once
      expect(unlinked[0]?.parts).toContain("C0OTHER");
      expect(unlinked[0]?.parts).toContain("its own Slack app");
      expect(unlinked[1]?.parts).toContain("C0THIRD");
    } finally {
      setLogEcho({ printer: () => {} });
    }
  });

  test("an ANNOUNCED drop during drain never leaves a resume marker (no double delivery)", async () => {
    // relayThread told the user to resend; replaying the turn at startup would
    // duplicate work, quota, and side effects on top of the user's resend.
    let beginDrain = () => {};
    const rt = runtimeWith(async () => {
      beginDrain(); // the drain lands mid-turn
      return { sessionId: null, failed: true, rateLimited: true, finish: false, announcedDrop: true, resultReceived: false, deferUntil: null };
    });
    beginDrain = rt.beginDrain;
    const t = fakeThread({ id: "slack:C0DAEMON:700.1" });
    await rt.onMessage({ thread: t.thread, message: home("@UBOT long job"), skipped: [], isMention: true });
    await flushTurns(rt);
    expect(loadSlackThread("slack:C0DAEMON:700.1")?.activeTurn).toBeUndefined();
  });

  test("an UNANNOUNCED drain failure keeps the marker: real kills still auto-resume", async () => {
    let beginDrain = () => {};
    const rt = runtimeWith(async () => {
      beginDrain();
      return { sessionId: null, failed: true, rateLimited: false, finish: false, announcedDrop: false, resultReceived: false, deferUntil: null };
    });
    beginDrain = rt.beginDrain;
    const t = fakeThread({ id: "slack:C0DAEMON:701.1" });
    await rt.onMessage({ thread: t.thread, message: home("@UBOT long job"), skipped: [], isMention: true });
    await flushTurns(rt);
    expect(loadSlackThread("slack:C0DAEMON:701.1")?.activeTurn?.prompt).toContain("long job");
  });

  test("a delivered-result drain failure clears the marker: Slack post loss is not a killed child", async () => {
    // the child reached a SUCCESSFUL result and only the final Slack append
    // failed (textLost sets failed): resuming would re-run completed work
    // (adversarial-review catch)
    let beginDrain = () => {};
    const rt = runtimeWith(async () => {
      beginDrain();
      return { sessionId: "s-done", failed: true, rateLimited: false, finish: false, announcedDrop: false, resultReceived: true, deferUntil: null };
    });
    beginDrain = rt.beginDrain;
    const t = fakeThread({ id: "slack:C0DAEMON:702.1" });
    await rt.onMessage({ thread: t.thread, message: home("@UBOT quick job"), skipped: [], isMention: true });
    await flushTurns(rt);
    expect(loadSlackThread("slack:C0DAEMON:702.1")?.activeTurn).toBeUndefined();
  });
});

describe("buildServeRuntime crash-orphan reap", () => {
  test("an inbound turn reaps a previous generation's surviving orphan before running", async () => {
    // A real detached sleeper (its own process group, like the daemon's
    // detached claude child) stands in for a SIGKILLed generation's orphan.
    // Without the handleTurn reap, an inbound message winning the serialized
    // chain ahead of startup recovery overwrote the marker and stranded the
    // orphan's pid forever (closing-review HIGH catch).
    const orphan = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    orphan.unref();
    const pid = orphan.pid!;
    let started: string | null = null;
    for (let i = 0; i < 40 && started === null; i++) {
      started = pidStartTime(pid);
      if (started === null) await delay(50);
    }
    expect(started).not.toBeNull();
    const threadId = "slack:C0DAEMON:800.1";
    saveSlackThread({
      threadId,
      repo: "/tmp/serve-daemon-repo",
      cwd: "/tmp/serve-daemon-repo",
      sessionId: "s-orphan",
      createdAt: new Date().toISOString(),
      activeTurn: { prompt: "killed turn", startedAt: new Date().toISOString(), resumeCount: 0, pid, pidStartedAt: started! },
    });
    let relayCalls = 0;
    const rt = runtimeWith(async () => {
      relayCalls += 1;
      return okOutcome;
    });
    const t = fakeThread({ id: threadId });
    await rt.onMessage({ thread: t.thread, message: home("@UBOT follow-up"), skipped: [], isMention: true });
    expect(relayCalls).toBe(1);
    // the orphan was identity-verified and signaled before the new turn ran
    expect(pidStartTime(pid)).not.toBe(started);
  });
});

describe("buildServeRuntime interrupted-turn recovery", () => {
  const marker = () => ({ prompt: "killed turn", startedAt: new Date().toISOString(), resumeCount: 0 });
  const record = (threadId: string) => ({
    threadId,
    repo: "/tmp/serve-daemon-repo",
    cwd: "/tmp/serve-daemon-repo",
    sessionId: "s-old",
    createdAt: new Date().toISOString(),
    activeTurn: marker(),
  });

  test("a superseded recovery no-ops instead of re-running the inbound turn's work", async () => {
    // The AGENTS invariant, previously untestable while recovery lived inline
    // in runDaemon (closing-review catch): an inbound turn (Slack redelivering
    // the killed turn's unacked mention) wins the serialized chain first and
    // clears the marker; recovery must recompute from a FRESH reload and
    // no-op - a snapshot-based recovery would duplicate the turn and clobber
    // the session id the inbound turn persisted.
    const threadId = "slack:C0DAEMON:900.1";
    saveSlackThread(record(threadId));
    const prompts: string[] = [];
    let releaseStreamable = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseStreamable = resolve;
    });
    const rt = runtimeWith(
      async (input) => {
        prompts.push(input.prompt);
        return { ...okOutcome, sessionId: "s-inbound" };
      },
      async () => {
        await gate; // recovery is still building its thread handle...
        return { thread: t.thread, requesterIds: ["U-OWNER"] };
      },
    );
    const t = fakeThread({ id: threadId });
    const recovery = rt.recoverInterrupted(record(threadId));
    // ...while the redelivered mention wins the chain and handles the thread.
    await rt.onMessage({ thread: t.thread, message: home("@UBOT killed turn"), skipped: [], isMention: true });
    expect(prompts).toEqual(["killed turn"]);
    releaseStreamable();
    await recovery;
    expect(prompts).toEqual(["killed turn"]); // no duplicate execution
    expect(loadSlackThread(threadId)?.sessionId).toBe("s-inbound"); // persisted session id intact
    expect(loadSlackThread(threadId)?.activeTurn).toBeUndefined();
  });

  test("an unsuperseded recovery resumes the killed turn: notice, relay, marker consumed", async () => {
    const threadId = "slack:C0DAEMON:901.1";
    saveSlackThread(record(threadId));
    const seen: { prompt: string; sessionId: string | null }[] = [];
    const rt = runtimeWith(
      async (input) => {
        seen.push({ prompt: input.prompt, sessionId: input.sessionId });
        return { ...okOutcome, sessionId: "s-resumed" };
      },
      async () => ({ thread: t.thread, requesterIds: ["U-OWNER"] }),
    );
    const t = fakeThread({ id: threadId });
    await rt.recoverInterrupted(record(threadId));
    expect(seen.length).toBe(1);
    expect(seen[0]!.sessionId).toBe("s-old"); // resumes the killed session
    expect(t.posted.length).toBeGreaterThan(0); // the in-thread restart notice
    expect(loadSlackThread(threadId)?.sessionId).toBe("s-resumed");
    expect(loadSlackThread(threadId)?.activeTurn).toBeUndefined();
  });
});

describe("buildServeRuntime usage-limit deferral", () => {
  test("a deferred turn keeps its durable marker with resumeAt and the scheduler resumes it", async () => {
    const threadId = "slack:C0DAEMON:950.1";
    const wake = Date.now() + 80;
    const prompts: string[] = [];
    let calls = 0;
    const rt = runtimeWith(
      async (input) => {
        calls += 1;
        prompts.push(input.prompt);
        if (calls === 1) {
          return { sessionId: "s-defer", failed: true, rateLimited: true, finish: false, announcedDrop: false, resultReceived: false, deferUntil: wake };
        }
        return { ...okOutcome, sessionId: "s-after" };
      },
      async () => ({ thread: t.thread, requesterIds: ["U-OWNER"] }),
    );
    const t = fakeThread({ id: threadId });
    await rt.onMessage({ thread: t.thread, message: home("@UBOT run later"), skipped: [], isMention: true });
    // the deferral persisted durably: a daemon death here still resumes
    const marker = loadSlackThread(threadId)?.activeTurn;
    expect(marker?.resumeAt).toBe(wake);
    expect(marker?.prompt).toContain("run later");
    // the process-local timer fires and recovery resumes through the chain
    const deadline = Date.now() + 3_000;
    while (calls < 2 && Date.now() < deadline) await delay(20);
    expect(calls).toBe(2);
    expect(prompts[1]).toContain("run later");
    await flushTurns(rt);
    expect(loadSlackThread(threadId)?.activeTurn).toBeUndefined();
    expect(loadSlackThread(threadId)?.sessionId).toBe("s-after");
  });

  test("an inbound message FOLDS a never-spawned deferral's held prompt instead of clobbering it", async () => {
    // the adversarial-review MAJOR catch: a spawn-boundary deferral's marker
    // is the ONLY copy of the held message; a follow-up must not lose it.
    const threadId = "slack:C0DAEMON:952.1";
    const wake = Date.now() + 3_600_000;
    const prompts: string[] = [];
    let calls = 0;
    const rt = runtimeWith(async (input) => {
      calls += 1;
      prompts.push(input.prompt);
      if (calls === 1) {
        // spawn-boundary deferral: no onSpawn fires, so the marker keeps no pid
        return { sessionId: null, failed: true, rateLimited: true, finish: false, announcedDrop: false, resultReceived: false, deferUntil: wake };
      }
      return { ...okOutcome, sessionId: "s-folded" };
    });
    const t = fakeThread({ id: threadId });
    await rt.onMessage({ thread: t.thread, message: home("@UBOT ship the release"), skipped: [], isMention: true });
    expect(loadSlackThread(threadId)?.activeTurn?.resumeAt).toBe(wake);
    await rt.onMessage({ thread: t.thread, message: home("are you still there?"), skipped: [], isMention: false });
    expect(calls).toBe(2);
    expect(prompts[1]).toBe("ship the release\n\nare you still there?");
    expect(loadSlackThread(threadId)?.activeTurn).toBeUndefined();
  });

  test("an inbound message takes over a spawned deferral: the held prompt still folds (a child can die before init, so no marker signal proves the prompt reached the session)", async () => {
    const threadId = "slack:C0DAEMON:953.1";
    const wake = Date.now() + 3_600_000;
    saveSlackThread({
      threadId,
      repo: "/tmp/serve-daemon-repo",
      cwd: "/tmp/serve-daemon-repo",
      sessionId: "s-partial",
      createdAt: new Date().toISOString(),
      activeTurn: { prompt: "long ship job", startedAt: new Date().toISOString(), resumeCount: 0, resumeAt: wake, pid: 999_999, pidStartedAt: "never-matches" },
    });
    const seen: { prompt: string; sessionId: string | null }[] = [];
    const rt = runtimeWith(async (input) => {
      seen.push({ prompt: input.prompt, sessionId: input.sessionId });
      return { ...okOutcome, sessionId: "s-partial" };
    });
    const t = fakeThread({ id: threadId });
    await rt.onMessage({ thread: t.thread, message: home("actually stop that"), skipped: [], isMention: false });
    expect(seen).toEqual([{ prompt: "long ship job\n\nactually stop that", sessionId: "s-partial" }]);
    expect(loadSlackThread(threadId)?.activeTurn).toBeUndefined();
  });

  test("a due wake against a still-depleted pool re-defers silently instead of burning a resume attempt", async () => {
    const threadId = "slack:C0DAEMON:956.1";
    const past = Date.now() - 1_000;
    const nextWake = Date.now() + 1_800_000;
    saveSlackThread({
      threadId,
      repo: "/tmp/serve-daemon-repo",
      cwd: "/tmp/serve-daemon-repo",
      sessionId: "s-redef",
      createdAt: new Date().toISOString(),
      activeTurn: { prompt: "held work", startedAt: new Date().toISOString(), resumeCount: 0, resumeAt: past },
    });
    let calls = 0;
    const rt = runtimeWith(
      async () => {
        calls += 1;
        return okOutcome;
      },
      async () => ({ thread: t.thread, requesterIds: ["U-OWNER"] }),
      async () => ({ swapped: false, account: null, reason: "all-depleted", waitUntil: nextWake }),
    );
    const t = fakeThread({ id: threadId });
    const record = loadSlackThread(threadId);
    if (!record) throw new Error("record missing");
    await rt.recoverInterrupted(record);
    expect(calls).toBe(0); // no spawn, no burnt attempt
    expect(t.posted.length).toBe(0); // no false recovery notice
    const marker = loadSlackThread(threadId)?.activeTurn;
    expect(marker?.resumeAt).toBe(nextWake + 5_000);
    expect(marker?.resumeCount).toBe(0);
  });

  test("a due wake against a depleted pool with an UNKNOWN recovery drops honestly instead of resuming falsely", async () => {
    const threadId = "slack:C0DAEMON:957.1";
    saveSlackThread({
      threadId,
      repo: "/tmp/serve-daemon-repo",
      cwd: "/tmp/serve-daemon-repo",
      sessionId: "s-unk",
      createdAt: new Date().toISOString(),
      activeTurn: { prompt: "held work", startedAt: new Date().toISOString(), resumeCount: 0, resumeAt: Date.now() - 1_000 },
    });
    let calls = 0;
    const rt = runtimeWith(
      async () => {
        calls += 1;
        return okOutcome;
      },
      async () => ({ thread: t.thread, requesterIds: ["U-OWNER"] }),
      async () => ({ swapped: false, account: null, reason: "all-depleted" }),
    );
    const t = fakeThread({ id: threadId });
    const record = loadSlackThread(threadId);
    if (!record) throw new Error("record missing");
    await rt.recoverInterrupted(record);
    expect(calls).toBe(0); // no spawn: nothing usable to spawn on
    expect(t.posted.join(" ")).toContain("dropped");
    expect(t.posted.join(" ")).not.toContain("recovered");
    expect(loadSlackThread(threadId)?.activeTurn).toBeUndefined();
  });

  test("a due wake on a turn at the resume cap gives up honestly instead of re-deferring forever", async () => {
    const threadId = "slack:C0DAEMON:958.1";
    saveSlackThread({
      threadId,
      repo: "/tmp/serve-daemon-repo",
      cwd: "/tmp/serve-daemon-repo",
      sessionId: "s-cap",
      createdAt: new Date().toISOString(),
      activeTurn: { prompt: "held work", startedAt: new Date().toISOString(), resumeCount: MAX_TURN_RESUMES, resumeAt: Date.now() - 1_000 },
    });
    let calls = 0;
    let probes = 0;
    const rt = runtimeWith(
      async () => {
        calls += 1;
        return okOutcome;
      },
      async () => ({ thread: t.thread, requesterIds: ["U-OWNER"] }),
      async () => {
        probes += 1;
        return { swapped: false, account: null, reason: "all-depleted", waitUntil: Date.now() + 1_800_000 };
      },
    );
    const t = fakeThread({ id: threadId });
    const record = loadSlackThread(threadId);
    if (!record) throw new Error("record missing");
    await rt.recoverInterrupted(record);
    expect(calls).toBe(0);
    expect(probes).toBe(0); // give-up outranks the probe: no silent re-defer at the cap
    expect(t.posted.join(" ")).toContain("giving up");
    expect(loadSlackThread(threadId)?.activeTurn).toBeUndefined();
  });

  test("a wake against a re-deferred FUTURE marker re-arms instead of resuming early", async () => {
    const threadId = "slack:C0DAEMON:954.1";
    const wake = Date.now() + 3_600_000;
    saveSlackThread({
      threadId,
      repo: "/tmp/serve-daemon-repo",
      cwd: "/tmp/serve-daemon-repo",
      sessionId: "s-future",
      createdAt: new Date().toISOString(),
      activeTurn: { prompt: "held work", startedAt: new Date().toISOString(), resumeCount: 0, resumeAt: wake },
    });
    let calls = 0;
    const rt = runtimeWith(
      async () => {
        calls += 1;
        return okOutcome;
      },
      async () => ({ thread: t.thread, requesterIds: ["U-OWNER"] }),
    );
    const t = fakeThread({ id: threadId });
    const record = loadSlackThread(threadId);
    if (!record) throw new Error("record missing");
    await rt.recoverInterrupted(record);
    expect(calls).toBe(0); // no premature resume, no false recovery notice
    expect(t.posted.length).toBe(0);
    expect(loadSlackThread(threadId)?.activeTurn?.resumeAt).toBe(wake);
  });

  test("a sticky finish riding a deferred outcome skips cleanup: the record survives for the resume", async () => {
    const threadId = "slack:C0DAEMON:955.1";
    const wake = Date.now() + 3_600_000;
    const rt = runtimeWith(async () => ({ sessionId: "s-finlim", failed: true, rateLimited: true, finish: true, announcedDrop: false, resultReceived: false, deferUntil: wake }));
    const t = fakeThread({ id: threadId });
    await rt.onMessage({ thread: t.thread, message: home("@UBOT wrap it up"), skipped: [], isMention: true });
    expect(loadSlackThread(threadId)?.activeTurn?.resumeAt).toBe(wake);
    expect(t.calls.unsubscribe).toBe(0);
    expect(t.posted.join(" ")).not.toContain("finished");
  });

  test("beginDrain cancels pending deferred wakes; the durable marker survives for the next generation", async () => {
    const threadId = "slack:C0DAEMON:951.1";
    const wake = Date.now() + 60;
    let calls = 0;
    const rt = runtimeWith(async () => {
      calls += 1;
      return { sessionId: "s-hold", failed: true, rateLimited: true, finish: false, announcedDrop: false, resultReceived: false, deferUntil: wake };
    });
    const t = fakeThread({ id: threadId });
    await rt.onMessage({ thread: t.thread, message: home("@UBOT held work"), skipped: [], isMention: true });
    expect(calls).toBe(1);
    rt.beginDrain();
    await delay(150); // past the wake: a cancelled timer must not fire
    expect(calls).toBe(1);
    expect(loadSlackThread(threadId)?.activeTurn?.resumeAt).toBe(wake);
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
