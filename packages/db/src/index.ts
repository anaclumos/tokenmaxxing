import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

export function createDb(url: string) {
  return drizzle({ client: postgres(url), schema });
}

export type Db = ReturnType<typeof createDb>;
export * from "./schema";
