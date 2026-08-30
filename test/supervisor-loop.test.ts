import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LOOP_DIAGNOSIS, MAX_WRAP_DEPTH, UNMANAGED_ENV, WRAP_RATE_MAX } from "../src/lib/claudebin.ts";

const repo = join(import.meta.dir, "..");
const scratch = join(tmpdir(), `tm-loop-${process.pid}`);

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function buildLoop(name: string, safetyBound: number, stripSentinel: boolean) {
  const tmHome = join(scratch, name, "tmhome");
  const binDir = join(tmHome, "bin");
  const counterFile = join(scratch, name, "counter");
  mkdirSync(binDir, { recursive: true });
  writeExecutable(
    join(binDir, "claude"),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} run ${JSON.stringify(join(repo, "src", "main.ts"))} __supervise "$@"\n`,
  );
  const shim = join(scratch, name, "shim");
  const reexec = stripSentinel ? `exec /usr/bin/env -u TOKENMAXXING_WRAP_DEPTH claude "$@"` : `exec claude "$@"`;
  writeExecutable(
    shim,
    `#!/bin/sh
n=$(cat ${JSON.stringify(counterFile)} 2>/dev/null || echo 0)
if [ "$n" -ge ${safetyBound} ]; then exit 97; fi
echo $((n+1)) > ${JSON.stringify(counterFile)}
${reexec}
`,
  );
  writeFileSync(
    join(tmHome, "config.json"),
    JSON.stringify({ thresholds: { session: 95, weekly: 98 }, claudeBin: shim, policy: { switchModels: ["fable"] } }),
  );
  return { tmHome, binDir, counterFile };
}

function runLoop(setup: { tmHome: string; binDir: string }, timeoutMs: number, extraEnv: Record<string, string> = {}) {
  return Bun.spawnSync([join(setup.binDir, "claude"), "--version"], {
    env: {
      PATH: `${setup.binDir}:/usr/bin:/bin:${dirname(process.execPath)}`,
      TOKENMAXXING_HOME: setup.tmHome,
      TOKENMAXXING_CLAUDE_JSON: join(setup.tmHome, "claude.json"),
      TOKENMAXXING_CLAUDE_SETTINGS: join(setup.tmHome, "settings.json"),
      NO_COLOR: "1",
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
}

test(
  "a poisoned claudeBin shim chain aborts at the depth cap instead of recursing",
  () => {
    const setup = buildLoop("depth", 12, false);
    const p = runLoop(setup, 30_000);

    const reentries = Number(readFileSync(setup.counterFile, "utf8").trim());
    expect(reentries).toBe(MAX_WRAP_DEPTH);
    expect(p.exitCode).toBe(1);
    expect(p.stderr.toString()).toContain(LOOP_DIAGNOSIS);
  },
  30_000,
);

test(
  "a poisoned pin inside the unmanaged zone still aborts at the depth cap",
  () => {
    const setup = buildLoop("unmanaged-loop", 12, false);
    const p = runLoop(setup, 30_000, { [UNMANAGED_ENV]: "1" });

    const reentries = Number(readFileSync(setup.counterFile, "utf8").trim());
    expect(reentries).toBe(MAX_WRAP_DEPTH);
    expect(p.exitCode).toBe(1);
    expect(p.stderr.toString()).toContain(LOOP_DIAGNOSIS);
  },
  30_000,
);

test(
  "the unmanaged-zone sentinel passes a managed-looking invocation straight through, pairing env stripped",
  () => {
    const name = "unmanaged-passthrough";
    const tmHome = join(scratch, name, "tmhome");
    const binDir = join(tmHome, "bin");
    mkdirSync(binDir, { recursive: true });
    writeExecutable(
      join(binDir, "claude"),
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} run ${JSON.stringify(join(repo, "src", "main.ts"))} __supervise "$@"\n`,
    );
    const argsFile = join(scratch, name, "args");
    const envFile = join(scratch, name, "env");
    const fakeClaude = join(scratch, name, "fake-claude");
    writeExecutable(
      fakeClaude,
      `#!/bin/sh
printf '%s\\n' "$@" > ${JSON.stringify(argsFile)}
printf 'SUP=%s\\nSID=%s\\nUNM=%s\\nDEPTH=%s\\n' "$TOKENMAXXING_SUPERVISED" "$TOKENMAXXING_SESSION_ID" "$TOKENMAXXING_UNMANAGED" "$TOKENMAXXING_WRAP_DEPTH" > ${JSON.stringify(envFile)}
`,
    );
    writeFileSync(
      join(tmHome, "config.json"),
      JSON.stringify({ thresholds: { session: 95, weekly: 98 }, claudeBin: fakeClaude, policy: { switchModels: ["fable"] } }),
    );

    const p = Bun.spawnSync([join(binDir, "claude")], {
      env: {
        PATH: `${binDir}:/usr/bin:/bin:${dirname(process.execPath)}`,
        TOKENMAXXING_HOME: tmHome,
        TOKENMAXXING_CLAUDE_JSON: join(tmHome, "claude.json"),
        TOKENMAXXING_CLAUDE_SETTINGS: join(tmHome, "settings.json"),
        [UNMANAGED_ENV]: "1",
        TOKENMAXXING_SUPERVISED: "1",
        TOKENMAXXING_SESSION_ID: "3ce8783c-fc11-4991-8ba4-84c377a1a962",
        NO_COLOR: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
      killSignal: "SIGKILL",
    });

    expect(p.exitCode).toBe(0);
    expect(readFileSync(argsFile, "utf8").trim()).toBe("");
    const childEnv = readFileSync(envFile, "utf8");
    expect(childEnv).toContain("SUP=\n");
    expect(childEnv).toContain("SID=\n");
    expect(childEnv).toContain("UNM=1\n");
    expect(childEnv).toContain("DEPTH=1\n");
  },
  30_000,
);

test(
  "an env-sanitizing shim that strips the sentinel is caught by the rate backstop",
  () => {
    const setup = buildLoop("stripped", WRAP_RATE_MAX + 40, true);
    const p = runLoop(setup, 110_000);

    const reentries = Number(readFileSync(setup.counterFile, "utf8").trim());
    expect(reentries).toBeGreaterThan(MAX_WRAP_DEPTH);
    expect(reentries).toBe(WRAP_RATE_MAX);
    expect(p.exitCode).toBe(1);
    expect(p.stderr.toString()).toContain(LOOP_DIAGNOSIS);
  },
  120_000,
);
