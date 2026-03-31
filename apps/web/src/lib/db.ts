import { createDb } from "@tokenmaxxing/db/index";

import { env } from "@/lib/env";

let _db: ReturnType<typeof createDb>;

export function db() {
  _db ??= createDb(env.DATABASE_URL);
  return _db;
}
