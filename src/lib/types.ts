// Shared data model - Zod schemas are the single source of truth; TS types are
// inferred from them. Everything that crosses an external boundary (keychain
// blob, ~/.claude.json, hook/statusLine stdin, OAuth response, our own state
// files) is validated through these instead of hand-checked.

import { z } from "zod";

/** OAuth object inside the keychain blob (`claudeAiOauth`). Loose: preserve any
 *  extra fields claude may add so a harvest→install round-trip is lossless. */
const OAuthCredsSchema = z.looseObject({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.number(),
  refreshTokenExpiresAt: z.number().optional(),
  scopes: z.array(z.string()).default([]),
  subscriptionType: z.string().optional(),
  rateLimitTier: z.string().optional(),
});
export type OAuthCreds = z.infer<typeof OAuthCredsSchema>;

/** The `Claude Code-credentials` keychain item. Loose: the live item also holds
 *  sibling state (e.g. per-MCP-server OAuth tokens), which we must preserve when
 *  swapping - we only ever replace `claudeAiOauth`. */
export const CredentialBlobSchema = z.looseObject({ claudeAiOauth: OAuthCredsSchema });

/** The `oauthAccount` identity object in ~/.claude.json. Loose: preserve every
 *  key so we can reinstall it verbatim on activation. Only the three ids are
 *  required; real blobs carry many more fields (some null), so descriptive ones
 *  are `.nullish()` (string | null | undefined) to tolerate them. */
export const OAuthAccountSchema = z.looseObject({
  accountUuid: z.string(),
  emailAddress: z.string(),
  organizationUuid: z.string(),
  organizationName: z.string().nullish(),
  seatTier: z.string().nullish(),
  billingType: z.string().nullish(),
  displayName: z.string().nullish(),
  /** rate-limit tier id ("default_claude_max_20x"), same value the credential
   *  blob carries; claude fills it in on profile fetch (live-verified 2.1.211). */
  organizationRateLimitTier: z.string().nullish(),
});
export type OAuthAccount = z.infer<typeof OAuthAccountSchema>;

export const UsageWindowSchema = z.object({
  usedPercentage: z.number(),
  resetsAt: z.number().nullable(),
});
export type UsageWindow = z.infer<typeof UsageWindowSchema>;

const UsageWindowsSchema = z.object({
  fiveHour: UsageWindowSchema,
  sevenDay: UsageWindowSchema,
});
export type UsageWindows = z.infer<typeof UsageWindowsSchema>;

const ModelInfoSchema = z.object({ id: z.string(), display: z.string() });
export type ModelInfo = z.infer<typeof ModelInfoSchema>;

/** usage.json - written by the statusLine shim, read by the Stop hook. Carries
 *  the two AGGREGATE windows (session=fiveHour, week-all-models=sevenDay) plus
 *  the active model. Per-model caps live in ModelUsageState (from `/usage`). */
export const UsageStateSchema = UsageWindowsSchema.extend({
  org: z.string().nullable(),
  ts: z.number(),
  model: ModelInfoSchema.nullable().default(null),
});
export type UsageState = z.infer<typeof UsageStateSchema>;

/** model-usage.json - per-model weekly caps parsed from `claude -p '/usage'`,
 *  TTL-cached so we don't poll every turn. Keyed by model display name ("Fable"). */
export const ModelUsageStateSchema = z.object({
  perModel: z.record(z.string(), UsageWindowSchema).default({}),
  org: z.string().nullable(),
  ts: z.number(),
  /** when the rows were actually MEASURED. `ts` is the write time and drives
   *  the probe-TTL anti-storm, so a failed probe re-stamps it while carrying
   *  the OLD rows forward - dating those rows by ts rolled the null-reset
   *  self-bound forward on every failed probe (closing-review catch). Absent
   *  on records predating this field: readers fall back to ts. */
  sampledAt: z.number().optional(),
});
export type ModelUsageState = z.infer<typeof ModelUsageStateSchema>;

