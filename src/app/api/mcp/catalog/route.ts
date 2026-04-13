import { connection } from "next/server";
import { listMcpCatalogEntries } from "@/lib/board/data";

export async function GET() {
  await connection();
  return Response.json(await listMcpCatalogEntries());
}
