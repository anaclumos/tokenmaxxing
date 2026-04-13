import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

type Db = ReturnType<typeof drizzle<typeof schema>>;

let pool: Pool | null = null;
let db: Db | null = null;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
    });
  }

  return pool;
}

export function getDb(): Db {
  if (!db) {
    db = drizzle(getPool(), { schema });
  }

  return db;
}

export const getPoolDb = getDb;
