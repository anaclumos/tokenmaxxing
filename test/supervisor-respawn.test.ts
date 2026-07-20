// Behavioral coverage for the supervisor's managed respawn loop
// (adversarial-review catch: only the recursion-guard early return was
// tested). A fake claude records its argv; run 0 drops a respawn marker keyed
// by its inherited TOKENMAXXING_SESSION_ID and sleeps until the supervisor's
// watcher SIGTERMs it. Pins: the relaunch is `--resume <marker sessionId>`
// with FLAGS ONLY (a positional prompt is submit-once, never replayed), the
// flags persist under both the pinned and resumed transcript ids, and an
// INVALID marker is dropped loudly without killing the session.

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

/** A hermetic managed install: on-PATH wrapper + a fake claudeBin that logs
 *  argv and, on its FIRST run only, atomically drops `markerJson` under the
 *  pinned sid it inherited, then sleeps (the watcher SIGTERMs it). Later runs
 *  exit 0 immediately. */
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
    // first launch: the pinned session id, the flags, AND the one-shot prompt
    const first = lines[0]!.split(" ");
    expect(first[0]).toBe("--session-id");
    expect(first.slice(2)).toEqual(["--model", "opus", "do", "the", "thing"]);
    // respawn: the MARKER's transcript id (not the pinned one), flags only
    expect(lines[1]).toBe(`--resume ${MARKER_SID} --model opus`);

    // flags persist under BOTH transcript ids, positional-free
    const pinned = first[1]!;
    for (const sid of [pinned, MARKER_SID]) {
      const stored = JSON.parse(readFileSync(join(setup.tmHome, "sessions", `${sid}.json`), "utf8"));
      expect(stored.flags).toEqual(["--model", "opus"]);
    }
    // the consumed marker is gone
    expect(existsSync(join(setup.tmHome, "respawn", pinned))).toBe(false);
  },
  30_000,
);

test(
  "an INVALID marker is dropped without killing the session or respawning",
  () => {
    // old-schema marker: no sessionId - must never SIGTERM the child or crash
    // the supervisor after the fact
    const setup = buildInstall("invalid", JSON.stringify({ account: "acct-b", ts: 1, waitUntil: 1 }));
    const p = runManaged(setup, ["--model", "opus"]);
    expect(p.exitCode).toBe(0);

    const lines = readFileSync(setup.argsLog, "utf8").trim().split("\n");
    expect(lines.length).toBe(1); // no respawn happened
    const pinned = lines[0]!.split(" ")[1]!;
    expect(existsSync(join(setup.tmHome, "respawn", pinned))).toBe(false); // dropped, not left behind
  },
  30_000,
);

test(
  "restored session flags are sanitized: a pre-fix stored positional never rides a bare --resume",
  () => {
    // a sessions/ file written before stripPositionals existed can carry the
    // original prompt in `flags`; the restore path must enforce the
    // flags-only contract at read (PR #37 review catch)
    const sid = "55555555-5555-4555-8555-555555555555";
    const setup = buildInstall("restore", JSON.stringify({ account: "x", ts: 1, waitUntil: 1, sessionId: sid }));
    mkdirSync(join(setup.tmHome, "sessions"), { recursive: true });
    writeFileSync(
      join(setup.tmHome, "sessions", `${sid}.json`),
      JSON.stringify({ flags: ["--model", "opus", "do the thing"], cwd: "/some/cwd" }),
    );
    // pre-create the counter past 0 so the shim never writes a marker
    writeFileSync(join(setup.tmHome, "..", "count"), "1");
    const p = runManaged(setup, ["--resume", sid]);
    expect(p.exitCode).toBe(0);

    const lines = readFileSync(setup.argsLog, "utf8").trim().split("\n");
    expect(lines).toEqual([`--resume ${sid} --model opus`]);
  },
  30_000,
);
