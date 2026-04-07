import { z } from "zod";

const EnvSchema = z.object({
  DATABASE_URL: z.string(),
  CRON_SECRET: z.string(),
  RESEND_API_KEY: z.string(),
  RESEND_FROM: z.string(),
});

const DatabaseEnvSchema = EnvSchema.pick({ DATABASE_URL: true });
const CronEnvSchema = EnvSchema.pick({ CRON_SECRET: true });
const ResendEnvSchema = EnvSchema.pick({
  RESEND_API_KEY: true,
  RESEND_FROM: true,
});
const WeeklyDigestEnvSchema = EnvSchema.pick({
  CRON_SECRET: true,
  RESEND_API_KEY: true,
  RESEND_FROM: true,
});

type DatabaseEnv = z.infer<typeof DatabaseEnvSchema>;
type CronEnv = z.infer<typeof CronEnvSchema>;
type ResendEnv = z.infer<typeof ResendEnvSchema>;
type WeeklyDigestEnv = z.infer<typeof WeeklyDigestEnvSchema>;

let _databaseEnv: DatabaseEnv;
let _cronEnv: CronEnv;
let _resendEnv: ResendEnv;
let _weeklyDigestEnv: WeeklyDigestEnv;

export function databaseEnv(): DatabaseEnv {
  _databaseEnv ??= DatabaseEnvSchema.parse(process.env);
  return _databaseEnv;
}

export function cronEnv(): CronEnv {
  _cronEnv ??= CronEnvSchema.parse(process.env);
  return _cronEnv;
}

export function resendEnv(): ResendEnv {
  _resendEnv ??= ResendEnvSchema.parse(process.env);
  return _resendEnv;
}

export function weeklyDigestEnv(): WeeklyDigestEnv {
  _weeklyDigestEnv ??= WeeklyDigestEnvSchema.parse(process.env);
  return _weeklyDigestEnv;
}
