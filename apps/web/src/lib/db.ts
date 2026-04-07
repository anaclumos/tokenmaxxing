import { createDb } from "@tokenmaxxing/db/index";

import { databaseEnv } from "@/lib/env";

let _db: ReturnType<typeof createDb>;

export function db() {
  _db ??= createDb(databaseEnv().DATABASE_URL);
  return _db;
}
