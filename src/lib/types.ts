// Shared data model - Zod schemas are the single source of truth; TS types are
// inferred from them. Everything that crosses an external boundary (keychain
// blob, ~/.claude.json, hook/statusLine stdin, OAuth response, our own state
// files) is validated through these instead of hand-checked.

import { z } from "zod";

/** OAuth object inside the keychain blob (`claudeAiOauth`). Loose: preserve any
 *  extra fields claude may add so a harvest→install round-trip is lossless. */
export const OAuthCredsSchema = z.looseObject({
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
export type CredentialBlob = z.infer<typeof CredentialBlobSchema>;

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
});
export type OAuthAccount = z.infer<typeof OAuthAccountSchema>;

export const UsageWindowSchema = z.object({
  usedPercentage: z.number(),
  resetsAt: z.number().nullable(),
});
export type UsageWindow = z.infer<typeof UsageWindowSchema>;

export const UsageWindowsSchema = z.object({
  fiveHour: UsageWindowSchema,
  sevenDay: UsageWindowSchema,
});
export type UsageWindows = z.infer<typeof UsageWindowsSchema>;

export const ModelInfoSchema = z.object({ id: z.string(), display: z.string() });
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
  /** epoch ms of the sample behind lastUsage/lastPerModel. Their resetsAt
   *  values are absolute epochs (UTC-anchored), so even an old snapshot still
   *  resolves to correct resets - display it as a dated cache, never discard. */
  lastUsageAt: z.number().optional(),
  needsReauth: z.boolean().optional(),
  subscriptionType: z.string().optional(),
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
  session: z.number(),
  /** 7-day aggregate AND per-model weekly caps. */
  weekly: z.number(),
});
export type Thresholds = z.infer<typeof ThresholdsSchema>;

export const ConfigSchema = z.object({
  thresholds: ThresholdsSchema,
  claudeBin: z.string(),
  policy: z.object({
    projectionMargin: z.number(),
    /** session-used % at which the greedy convergence engages: from here on,
     *  every evaluation swaps to the usable account furthest behind its weekly
     *  pace whenever that beats the current one (idempotent; current keeps its
     *  seat on ties). Below the floor a fresh session rides its account. */
    greedySessionFloor: z.number(),
    /** models whose PER-MODEL weekly cap should trigger a switch (display names, lowercased). */
    switchModels: z.array(z.string()),
    /** how long a `/usage` per-model poll stays fresh before we re-poll (ms). */
    usagePollTtlMs: z.number(),
    /** when every account is depleted, auto-wait for a reset only if it is within this window (ms). */
    maxWaitMs: z.number(),
  }),
});
export type Config = z.infer<typeof ConfigSchema>;

/** The hook -> supervisor respawn marker at respawn/<session-id>. */
export const RespawnMarkerSchema = z.object({
  account: z.string(),
  ts: z.number(),
  /** when set, the supervisor waits until this epoch ms before relaunching. */
  waitUntil: z.number().optional(),
});
export type RespawnMarker = z.infer<typeof RespawnMarkerSchema>;

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

/** Success body of the OAuth refresh grant. */
export const RefreshResponseSchema = z.looseObject({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
  refresh_token_expires_in: z.number().optional(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
});
export type RefreshResponse = z.infer<typeof RefreshResponseSchema>;

/** Success body of GET /api/oauth/claude_cli/roles - the org a token ACTUALLY
 *  belongs to, independent of any stored label. */
export const RolesResponseSchema = z.looseObject({
  organization_uuid: z.string(),
  organization_name: z.string(),
});
export type RolesResponse = z.infer<typeof RolesResponseSchema>;
