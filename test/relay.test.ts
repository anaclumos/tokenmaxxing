// Hermetic relay companion tests (memory tmux; no interactive workers).

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../src/lib/paths.ts";
import { loadRelayConfig, writeRelayConfig } from "../src/lib/relay/config.ts";
import { runDecide } from "../src/lib/relay/decide.ts";
import { destroySession, gcSessions } from "../src/lib/relay/gc.ts";
import {
  clearTurnDoneMarker,
  writePendingRequest,
  writeTurnDoneMarker,
} from "../src/lib/relay/markers.ts";
import {
  claudeArgvForMode,
  codexFlagsForMode,
  parsePermissionMode,
  permissionPingsEnabled,
  tryParsePermissionMode,
} from "../src/lib/relay/modes.ts";
import { formatRelayStdout, parseRelayStdout } from "../src/lib/relay/protocol.ts";
import {
  createEntry,
  listEntries,
  readEntry,
  withSessionLock,
} from "../src/lib/relay/registry.ts";
import { createMemoryTmux, resetTmuxBackend, setTmuxBackend } from "../src/lib/relay/tmux.ts";
import { runTurn } from "../src/lib/relay/turn.ts";
import { buildWorkerCommand, ensureSession, setLivePermissionMode } from "../src/lib/relay/worker.ts";
afterEach(() => {
  resetTmuxBackend();
});

describe("permission modes", () => {
  test("parses Claude modes and manual alias", () => {
    expect(parsePermissionMode({ raw: "auto" })).toBe("auto");
    expect(parsePermissionMode({ raw: "manual" })).toBe("default");
    expect(parsePermissionMode({ raw: "bypassPermissions" })).toBe("bypassPermissions");
    expect(parsePermissionMode({ raw: "yolo" })).toBe("bypassPermissions");
    expect(tryParsePermissionMode({ raw: "nope" })).toBeNull();
  });

  test("maps Claude modes onto Codex sandbox flags", () => {
    expect(codexFlagsForMode({ mode: "plan" })).toEqual({
      sandbox: "read-only",
      askForApproval: "on-request",
    });
    expect(codexFlagsForMode({ mode: "default" })).toEqual({
      sandbox: "read-only",
      askForApproval: "on-request",
    });
    expect(codexFlagsForMode({ mode: "acceptEdits" }).sandbox).toBe("workspace-write");
    expect(codexFlagsForMode({ mode: "auto" })).toEqual({
      sandbox: "workspace-write",
      askForApproval: "on-request",
    });
    expect(codexFlagsForMode({ mode: "dontAsk" })).toEqual({
      sandbox: "read-only",
      askForApproval: "never",
    });
    expect(codexFlagsForMode({ mode: "bypassPermissions" })).toEqual({
      sandbox: "danger-full-access",
      askForApproval: "never",
    });
  });

  test("bypassPermissions disables pings and adds dangerously-skip flag", () => {
    expect(permissionPingsEnabled({ mode: "auto" })).toBe(true);
    expect(permissionPingsEnabled({ mode: "bypassPermissions" })).toBe(false);
    expect(claudeArgvForMode({ mode: "bypassPermissions" })).toContain("--dangerously-skip-permissions");
    expect(claudeArgvForMode({ mode: "auto" })).toEqual(["--permission-mode", "auto"]);
  });
});

describe("relay config defaults", () => {
  test("defaultPermissionMode is auto", () => {
    expect(loadRelayConfig().defaultPermissionMode).toBe("auto");
    writeRelayConfig({ file: { defaultWorker: "codex" } });
    expect(loadRelayConfig().defaultPermissionMode).toBe("auto");
    expect(loadRelayConfig().defaultWorker).toBe("codex");
  });
});

describe("stdout protocol", () => {
  test("formats permission-needed contract", () => {
    const text = formatRelayStdout({
      payload: {
        kind: "permission-needed",
        sessionId: "11111111-1111-4111-8111-111111111111",
        permissionMode: "auto",
        requestId: "req-1",
        summary: "Permission needed: Bash",
        detail: "rm -rf /tmp/x",
      },
    });
    const parsed = parseRelayStdout({ text });
    expect(parsed.sessionId).toBe("11111111-1111-4111-8111-111111111111");
    expect(parsed.permissionMode).toBe("auto");
    expect(parsed.requestId).toBe("req-1");
    expect(parsed.summary).toBe("Permission needed: Bash");
    expect(parsed.detail).toBe("rm -rf /tmp/x");
  });
});

