import { neon, neonConfig } from "@neondatabase/serverless";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-http";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

// PlanetScale Postgres uses Neon-compatible HTTP protocol
neonConfig.fetchEndpoint = (host) => `https://${host}/sql`;

// For serverless (Vercel Functions, edge) - uses HTTP, no persistent connection
export function createDb(url: string) {
  const sql = neon(url);
  return drizzleNeon({ client: sql, schema });
}

// For scripts, migrations, local dev - uses TCP connection
export function createDbDirect(url: string) {
  const client = postgres(url, { ssl: "require" });
  return drizzlePg({ client, schema });
}

export type Db = ReturnType<typeof createDb>;
export * from "./schema";
