import { afterAll, afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_WRAP_DEPTH } from "../src/lib/claudebin.ts";
import { paths } from "../src/lib/paths.ts";
import { pingSession } from "../src/lib/usage.ts";

const scratch = join(paths.home, "ping-test");
const argsFile = join(scratch, "args");
const envFile = join(scratch, "env");
const cwdFile = join(scratch, "cwd");

function installFakeClaude(body: string): void {
  mkdirSync(scratch, { recursive: true });
  const fake = join(scratch, "claude");
  writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argsFile)}\nenv > ${JSON.stringify(envFile)}\npwd > ${JSON.stringify(cwdFile)}\n${body}\n`);
  chmodSync(fake, 0o755);
  writeFileSync(paths.configJson, JSON.stringify({ thresholds: { session: 95, weekly: 98 }, claudeBin: fake, codexBin: "", policy: { projectionMargin: 0, greedySessionFloor: 50, switchModels: ["fable"], usagePollTtlMs: 90_000, maxWaitMs: 3_600_000 } }));
}

afterEach(() => {
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  rmSync(paths.configJson, { force: true });
});

test("a successful ping returns null and spawns the exact minimal-request contract", async () => {
  installFakeClaude(`echo '{"type":"result","subtype":"success","is_error":false,"result":"ok"}'`);
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-ambient";
  const isolated = join(scratch, "isolated-dir");

  expect(await pingSession(isolated)).toBeNull();

  const args = readFileSync(argsFile, "utf8").trim().split("\n");
  expect(args).toEqual(["-p", "Reply with exactly: ok", "--model", "haiku", "--settings", '{"disableAllHooks":true}', "--output-format", "json"]);

  const env = new Map(
    readFileSync(envFile, "utf8").trim().split("\n").map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1)] as const;
    }),
  );
  expect(env.get("CLAUDE_CONFIG_DIR")).toBe(isolated);
  expect(env.get("TOKENMAXXING_PROBE")).toBe("1");
  expect(env.get("TOKENMAXXING_WRAP_DEPTH")).toBe(String(MAX_WRAP_DEPTH));
  expect(env.has("CLAUDE_CODE_OAUTH_TOKEN")).toBe(false);

  expect(realpathSync(readFileSync(cwdFile, "utf8").trim())).toBe(realpathSync(join(paths.sampleDir, "ping-cwd")));
});

test("a live ping (no configDir) does not force CLAUDE_CONFIG_DIR", async () => {
  installFakeClaude(`echo '{"type":"result","subtype":"success","is_error":false,"result":"ok"}'`);
  expect(await pingSession()).toBeNull();
  const env = readFileSync(envFile, "utf8");
  expect(env).toContain(`CLAUDE_CONFIG_DIR=${process.env.CLAUDE_CONFIG_DIR}`);
});

test("an is_error result surfaces the server's reason", async () => {
  installFakeClaude(`echo '{"type":"result","subtype":"error","is_error":true,"result":"You have hit your usage limit."}'`);
  expect(await pingSession()).toBe("You have hit your usage limit.");
});

test("a nonzero exit surfaces the stderr detail", async () => {
  installFakeClaude(`echo 'Invalid model name' >&2\nexit 1`);
  expect(await pingSession()).toBe("claude exited 1: Invalid model name");
});

test("unparseable output is reported, not treated as success", async () => {
  installFakeClaude(`echo 'not json at all'`);
  expect(await pingSession()).toBe("unrecognized ping output: not json at all");
});