describe("turn + decide with memory tmux", () => {
  test("turn completes on turn-done marker", async () => {
    const tmux = createMemoryTmux();
    setTmuxBackend({ backend: tmux });
    const sessionId = "22222222-2222-4222-8222-222222222222";
    let clock = 1_000_000;
    let polls = 0;
    const result = await runTurn({
      sessionId,
      cwd: "/tmp",
      prompt: "hello",
      timeoutMs: 2_000,
      now: () => clock,
      sleep: async () => {
        polls += 1;
        clock += 10;
        if (polls === 1) writeTurnDoneMarker({ sessionId, source: "test", now: clock });
      },
    });
    expect(result.payload.kind).toBe("turn-done");
    expect(result.stdout).toContain(`session: ${sessionId}`);
    expect(result.stdout).toContain("permission-mode: auto");
    expect(tmux.hasSession({ name: `xx-relay-${sessionId}` })).toBe(true);
  });

  test("turn returns permission-needed then decide resumes to turn-done", async () => {
    const tmux = createMemoryTmux();
    setTmuxBackend({ backend: tmux });
    const sessionId = "33333333-3333-4333-8333-333333333333";
    let clock = 2_000_000;
    let polls = 0;
    const ping = await runTurn({
      sessionId,
      cwd: "/tmp",
      prompt: "do a thing",
      permissionMode: "auto",
      timeoutMs: 2_000,
      now: () => clock,
      sleep: async () => {
        polls += 1;
        clock += 10;
        if (polls === 1) {
          writePendingRequest({
            sessionId,
            requestId: "ping-1",
            summary: "Permission needed: Edit",
            detail: "write foo.ts",
            now: clock,
          });
        }
      },
    });
    expect(ping.payload.kind).toBe("permission-needed");
    if (ping.payload.kind !== "permission-needed") throw new Error("expected ping");
    expect(ping.payload.requestId).toBe("ping-1");

    let decidePolls = 0;
    const decided = await runDecide({
      sessionId,
      requestId: "ping-1",
      approve: true,
      wait: true,
      cwd: "/tmp",
      timeoutMs: 2_000,
      now: () => clock,
      sleep: async () => {
        decidePolls += 1;
        clock += 10;
        if (decidePolls === 1) writeTurnDoneMarker({ sessionId, source: "test", now: clock });
      },
    });
    expect(decided.turn?.payload.kind).toBe("turn-done");
  });

  test("set-permission-mode updates registry", async () => {
    const tmux = createMemoryTmux();
    setTmuxBackend({ backend: tmux });
    const entry = await ensureSession({
      sessionId: "44444444-4444-4444-8444-444444444444",
      cwd: "/tmp",
      permissionMode: "auto",
    });
    const next = await setLivePermissionMode({
      sessionId: entry.sessionId,
      permissionMode: "plan",
    });
    expect(next.permissionMode).toBe("plan");
    expect(readEntry({ sessionId: entry.sessionId })?.permissionMode).toBe("plan");
  });

  test("bypassPermissions ignores pending pings and waits for turn-done", async () => {
    const tmux = createMemoryTmux();
    setTmuxBackend({ backend: tmux });
    const sessionId = "55555555-5555-4555-8555-555555555555";
    let clock = 3_000_000;
    const turnPromise = runTurn({
      sessionId,
      cwd: "/tmp",
      prompt: "go",
      permissionMode: "bypassPermissions",
      timeoutMs: 2_000,
      now: () => clock,
      sleep: async () => {
        clock += 10;
        if (clock === 3_000_020) {
          writePendingRequest({
            sessionId,
            requestId: "should-clear",
            summary: "should not surface",
            detail: "x",
            now: clock,
          });
        }
        if (clock === 3_000_040) {
          writeTurnDoneMarker({ sessionId, source: "test", now: clock });
        }
      },
    });
    const result = await turnPromise;
    expect(result.payload.kind).toBe("turn-done");
  });
});

