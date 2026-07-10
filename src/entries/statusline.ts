// statusLine shim. Reads Claude's statusLine stdin, tees the rate-limit data to
// usage.json (write-on-change, O(ms)), then transparently delegates to the user's
// prior statusLine command (same stdin) and passes its stdout through unchanged.
// Must NEVER break the user's status line: every step is best-effort.

import { readOAuthAccount } from "../lib/claudejson.ts";
import { readPriorStatusLine } from "../lib/settings.ts";
import { loadLastSwapAt, writeUsage } from "../lib/state.ts";
import { parseStatusLineStdin, parseStatusLineModel } from "../lib/usage.ts";
import type { UsageState } from "../lib/types.ts";

/** A session that hasn't adopted a fresh swap yet (<=30s keychain cache) pushes
 *  the OLD account's windows while ~/.claude.json already names the NEW org.
 *  Suppress the tee for this long after a swap so that mislabel never lands. */
const ADOPTION_GRACE_MS = 45_000;

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const c of Bun.stdin.stream()) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

export async function runStatusline(): Promise<number> {
  const raw = await readStdin();

  // 1) tee usage - best effort, never throws out.
  try {
    const obj = JSON.parse(raw);
    const windows = parseStatusLineStdin(obj);
    const lastSwapAt = loadLastSwapAt();
    if (windows && (lastSwapAt == null || Date.now() - lastSwapAt >= ADOPTION_GRACE_MS)) {
      const org = readOAuthAccount()?.organizationUuid ?? null;
      const state: UsageState = { ...windows, org, ts: Date.now(), model: parseStatusLineModel(obj) };
      writeUsage(state);
    }
  } catch {
    // malformed stdin - skip usage, still delegate below
  }

  // 2) delegate to the prior statusLine, feeding it the same stdin.
  const prior = readPriorStatusLine();
  if (prior) {
    try {
      const p = Bun.spawn(["/bin/sh", "-c", prior], {
        stdin: new TextEncoder().encode(raw),
        stdout: "pipe",
        stderr: "inherit",
      });
      const out = await new Response(p.stdout).text();
      await p.exited;
      if (out) process.stdout.write(out);
      return p.exitCode ?? 0;
    } catch {
      // fall through to no-op
    }
  }
  return 0;
}
