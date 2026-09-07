import { isEqual, uniq } from "es-toolkit";
import { z } from "zod";

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

export const CredentialBlobSchema = z.looseObject({ claudeAiOauth: OAuthCredsSchema });
export type CredentialBlob = z.infer<typeof CredentialBlobSchema>;

export const OAuthAccountSchema = z.looseObject({
  accountUuid: z.string(),
  emailAddress: z.string(),
  organizationUuid: z.string(),
  organizationName: z.string().nullish(),
  seatTier: z.string().nullish(),
  billingType: z.string().nullish(),
  displayName: z.string().nullish(),
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

export const UsageStateSchema = UsageWindowsSchema.extend({
  account: z.string().nullable(),
  ts: z.number(),
  model: ModelInfoSchema.nullable().default(null),
});
export type UsageState = z.infer<typeof UsageStateSchema>;

export const ModelUsageStateSchema = z.object({
  perModel: z.record(z.string(), UsageWindowSchema).default({}),
  account: z.string().nullable(),
  ts: z.number(),
  sampledAt: z.number().optional(),
});
export type ModelUsageState = z.infer<typeof ModelUsageStateSchema>;

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
  lastPerModelAt: z.number().optional(),
  lastUsageAt: z.number().optional(),
  enforcedUntil: z.number().optional(),
  needsReauth: z.boolean().optional(),
  subscriptionType: z.string().optional(),
  rateLimitTier: z.string().optional(),
});
export type Account = z.infer<typeof AccountSchema>;

export const AccountsIndexSchema = z.object({
  version: z.literal(1),
  activeAccountUuid: z.string().nullable(),
  accounts: z.array(AccountSchema).default([]),
});
export type AccountsIndex = z.infer<typeof AccountsIndexSchema>;

export const LastSwapSchema = z.object({ ts: z.number() });

export const NextCheckSchema = z.object({ dueAt: z.number(), ts: z.number() });

export type EnforcedLimit = {
  account: string;
  family: string | null;
  resetsAt: number | null;
  windowMs: number;
};

export type Thresholds = { session: number; weekly: number };

const PercentSchema = z.number().min(0).max(100);

export const SessionLadderSchema = z
  .array(PercentSchema)
  .min(1)
  .refine((rungs) => isEqual(rungs, uniq(rungs).toSorted((a, b) => a - b)), {
    message: "thresholds.session rungs must be strictly ascending",
  });

export const ConfigSchema = z
  .object({
    thresholds: z.object({ session: SessionLadderSchema.default([90]), weekly: PercentSchema.default(98) }).prefault({}),
    hardThresholds: z.object({ session: PercentSchema.default(100), weekly: PercentSchema.default(100) }).prefault({}),
    claudeBin: z.string().default(""),
    codexBin: z.string().default(""),
    policy: z
      .object({
        projectionMargin: PercentSchema.default(0),
        greedySessionFloor: PercentSchema.default(80),
        greedySwapMargin: z.number().min(0).max(1).default(0.15),
        switchModels: z.array(z.string()).default(["fable"]).transform((models) => models.map((model) => model.toLowerCase())),
        usagePollTtlMs: z.number().int().positive().default(90_000),
        maxWaitMs: z.number().int().positive().default(3_600_000),
        checkIntervalMs: z.number().int().min(10_000).default(60_000),
      })
      .prefault({}),
  })
  .refine((cfg) => cfg.policy.projectionMargin < Math.min(...cfg.thresholds.session, cfg.thresholds.weekly), {
    message: "policy.projectionMargin must be strictly below every threshold (effectiveBars would hit zero and every account would read as exhausted)",
  })
  .refine((cfg) => cfg.hardThresholds.session >= Math.max(...cfg.thresholds.session) && cfg.hardThresholds.weekly >= cfg.thresholds.weekly, {
    message: "hardThresholds (the Layer 2 wall) must be at or above thresholds (the Layer 1 screening bars, the top session rung) for both windows",
  });
export type Config = z.output<typeof ConfigSchema>;

export const RespawnMarkerSchema = z.object({
  account: z.string(),
  ts: z.number(),
  waitUntil: z.number(),
  sessionId: z.string(),
  prompt: z.string().optional(),
  launchedAt: z.number().optional(),
});
export type RespawnMarker = z.infer<typeof RespawnMarkerSchema>;

export const RateLimitsStdinSchema = z.looseObject({
  rate_limits: z
    .looseObject({
      five_hour: z.looseObject({ used_percentage: z.number(), resets_at: z.number().nullable().optional() }).optional(),
      seven_day: z.looseObject({ used_percentage: z.number(), resets_at: z.number().nullable().optional() }).optional(),
    })
    .optional(),
  model: z.looseObject({ id: z.string().optional(), display_name: z.string().optional() }).optional(),
});

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

export const RefreshResponseSchema = z.looseObject({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.number(),
  refresh_token_expires_in: z.number().optional(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
});

export const ProfileResponseSchema = z.looseObject({
  account: z.looseObject({ uuid: z.string(), email: z.string().nullish() }),
  organization: z.looseObject({ uuid: z.string(), name: z.string().nullish() }),
});

export type TokenIdentity = {
  accountUuid: string;
  email: string | null;
  organizationUuid: string;
  organizationName: string | null;
};

const CodexTokensSchema = z.looseObject({
  id_token: z.string(),
  access_token: z.string(),
  refresh_token: z.string(),
  account_id: z.string().optional(),
});

export const CodexAuthJsonSchema = z.looseObject({
  tokens: CodexTokensSchema,
  last_refresh: z.string().optional(),
});
export type CodexAuthJson = z.infer<typeof CodexAuthJsonSchema>;

export const CodexAuthFileSchema = z.looseObject({
  tokens: CodexTokensSchema.nullish(),
  last_refresh: z.string().optional(),
});

const CodexWindowSchema = z.object({
  usedPercentage: z.number(),
  resetsAt: z.number().nullable(),
  windowSeconds: z.number().nullable(),
});
export type CodexWindow = z.infer<typeof CodexWindowSchema>;

export type CodexUsage = {
  accountId: string;
  email: string | null;
  planType: string | null;
  aggregate: CodexWindow[];
  perLimit: Record<string, CodexWindow[]>;
};

const BareFileNameSchema = z
  .string()
  .refine((s) => s.length > 0 && s !== "." && s !== ".." && !s.includes("/") && !s.includes("\\"), {
    message: "credFile must be a bare file name, not a path",
  });

export const CodexAccountSchema = z.object({
  accountId: z.string(),
  email: z.string().nullable(),
  label: z.string(),
  planType: z.string().nullable(),
  credFile: BareFileNameSchema,
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

export const CodexStopStdinSchema = z.looseObject({
  session_id: z.string().optional(),
  hook_event_name: z.string().optional(),
});

export const CodexRespawnMarkerSchema = z.object({
  account: z.string(),
  sessionId: z.string().nullable(),
  ts: z.number(),
});
export type CodexRespawnMarker = z.infer<typeof CodexRespawnMarkerSchema>;

export const CodexReconcileMarkerSchema = z.object({
  accountId: z.string(),
  ts: z.number(),
});
export type CodexReconcileMarker = z.infer<typeof CodexReconcileMarkerSchema>;
