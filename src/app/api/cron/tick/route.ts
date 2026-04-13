import { claimDueRuns } from "@/lib/services/scheduler";

export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const claimed = await claimDueRuns(10);

  for (const run of claimed) {
    console.log(`claimed run ${run.id} for agent ${run.agent_id}`);
  }

  return Response.json({ claimed: claimed.length });
}
