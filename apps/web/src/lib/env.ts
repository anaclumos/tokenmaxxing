import { z } from "zod";

export const env = z
  .object({
    DATABASE_URL: z.string(),
    CRON_SECRET: z.string(),
  })
  .parse(process.env);