/** A parked account in the pool (accounts.json - NON-secret). */
export const AccountSchema = z.object({
  accountUuid: z.string(),
  email: z.string(),
  organizationUuid: z.string(),
  label: z.string(),
  keychainItem: z.string(),
  oauthAccount: OAuthAccountSchema,
  addedAt: z.string(),
  lastUsage: UsageWindowsSchema.optional(),
  lastPerModel: z.record(z.string(), UsageWindowSchema).optional(),
  /** epoch ms of the sample behind lastPerModel SPECIFICALLY: the aggregate
   *  stamp (lastUsageAt) advances on every engaged evaluation while the
   *  per-model rows refresh only when a gated family is measured, so dating
   *  the rows by lastUsageAt inflated the null-reset self-bound by days
   *  (closing-review catch). Absent on records predating this field: readers
   *  fall back to lastUsageAt, the previous (over-)approximation. */
  lastPerModelAt: z.number().optional(),
  /** epoch ms of the sample behind the AGGREGATE lastUsage windows (per-model
   *  rows date by lastPerModelAt above). resetsAt values are absolute epochs
   *  (UTC-anchored), so even an old snapshot still resolves to correct
   *  resets - display it as a dated cache, never discard. */
  lastUsageAt: z.number().optional(),
  needsReauth: z.boolean().optional(),
  subscriptionType: z.string().optional(),
  /** the blob's rate-limit tier id (e.g. "default_claude_max_20x"): the only
   *  field that distinguishes max 5x from max 20x (subscriptionType is just
   *  "max" for both). Refreshed on every verified sample. */
  rateLimitTier: z.string().optional(),
});
export type Account = z.infer<typeof AccountSchema>;

export const AccountsIndexSchema = z.object({
  version: z.literal(1),
  activeAccountUuid: z.string().nullable(),
  accounts: z.array(AccountSchema).default([]),
});

/** lastswap.json - epoch ms of the last credential swap. Its own tiny file (not
 *  accounts.json) so the statusLine shim reads a few bytes per tick and no other
 *  index writer can clobber it. Absent = no swap has ever run. */
export const LastSwapSchema = z.object({ ts: z.number() });
export type AccountsIndex = z.infer<typeof AccountsIndexSchema>;

/** Per-window screening bars (used %): an account with a window at/over its bar
 *  is no switch candidate until that window resets. The session bar is lower
 *  than the weekly one: a session reset is at most 5h away, so burning a little
 *  headroom there is cheap, while weekly quota is use-it-or-lose-it and worth
 *  draining closer to the wall. Screening is these bars' ONLY job - the switch
 *  trigger is the greedy pace-pressure convergence (policy.greedySessionFloor). */
export const ThresholdsSchema = z.object({
  /** 5h session window. */
  session: z.number().min(0).max(100),
  /** 7-day aggregate AND per-model weekly caps. */
  weekly: z.number().min(0).max(100),
});
export type Thresholds = z.infer<typeof ThresholdsSchema>;

export const ConfigSchema = z
  .object({
    thresholds: ThresholdsSchema,
    claudeBin: z.string(),
    /** the real codex binary (empty = resolve from PATH); pinned by `init --codex`. */
    codexBin: z.string(),
    policy: z.object({
      /** percent margin subtracted from every bar (effectiveBars); above 100 the
       *  effective bars go negative and everything reads exhausted, so bounded. */
      projectionMargin: z.number().min(0).max(100),
      /** session-used % at which the greedy convergence engages: from here on,
       *  every evaluation swaps to the usable account furthest behind its weekly
       *  pace whenever that beats the current one (idempotent; current keeps its
       *  seat on ties). Below the floor a fresh session rides its account. */
      greedySessionFloor: z.number().min(0).max(100),
      /** models whose PER-MODEL weekly cap should trigger a switch (display names, lowercased). */
      switchModels: z.array(z.string()),
      /** how long a `/usage` per-model poll stays fresh before we re-poll (ms). */
      usagePollTtlMs: z.number().int().positive(),
      /** when every account is depleted, auto-wait for a reset only if it is within this window (ms). */
      maxWaitMs: z.number().int().positive(),
    }),
  })
  // Cross-field (review catch, PR #31): effectiveBars subtracts the margin
  // from each threshold, and a bar at or below zero makes EVERY nonnegative
  // usage percentage read as exhausted - the whole pool looks depleted and the
  // switch path churns. Per-field bounds alone cannot see this.
  .refine((cfg) => cfg.policy.projectionMargin < Math.min(cfg.thresholds.session, cfg.thresholds.weekly), {
    message: "policy.projectionMargin must be strictly below both thresholds (effectiveBars would hit zero and every account would read as exhausted)",
  });
