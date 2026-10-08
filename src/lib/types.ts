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

const AggregateWindowsSchema = z.object({
  fiveHour: UsageWindowSchema,
  sevenDay: UsageWindowSchema,
});

export const BankedResetSchema = z.object({ grant: z.string().nullable() });
export type BankedReset = z.infer<typeof BankedResetSchema>;

export type UsageWindows = z.infer<typeof AggregateWindowsSchema> & { perModel: Record<string, UsageWindow>; bankedReset?: BankedReset };

export const WindowSchema = z.object({
  name: z.string().nullable(),
  usedPercentage: z.number(),
  resetsAt: z.number().nullable(),
  windowSeconds: z.number().nullable(),
  sampledAt: z.number(),
});
export type Window = z.infer<typeof WindowSchema>;

const ModelInfoSchema = z.object({ id: z.string(), display: z.string() });
export type ModelInfo = z.infer<typeof ModelInfoSchema>;

export const UsageStateSchema = AggregateWindowsSchema.extend({
  account: z.string(),
  ts: z.number(),
  model: ModelInfoSchema.nullable().default(null),
  sampledAt: z.number().optional(),
});
export type UsageState = z.infer<typeof UsageStateSchema>;

export const AccountSchema = z.object({
  id: z.string(),
  label: z.string(),
  email: z.string().nullable(),
  tier: z.string().nullable(),
  addedAt: z.string(),
  windows: z.array(WindowSchema).default([]),
  lastUsageAt: z.number().optional(),
  lastProbeAt: z.number().optional(),
  probeFails: z.number().optional(),
  storeFails: z.number().optional(),
  usageRetryAt: z.number().optional(),
  enforcedUntil: z.number().optional(),
  needsReauth: z.boolean().optional(),
  hasCredits: z.boolean().optional(),
  bankedReset: BankedResetSchema.optional(),
  bankedResetAt: z.number().optional(),
  oauthAccount: OAuthAccountSchema.optional(),
});
export type Account = z.infer<typeof AccountSchema>;

export const AccountsIndexSchema = z.object({
  version: z.literal(2),
  accounts: z.array(AccountSchema).default([]),
});
export type AccountsIndex = z.infer<typeof AccountsIndexSchema>;

export type EnforcedLimit = {
  account: string;
  kind: "session" | "weekly" | "model" | "credits" | "org" | "overage";
  family: string | null;
  resetsAt: number | null;
  blind: boolean;
};

export type Thresholds = { session: number; weekly: number };

export type AccountThresholds = Thresholds & { credits: boolean };

export type Bars = Thresholds & { accounts: Map<string, AccountThresholds>; accountReleaseMs: Thresholds };

const PercentSchema = z.number().min(0).max(100);

export const ConfigSchema = z
  .object({
    thresholds: z
      .object({
        session: PercentSchema.default(90),
        weekly: PercentSchema.default(98),
        accounts: z.record(z.string(), z.object({ session: PercentSchema, weekly: PercentSchema, credits: z.boolean().default(false) })).default({}),
      })
      .prefault({}),
    claudeBin: z.string().default(""),
    codexBin: z.string().default(""),
    grokBin: z.string().default(""),
    piBin: z.string().default(""),
    policy: z
      .object({
        projectionMargin: z.number().min(0).max(100).default(0),
        switchModels: z
          .array(z.string())
          .default(["fable"])
          .transform((models) => models.map((model) => model.toLowerCase())),
        usagePollTtlMs: z.number().int().positive().default(90_000),
        maxWaitMs: z.number().int().positive().default(3_600_000),
        checkIntervalMs: z.number().int().min(10_000).default(60_000),
        accountReleaseMs: z
          .object({
            session: z.number().int().min(0).default(1_800_000),
            weekly: z.number().int().min(0).default(18_000_000),
          })
          .prefault({}),
      })
      .prefault({}),
    hub: z
      .object({
        port: z.number().int().min(1).max(65_535).default(8317),
      })
      .prefault({}),
  })
  .refine((cfg) => [cfg.thresholds, ...Object.values(cfg.thresholds.accounts)].every((t) => cfg.policy.projectionMargin < t.session), {
    path: ["policy", "projectionMargin"],
    message: "must be strictly below every session threshold (the session bar would hit zero and every account it covers would read as exhausted)",
  });
export type Config = z.infer<typeof ConfigSchema>;

export const WaitClaimSchema = z.object({
  sessionId: z.string(),
  accountId: z.string(),
  at: z.number(),
  waitUntil: z.number(),
});
export type WaitClaim = z.infer<typeof WaitClaimSchema>;

export const WaitQueueSchema = z.object({
  version: z.literal(1),
  claims: z.array(WaitClaimSchema).default([]),
});

export const RespawnMarkerSchema = z.object({
  accountId: z.string(),
  ts: z.number(),
  waitUntil: z.number(),
  sessionId: z.string(),
  compact: z.boolean(),
  origin: z.enum(["stop", "sessionstart", "stopfailure", "seatwatch"]),
  launchedAt: z.number().optional(),
  refused: z.array(z.string()).optional(),
  apiKeyId: z.string().optional(),
});

export const ApiKeySchema = z.object({
  id: z.string(),
  label: z.string(),
  workspaceId: z.string().optional(),
  creditUsd: z.number().optional(),
  spentUsd: z.number(),
  creditSetAt: z.number(),
  refusedAt: z.number().optional(),
  addedAt: z.number(),
});
export type ApiKey = z.infer<typeof ApiKeySchema>;

export const ApiKeysIndexSchema = z.object({
  version: z.literal(1),
  keys: z.array(ApiKeySchema).default([]),
});
export type ApiKeysIndex = z.infer<typeof ApiKeysIndexSchema>;

export const SessionCostSchema = z.object({ sessionId: z.string(), usd: z.number() });
export type SessionCost = z.infer<typeof SessionCostSchema>;

export const CostLineSchema = z
  .looseObject({ session_id: z.string(), total_cost_usd: z.number().optional(), cost: z.looseObject({ total_cost_usd: z.number() }).nullable().optional() })
  .transform((line): SessionCost | null => {
    const usd = line.total_cost_usd ?? line.cost?.total_cost_usd;
    return usd == null ? null : { sessionId: line.session_id, usd };
  });

export const EpochSecondsSchema = z.number().transform((seconds) => seconds * 1000);

export const InstantSchema = z.iso.datetime({ offset: true }).transform((iso) => Date.parse(iso));

const StdinWindowSchema = z.looseObject({ used_percentage: z.number(), resets_at: EpochSecondsSchema.nullable().optional() });

export const RateLimitsStdinSchema = z.looseObject({
  rate_limits: z
    .looseObject({
      five_hour: StdinWindowSchema.optional(),
      seven_day: StdinWindowSchema.optional(),
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

export type CodexUsage = {
  accountId: string;
  email: string | null;
  planType: string | null;
  hasCredits: boolean | null;
  bankedReset: BankedReset | undefined;
  windows: Window[];
};

export const CodexStopStdinSchema = z.looseObject({
  session_id: z.string().optional(),
  hook_event_name: z.string().optional(),
});

export const CodexRespawnMarkerSchema = z.object({
  accountId: z.string(),
  sessionId: z.string().nullable(),
  ts: z.number(),
});

export const ErrnoSchema = z.object({ code: z.string() });

export const JsonTextSchema = z.codec(z.string(), z.unknown(), {
  decode: (text, ctx) => {
    try {
      return JSON.parse(text);
    } catch {
      ctx.issues.push({ code: "invalid_format", format: "json", input: text });
      return z.NEVER;
    }
  },
  encode: (value) => JSON.stringify(value),
});
