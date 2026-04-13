import { neon, Pool } from "@neondatabase/serverless";
import { drizzle as drizzleHttp } from "drizzle-orm/neon-http";
import { drizzle as drizzlePool } from "drizzle-orm/neon-serverless";
import * as schema from "./schema";

type HttpDb = ReturnType<typeof drizzleHttp<typeof schema>>;
type PoolDb = ReturnType<typeof drizzlePool<typeof schema>>;

let httpDb: HttpDb | null = null;
let poolDb: PoolDb | null = null;

export function getDb(): HttpDb {
  if (!httpDb) {
    const sql = neon(process.env.DATABASE_URL!);
    httpDb = drizzleHttp(sql, { schema });
  }
  return httpDb;
}

export function getPoolDb(): PoolDb {
  if (!poolDb) {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL! });
    poolDb = drizzlePool(pool, { schema });
  }
  return poolDb;
}
