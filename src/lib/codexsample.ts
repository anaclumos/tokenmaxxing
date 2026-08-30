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
    if (e instanceof CodexInvalidGrantError) {
      return { ok: false, reason: e.message, deadGrant: true };
    }
    if (e instanceof CodexRefreshFailedError || e instanceof CodexUsageReadError) {
      return { ok: false, reason: e.message, deadGrant: false };
    }
    throw e;
  }
}