export type Config = z.infer<typeof ConfigSchema>;

/** The hook -> supervisor respawn marker. Written only for a depleted-pool
 *  wait (plain swaps adopt in place, no respawn). The marker FILE is keyed by
 *  the supervisor's PINNED session id (the path it watches - stable for the
 *  process's whole life), while `sessionId` carries the CURRENT transcript to
 *  resume: after /clear claude mints a new session id, and keying the file by
 *  the stdin sid orphaned every marker while the anticipatory pre-park still
 *  fired (closing-review HIGH catch; the codex marker was immune by exactly
 *  this construction). */
export const RespawnMarkerSchema = z.object({
  account: z.string(),
  ts: z.number(),
  /** the supervisor waits until this epoch ms before relaunching. */
  waitUntil: z.number(),
  /** the transcript to `--resume`: the hook-stdin session id, which drifts
   *  from the pinned id after /clear. */
  sessionId: z.string(),
});

/** rate_limits + model as they appear in statusLine stdin (epoch-seconds resets). */
export const RateLimitsStdinSchema = z.looseObject({
  rate_limits: z
    .looseObject({
      five_hour: z.looseObject({ used_percentage: z.number(), resets_at: z.number().nullable().optional() }).optional(),
      seven_day: z.looseObject({ used_percentage: z.number(), resets_at: z.number().nullable().optional() }).optional(),
    })
    .optional(),
  model: z.looseObject({ id: z.string().optional(), display_name: z.string().optional() }).optional(),
  organizationUuid: z.string().optional(),
});

/** The statusLine stdin fields the native renderer consumes, on top of the
 *  rate-limit tee's needs. Loose + optional throughout: fields are null before
 *  the first API response and claude adds new ones freely. Each sub-object also
 *  `.catch(undefined)`es so a field that drifts to a wrong shape degrades to
 *  absent instead of failing the whole parse and erasing the info block. */
export const StatusLineStdinSchema = RateLimitsStdinSchema.extend({
  workspace: z
    .looseObject({
      current_dir: z.string().nullable().optional(),
      project_dir: z.string().nullable().optional(),
    })
    .nullable()
    .optional()
    .catch(undefined),
  context_window: z.looseObject({ used_percentage: z.number().nullable().optional() }).nullable().optional().catch(undefined),
  cost: z
    .looseObject({
      total_lines_added: z.number().nullable().optional(),
      total_lines_removed: z.number().nullable().optional(),
    })
    .nullable()
    .optional()
    .catch(undefined),
  effort: z.looseObject({ level: z.string().optional() }).nullable().optional().catch(undefined),
});

/** subagentStatusLine stdin: base session fields plus one entry per active
 *  subagent task (verified against the 2.1.214 bundle + docs 2026-07-18;
 *  tasks[].model/contextWindowSize need claude >= 2.1.205, effort >= 2.1.214).
 *  Same loose + catch degradation contract as StatusLineStdinSchema. */
export const SubagentStatusLineStdinSchema = z.looseObject({
  tasks: z
    .array(
      z.looseObject({
        id: z.string().optional(),
        name: z.string().nullable().optional().catch(undefined),
        description: z.string().nullable().optional().catch(undefined),
        label: z.string().nullable().optional().catch(undefined),
        model: z.string().nullable().optional().catch(undefined),
        effort: z.string().nullable().optional().catch(undefined),
        contextWindowSize: z.number().nullable().optional().catch(undefined),
        tokenCount: z.number().nullable().optional().catch(undefined),
      }),
    )
    .optional()
    .catch(undefined),
});

