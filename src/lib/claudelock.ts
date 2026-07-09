// Best-effort interlock with Claude Code's OWN credential-refresh lock so our
// keychain write can't collide with a concurrent token refresh. Claude uses the
// npm `proper-lockfile` (mkdir-based) at <claudeDir>/.oauth_refresh.lock - the
// lock is the DIRECTORY itself. We mkdir it; on contention we wait briefly, then
// proceed anyway (our own flock already serializes tokenmaxxing swaps, and claude
// only refreshes near token expiry / on 401, rarely at the 95% usage trigger).

import { mkdirSync, rmdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./paths.ts";
import { log } from "./log.ts";

const STALE_MS = 20_000; // proper-lockfile default stale is 10s; be generous

export async function withClaudeRefreshLock<T>(
  fn: () => Promise<T> | T,
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  const lockDir = join(paths.claudeDir, ".oauth_refresh.lock");
  const timeoutMs = opts.timeoutMs ?? 3000;
  const start = Date.now();
  let held = false;

  while (Date.now() - start < timeoutMs) {
    try {
      mkdirSync(lockDir); // atomic; EEXIST means someone holds it
      held = true;
      break;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "EEXIST") {
        try {
          if (Date.now() - statSync(lockDir).mtimeMs > STALE_MS) {
            rmdirSync(lockDir); // reclaim a stale lock
            continue;
          }
        } catch { /* raced away */ }
        await Bun.sleep(150);
        continue;
      }
      // parent dir missing or other error → skip the interlock entirely
      break;
    }
  }
  if (!held) log("claudelock.proceed_without", {});

  try {
    return await fn();
  } finally {
    if (held) {
      try { rmdirSync(lockDir); } catch { /* already gone */ }
    }
  }
}
