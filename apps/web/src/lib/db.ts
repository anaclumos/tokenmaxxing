import { createDb } from "@tokenmaxxing/db/index";

let _db: ReturnType<typeof createDb>;

export function db() {
  _db ??= createDb(process.env.DATABASE_URL!);
  return _db;
}
