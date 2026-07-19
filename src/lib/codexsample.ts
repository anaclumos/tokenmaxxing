// Per-account codex usage sampling for status/ls. The ACTIVE account (the live
// auth.json's own identity, never the possibly-drifted label) samples through
// the LIVE blob: its parked copy goes stale as the running codex rotates
// tokens, and refreshing a superseded parked refresh token would trip the
// server's reuse punishment and kill the grant family. Parked accounts sample
// through their parked blobs (their owners are not running, so rotation on
// refresh is safe) and every rotation is persisted back immediately.
//
// Caller holds the codex flock: refresh writes must not interleave with a swap.

import { codexIdentityOf, isCodexAccessExpiring, readLiveCodexAuth, readParkedCodexAuth, writeLiveCodexAuth, writeParkedCodexAuth } from "./codexauth.ts";
import { CodexInvalidGrantError, CodexRefreshFailedError, refreshCodexAuth } from "./codexoauth.ts";
import { CodexUsageReadError, fetchCodexUsage } from "./codexusage.ts";
import { presentCodexAccountIds } from "./codexpresence.ts";
import type { CodexAccount, CodexUsage } from "./types.ts";
import { z } from "zod";

const CodexSampleOutcomeSchema = z.union([
  z.object({ ok: z.literal(true), usage: z.custom<CodexUsage>() }),
  z.object({ ok: z.literal(false), reason: z.string(), deadGrant: z.boolean() }),
]);
export type CodexSampleOutcome = z.infer<typeof CodexSampleOutcomeSchema>;

/** The live credential's own account id, or null when absent/unreadable. */
export function liveCodexAccountId(): string | null {
  const live = readLiveCodexAuth();
  if (!live) return null;
  return codexIdentityOf({ auth: live }).accountId;
}

export async function sampleCodexAccount(input: { account: CodexAccount; liveAccountId: string | null; now?: number }): Promise<CodexSampleOutcome> {
  const { account, liveAccountId, now = Date.now() } = input;
  const isLive = liveAccountId != null && account.accountId === liveAccountId;
  try {
    let auth = isLive ? readLiveCodexAuth() : readParkedCodexAuth({ credFile: account.credFile });
    if (!auth) return { ok: false, reason: isLive ? "live auth.json vanished" : "no parked credential", deadGrant: false };
    if (isCodexAccessExpiring({ auth, now })) {
      // NEVER refresh a PRESENT account's token, live or parked. A parked
      // blob whose account is RUNNING in another supervised session is
      // superseded by that session's live rotations, and the LIVE blob's
      // running session can be mid-turn refreshing the same rotating token
      // concurrently (both actors share the 300s margin): either way the
      // loser of the race is reuse-punished into a dead grant family
      // (closing-review catch; the idle-turn-boundary safety argument covers
      // only the invoking session's own account). Parked reports a miss; live
      // fetches on the unrotated token, still valid within the margin, and
      // degrades to an honest miss once it expires.
      const running = presentCodexAccountIds().has(account.accountId);
      if (running && !isLive) {
        return { ok: false, reason: "running in a live codex session (parked token refresh unsafe)", deadGrant: false };
      }
      if (!running) {
        auth = await refreshCodexAuth({ auth, now });
        if (isLive) writeLiveCodexAuth({ auth });
        writeParkedCodexAuth({ credFile: account.credFile, auth });
      }
    }
    const usage = await fetchCodexUsage({ auth });
    return { ok: true, usage };
  } catch (e) {
    // Only the EXPECTED operational failures become a sample miss; parse and
    // filesystem errors keep propagating (they are drift or bugs to surface).
    if (e instanceof CodexInvalidGrantError) {
      return { ok: false, reason: e.message, deadGrant: true };
    }
    if (e instanceof CodexRefreshFailedError || e instanceof CodexUsageReadError) {
      return { ok: false, reason: e.message, deadGrant: false };
    }
    throw e;
  }
}