describe("registry concurrency and gc", () => {
  test("per-session locks serialize concurrent holders", async () => {
    const sessionId = "66666666-6666-4666-8666-666666666666";
    createEntry({
      sessionId,
      worker: "claude",
      permissionMode: "auto",
      cwd: "/tmp",
    });
    const events: string[] = [];
    const a = withSessionLock({
      sessionId,
      fn: async () => {
        events.push("a-start");
        await Bun.sleep(80);
        events.push("a-end");
      },
    });
    await Bun.sleep(20);
    const b = withSessionLock({
      sessionId,
      fn: () => {
        events.push("b");
      },
    });
    await Promise.all([a, b]);
    expect(events).toEqual(["a-start", "a-end", "b"]);
  });

  test("gc reaps dead tmux sessions; destroy uses exact name", async () => {
    const tmux = createMemoryTmux();
    setTmuxBackend({ backend: tmux });
    const liveId = "77777777-7777-4777-8777-777777777777";
    const deadId = "88888888-8888-4888-8888-888888888888";
    await ensureSession({ sessionId: liveId, cwd: "/tmp" });
    await ensureSession({ sessionId: deadId, cwd: "/tmp" });
    tmux.killSession({ name: `xx-relay-${deadId}` });
    const result = await gcSessions({ now: Date.now(), idleTtlMs: 60_000 });
    expect(result.reaped).toContain(deadId);
    expect(result.kept).toContain(liveId);
    expect(listEntries().some((e) => e.sessionId === deadId)).toBe(false);

    await destroySession({ sessionId: liveId });
    expect(tmux.hasSession({ name: `xx-relay-${liveId}` })).toBe(false);
    expect(readEntry({ sessionId: liveId })).toBeNull();
  });

  test("idle ttl reaps idle sessions", async () => {
    const tmux = createMemoryTmux();
    setTmuxBackend({ backend: tmux });
    const sessionId = "99999999-9999-4999-8999-999999999999";
    createEntry({
      sessionId,
      worker: "claude",
      permissionMode: "auto",
      cwd: "/tmp",
      now: 1000,
    });
    tmux.newSession({
      name: `xx-relay-${sessionId}`,
      cwd: "/tmp",
      command: "claude",
    });
    const result = await gcSessions({ now: 1000 + 60 * 60 * 1000 + 1, idleTtlMs: 60 * 60 * 1000 });
    expect(result.reaped).toContain(sessionId);
  });
});

describe("finish-hook markers stay out of respawn", () => {
  test("turn-done writes under relay/turn-done only", () => {
    const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    createEntry({
      sessionId,
      worker: "claude",
      permissionMode: "auto",
      cwd: "/tmp",
    });
    mkdirSync(paths.respawnDir, { recursive: true });
    const before = existsSync(paths.respawnDir) ? readdirSync(paths.respawnDir) : [];
    writeTurnDoneMarker({ sessionId, source: "claude-stop" });
    const turnDone = join(paths.relayDir, "turn-done", sessionId);
    expect(existsSync(turnDone)).toBe(true);
    expect(JSON.parse(readFileSync(turnDone, "utf8")).sessionId).toBe(sessionId);
    const after = readdirSync(paths.respawnDir);
    expect(after).toEqual(before);
    clearTurnDoneMarker({ sessionId });
  });

  test("worker command pins relay session env and permission mode", () => {
    const cmd = buildWorkerCommand({
      sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      worker: "claude",
      permissionMode: "auto",
    });
    expect(cmd).toContain("TOKENMAXXING_RELAY_SESSION=");
    expect(cmd).toContain("--permission-mode");
    expect(cmd).toContain("auto");
    const codex = buildWorkerCommand({
      sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      worker: "codex",
      permissionMode: "bypassPermissions",
    });
    expect(codex).toContain("danger-full-access");
  });
});

describe("cli help wiring", () => {
  test("tokenmaxxing relay --help exits 0", async () => {
    // CLI refuses ambient CLAUDE_CONFIG_DIR; tests set it for hermetic paths.
    const env: Record<string, string | undefined> = { ...process.env, TOKENMAXXING_HOME: paths.home, NO_COLOR: "1" };
    delete env.CLAUDE_CONFIG_DIR;
    delete env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
    const res = Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "src", "main.ts"), "relay", "--help"], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(res.exitCode).toBe(0);
    const out = res.stdout.toString();
    expect(out).toContain("relay turn");
    expect(out).toContain("permission-mode");
    expect(out).toContain("auto");
  });
});