/** Success body of the OAuth refresh grant. */
export const RefreshResponseSchema = z.looseObject({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
  refresh_token_expires_in: z.number().optional(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
});

/** Success body of GET /api/oauth/claude_cli/roles - the org a token ACTUALLY
 *  belongs to, independent of any stored label. */
export const RolesResponseSchema = z.looseObject({
  organization_uuid: z.string(),
  organization_name: z.string(),
});
export type RolesResponse = z.infer<typeof RolesResponseSchema>;

// ---- Codex pool ------------------------------------------------------------

/** `tokens` inside $CODEX_HOME/auth.json (verified against a live 0.144.4
 *  auth.json). Loose: preserve unknown siblings so a harvest and reinstall
 *  round-trip is lossless. */
const CodexTokensSchema = z.looseObject({
  id_token: z.string(),
  access_token: z.string(),
  refresh_token: z.string(),
  account_id: z.string().optional(),
});

/** The whole auth.json. Loose: auth_mode, OPENAI_API_KEY (may be null), and
 *  future siblings ride along verbatim. */
export const CodexAuthJsonSchema = z.looseObject({
  tokens: CodexTokensSchema,
  last_refresh: z.string().optional(),
});
export type CodexAuthJson = z.infer<typeof CodexAuthJsonSchema>;

/** One rate-limit window as tokenmaxxing stores it: percent used, absolute
 *  epoch ms reset, and the server-declared duration. Codex windows are
 *  duration-driven (the weekly window is PRIMARY on plans whose 5h window was
 *  removed in July 2026), so classification must go by windowSeconds, never
 *  by primary/secondary position. */
const CodexWindowSchema = z.object({
  usedPercentage: z.number(),
  resetsAt: z.number().nullable(),
  windowSeconds: z.number().nullable(),
});
export type CodexWindow = z.infer<typeof CodexWindowSchema>;

/** Everything one free usage read yields: the token's OWN identity (the codex
 *  analog of the claude roles endpoint: labels drift, the token cannot lie)
 *  plus every rate-limit window, aggregate and per-limit-family. */
export const CodexUsageSchema = z.object({
  accountId: z.string(),
  email: z.string().nullable(),
  planType: z.string().nullable(),
  aggregate: z.array(CodexWindowSchema),
  perLimit: z.record(z.string(), z.array(CodexWindowSchema)),
});
export type CodexUsage = z.infer<typeof CodexUsageSchema>;

/** A pooled codex account (codex-accounts.json - NON-secret). */
export const CodexAccountSchema = z.object({
  accountId: z.string(),
  email: z.string().nullable(),
  label: z.string(),
  planType: z.string().nullable(),
  credFile: z.string(),
  addedAt: z.string(),
  needsReauth: z.boolean().optional(),
  lastUsage: z
    .object({
      aggregate: z.array(CodexWindowSchema),
      perLimit: z.record(z.string(), z.array(CodexWindowSchema)),
    })
    .optional(),
  lastUsageAt: z.number().optional(),
});
export type CodexAccount = z.infer<typeof CodexAccountSchema>;

export const CodexAccountsIndexSchema = z.object({
  version: z.literal(1),
  activeAccountId: z.string().nullable(),
  accounts: z.array(CodexAccountSchema).default([]),
});
export type CodexAccountsIndex = z.infer<typeof CodexAccountsIndexSchema>;

/** Codex Stop-hook stdin (verified against the 0.144.4 binary wire schema and
 *  the official hooks reference): only what the swap trigger consumes. */
export const CodexStopStdinSchema = z.looseObject({
  session_id: z.string().optional(),
  hook_event_name: z.string().optional(),
});

/** The codex supervisor's respawn marker payload: which session to resume and
 *  under which account label (for the switch banner). */
export const CodexRespawnMarkerSchema = z.object({
  account: z.string(),
  sessionId: z.string().nullable(),
  ts: z.number(),
});

/** A cross-session reconcile signal (owner decisions 2026-07-20): the
 *  deciding actor saw the addressed supervisor's session running on this
 *  pooled NON-LIVE account - healthy or not (a non-live session cannot
 *  refresh cross-account and wedges at token expiry) - while the live seat
 *  is usable. The session's OWN Stop hook consumes it at its next turn
 *  boundary - the only safe respawn point - promoting it into a respawn
 *  marker with the session id its stdin alone carries. `accountId` doubles
 *  as the staleness guard: a session that already moved accounts drops the
 *  signal instead of respawning. */
export const CodexReconcileMarkerSchema = z.object({
  accountId: z.string(),
  ts: z.number(),
});
