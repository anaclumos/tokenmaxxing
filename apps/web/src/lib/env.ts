import { z } from "zod";

const EnvSchema = z.object({
  DATABASE_URL: z.string(),
  CRON_SECRET: z.string(),
});

type Env = z.infer<typeof EnvSchema>;

let _env: Env;

export function env(): Env {
  _env ??= EnvSchema.parse(process.env);
  return _env;
}
