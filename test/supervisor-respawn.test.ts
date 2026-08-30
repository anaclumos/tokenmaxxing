import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, expect, test } from "bun:test";

const repo = join(import.meta.dir, "..");
const scratch = join(tmpdir(), `tm-respawn-${process.pid}`);
const MARKER_SID = "44444444-4444-4444-8444-444444444444";

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function buildInstall(name: string, markerJson: string) {
  const tmHome = join(scratch, name, "tmhome");
  const binDir = join(tmHome, "bin");
  mkdirSync(binDir, { recursive: true });
  const argsLog = join(scratch, name, "args.log");
  const counter = join(scratch, name, "count");
  const shim = join(scratch, name, "fake-claude");
  writeExecutable(
    join(binDir, "claude"),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} run ${JSON.stringify(join(repo, "src", "main.ts"))} __supervise "$@"\n`,
  );
  writeExecutable(
    shim,
    `#!/bin/sh
echo "$@" >> ${JSON.stringify(argsLog)}
n=$(cat ${JSON.stringify(counter)} 2>/dev/null || echo 0)
echo $((n+1)) > ${JSON.stringify(counter)}
if [ "$n" -eq 0 ]; then
  mkdir -p "$TOKENMAXXING_HOME/respawn"
  printf '%s' ${JSON.stringify(markerJson)} > "$TOKENMAXXING_HOME/respawn/.tmp-marker"
  mv "$TOKENMAXXING_HOME/respawn/.tmp-marker" "$TOKENMAXXING_HOME/respawn/$TOKENMAXXING_SESSION_ID"
  sleep 5
fi
exit 0
`,
  );
  writeFileSync(join(tmHome, "config.json"), JSON.stringify({ claudeBin: shim }));
  return { tmHome, binDir, argsLog };
}

function runManaged(setup: { tmHome: string; binDir: string }, argv: string[]) {
  return Bun.spawnSync([join(setup.binDir, "claude"), ...argv], {
    env: {
      PATH: `${setup.binDir}:/usr/bin:/bin:${dirname(process.execPath)}`,
      TOKENMAXXING_HOME: setup.tmHome,
      TOKENMAXXING_CLAUDE_JSON: join(setup.tmHome, "claude.json"),
      TOKENMAXXING_CLAUDE_SETTINGS: join(setup.tmHome, "settings.json"),
      NO_COLOR: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
    killSignal: "SIGKILL",
  });
}

test(
  "a depleted marker respawns --resume <marker sid> with flags only, never the positional prompt",
  () => {
    const setup = buildInstall(
      "respawn",
      JSON.stringify({ account: "acct-b", ts: 1, waitUntil: 1, sessionId: MARKER_SID }),
    );
    const p = runManaged(setup, ["--model", "opus", "do the thing"]);
    expect(p.exitCode).toBe(0);

    const lines = readFileSync(setup.argsLog, "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
    const first = lines[0]!.split(" ");
    expect(first[0]).toBe("--session-id");
    expect(first.slice(2)).toEqual(["--model", "opus", "do", "the", "thing"]);
    expect(lines[1]).toBe(`--resume ${MARKER_SID} --model opus`);

    const pinned = first[1]!;
    for (const sid of [pinned, MARKER_SID]) {
      const stored = JSON.parse(readFileSync(join(setup.tmHome, "sessions", `${sid}.json`), "utf8"));
      expect(stored.flags).toEqual(["--model", "opus"]);
    }
    expect(existsSync(join(setup.tmHome, "respawn", pinned))).toBe(false);
  },
  30_000,
);

test(
  "an INVALID marker is dropped without killing the session or respawning",
  () => {
    const setup = buildInstall("invalid", JSON.stringify({ account: "acct-b", ts: 1, waitUntil: 1 }));
    const p = runManaged(setup, ["--model", "opus"]);
    expect(p.exitCode).toBe(0);

    const lines = readFileSync(setup.argsLog, "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
    const pinned = lines[0]!.split(" ")[1]!;
    expect(existsSync(join(setup.tmHome, "respawn", pinned))).toBe(false);
  },
  30_000,
);

test(
  "restored session flags are sanitized: a pre-fix stored positional never rides a bare --resume",
  () => {
    const sid = "55555555-5555-4555-8555-555555555555";
    const setup = buildInstall("restore", JSON.stringify({ account: "x", ts: 1, waitUntil: 1, sessionId: sid }));
    mkdirSync(join(setup.tmHome, "sessions"), { recursive: true });
    writeFileSync(
      join(setup.tmHome, "sessions", `${sid}.json`),
      JSON.stringify({ flags: ["--model", "opus", "do the thing"], cwd: "/some/cwd" }),
    );
    writeFileSync(join(setup.tmHome, "..", "count"), "1");
    const p = runManaged(setup, ["--resume", sid]);
    expect(p.exitCode).toBe(0);

    const lines = readFileSync(setup.argsLog, "utf8").trim().split("\n");
    expect(lines).toEqual([`--resume ${sid} --model opus`]);
  },
  30_000,
);

test(
  "a marker prompt is submitted once behind `--` on the relaunch and never persisted",
  () => {
    const setup = buildInstall(
      "prompt",
      JSON.stringify({ account: "acct-b", ts: 1, waitUntil: 1, sessionId: MARKER_SID, prompt: "Continue where the previous turn left off" }),
    );
    const p = runManaged(setup, ["--model", "opus", "--debug"]);
    expect(p.exitCode).toBe(0);

    const lines = readFileSync(setup.argsLog, "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
    expect(lines[1]).toBe(`--resume ${MARKER_SID} --model opus --debug -- Continue where the previous turn left off`);
    const stored = JSON.parse(readFileSync(join(setup.tmHome, "sessions", `${MARKER_SID}.json`), "utf8"));
    expect(stored.flags).toEqual(["--model", "opus", "--debug"]);
  },
  30_000,
);

test(
  "a marker stamped by another launch is dropped without a respawn",
  () => {
    const setup = buildInstall(
      "stale-launch",
      JSON.stringify({ account: "acct-b", ts: 1, waitUntil: 1, sessionId: MARKER_SID, launchedAt: 1 }),
    );
    const p = runManaged(setup, ["--model", "opus"]);
    expect(p.exitCode).toBe(0);

    const lines = readFileSync(setup.argsLog, "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
    const pinned = lines[0]!.split(" ")[1]!;
    expect(existsSync(join(setup.tmHome, "respawn", pinned))).toBe(false);
  },
  30_000,
);
