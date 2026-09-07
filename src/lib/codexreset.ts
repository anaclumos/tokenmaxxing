import { z } from "zod";
import { codexIdentityOf, readLiveCodexAuth } from "./codexauth.ts";
import { allWindows, barFor, liveUsed } from "./codexpick.ts";
import { loadCodexAccounts, saveCodexAccounts } from "./codexstate.ts";
import { http, safeErrorDetail } from "./http.ts";
import { log } from "./log.ts";
import type { CodexAccount, CodexAuthJson, CodexBankedResetOutcome, CodexWindow, Thresholds } from "./types.ts";

const EnvOverrideSchema = z.string().min(1).optional().catch(undefined);
const CONSUME_URL =
  EnvOverrideSchema.parse(process.env.TOKENMAXXING_CODEX_RESET_URL) ?? "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume";
const CONSUME_TIMEOUT_MS = 30_000;
const RETRY_KEY_TTL_MS = 10 * 60_000;
const WALL_PERCENT = 100;
const LIMIT_REACHED = "rate_limit_reached";

const VerdictSchema = z.enum(["hold", "claim", "pass"]);
export type CodexBankedVerdict = z.infer<typeof VerdictSchema>;
const ClaimSchema = z.enum(["reset", "pass"]);
export type CodexBankedClaim = z.infer<typeof ClaimSchema>;

export function codexBankedResetVerdict(input: { account: CodexAccount; thresholds: Thresholds; now: number; pollTtlMs: number }): CodexBankedVerdict {
  const { account, thresholds, now, pollTtlMs } = input;
  const usage = account.lastUsage;
  if (!usage) return "pass";
  const credits = usage.resetCredits ?? null;
  if (credits == null || credits <= 0) return "pass";
  const rec = account.bankedReset;
  if (rec != null && rec.outcome !== "reset" && now - rec.at < pollTtlMs) return "pass";
  const sampledAt = account.lastUsageAt ?? null;
  const windows = allWindows(account);
  const over = windows.some((window) => liveUsed({ window, now, sampledAt }) >= barFor({ window, thresholds }));
  if (!over) return "pass";
  const atWall = usage.reachedType === LIMIT_REACHED || windows.some((window) => liveUsed({ window, now, sampledAt }) >= WALL_PERCENT);
  return atWall ? "claim" : "hold";
}

const ConsumeResponseSchema = z.looseObject({
  code: z.enum(["reset", "nothing_to_reset", "no_credit", "already_redeemed"]),
  windows_reset: z.number().int().nullish(),
});

const ConsumeResultSchema = z.object({ outcome: z.enum(["reset", "nothing_to_reset", "no_credit", "already_redeemed", "auth_error", "error"]), detail: z.string() });
type ConsumeResult = z.infer<typeof ConsumeResultSchema>;

export async function consumeCodexBankedReset(input: { auth: CodexAuthJson; idempotencyKey: string }): Promise<ConsumeResult> {
  const { auth, idempotencyKey } = input;
  const identity = codexIdentityOf({ auth });
  let res: Response;
  try {
    res = await http.post(CONSUME_URL, {
      headers: {
        Authorization: `Bearer ${auth.tokens.access_token}`,
        "ChatGPT-Account-Id": identity.accountId,
        "User-Agent": "codex-cli",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ redeem_request_id: idempotencyKey }),
      timeout: CONSUME_TIMEOUT_MS,
    });
  } catch (e) {
    return { outcome: "error", detail: `reset endpoint unreachable: ${e instanceof Error ? e.message : String(e)}` };
  }
  const text = await res.text();
  if (!res.ok) {
    const detail = `HTTP ${res.status}: ${safeErrorDetail({ text })}`;
    if (res.status === 401 || res.status === 403) return { outcome: "auth_error", detail };
    return { outcome: "error", detail };
  }
  const parsed = ConsumeResponseSchema.safeParse((() => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  })());
  if (!parsed.success) return { outcome: "error", detail: `reset endpoint returned an unrecognized body (${text.length} bytes, withheld)` };
  return { outcome: parsed.data.code, detail: `${parsed.data.code} (windows reset: ${parsed.data.windows_reset ?? "unknown"})` };
}

export async function consumeLiveCodexBankedReset(input: { account: CodexAccount; now: number }): Promise<CodexBankedClaim> {
  const { account, now } = input;
  const short = account.accountId.slice(0, 8);
  const live = readLiveCodexAuth();
  let result: ConsumeResult;
  let idempotencyKey: string | null = null;
  if (!live) {
    result = { outcome: "auth_error", detail: "live auth.json vanished" };
  } else if (codexIdentityOf({ auth: live }).accountId !== account.accountId) {
    result = { outcome: "error", detail: "live codex credential belongs to another account" };
  } else {
    const prior = account.bankedReset;
    const retrying = prior != null && prior.outcome === "error" && prior.key != null && now - prior.at < RETRY_KEY_TTL_MS;
    idempotencyKey = retrying ? prior.key! : crypto.randomUUID();
    result = await consumeCodexBankedReset({ auth: live, idempotencyKey });
    if (result.outcome === "already_redeemed" && retrying) result = { outcome: "reset", detail: `${result.detail}; the retried key had already completed` };
  }
  const outcome: CodexBankedResetOutcome = result.outcome;
  const reset = outcome === "reset";
  const index = loadCodexAccounts();
  const entry = index.accounts.find((a) => a.accountId === account.accountId);
  if (entry) {
    entry.bankedReset = { outcome, at: now, ...(outcome === "error" && idempotencyKey != null ? { key: idempotencyKey } : {}) };
    if (reset && entry.lastUsage) {
      const cleared = (window: CodexWindow): CodexWindow => ({ ...window, usedPercentage: 0, resetsAt: null });
      entry.lastUsage = {
        ...entry.lastUsage,
        aggregate: entry.lastUsage.aggregate.map(cleared),
        perLimit: Object.fromEntries(Object.entries(entry.lastUsage.perLimit).map(([name, windows]) => [name, windows.map(cleared)])),
        resetCredits: entry.lastUsage.resetCredits != null ? Math.max(0, entry.lastUsage.resetCredits - 1) : null,
        reachedType: null,
      };
      entry.lastUsageAt = now;
    }
    saveCodexAccounts({ index });
  }
  log(reset ? "codexreset.consumed" : "codexreset.refused", { account: short, outcome, detail: result.detail.slice(0, 200) });
  return reset ? "reset" : "pass";
}
