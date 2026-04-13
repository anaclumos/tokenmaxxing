import { getDb } from "@/lib/db";
import { mcpCatalogEntries } from "@/lib/db/schema";

export async function GET() {
  const db = getDb();
  const entries = await db.select().from(mcpCatalogEntries);
  return Response.json(entries);
}
