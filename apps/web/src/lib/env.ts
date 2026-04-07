import { z } from "zod";

const EnvSchema = z.object({
  DATABASE_URL: z.string(),
  CRON_SECRET: z.string(),
});

const DatabaseEnvSchema = EnvSchema.pick({ DATABASE_URL: true });
const CronEnvSchema = EnvSchema.pick({ CRON_SECRET: true });

type DatabaseEnv = z.infer<typeof DatabaseEnvSchema>;
type CronEnv = z.infer<typeof CronEnvSchema>;

let _databaseEnv: DatabaseEnv;
let _cronEnv: CronEnv;

export function databaseEnv(): DatabaseEnv {
  _databaseEnv ??= DatabaseEnvSchema.parse(process.env);
  return _databaseEnv;
}

export function cronEnv(): CronEnv {
  _cronEnv ??= CronEnvSchema.parse(process.env);
  return _cronEnv;
}
