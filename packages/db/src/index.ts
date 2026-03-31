import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

export function createDb(url: string) {
  return drizzle({ client: neon(url), schema });
}

export type Db = ReturnType<typeof createDb>;
export * from "./schema";
