import { neon, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

// PlanetScale Postgres uses Neon-compatible HTTP protocol
neonConfig.fetchEndpoint = (host) => `https://${host}/sql`;

export function createDb(url: string) {
  const sql = neon(url);
  return drizzle({ client: sql, schema });
}

export type Db = ReturnType<typeof createDb>;
export * from "./schema";
