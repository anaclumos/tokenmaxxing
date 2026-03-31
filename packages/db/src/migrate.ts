import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

const client = postgres(url, { ssl: "require", max: 1 });
const db = drizzle({ client });

await migrate(db, { migrationsFolder: "./migrations" });
await client.end();

console.log("Migration complete.");
