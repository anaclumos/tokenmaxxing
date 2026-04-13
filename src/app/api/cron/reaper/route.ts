import { reclaimStaleRuns } from "@/lib/services/scheduler";

export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const reclaimed = await reclaimStaleRuns(10);

  return Response.json({ reclaimed: reclaimed.length });
}
