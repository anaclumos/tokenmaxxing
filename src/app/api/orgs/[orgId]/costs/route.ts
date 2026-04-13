import { validateOrgAccess } from "@/lib/auth";
import { getCostsData } from "@/lib/board/data";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  await validateOrgAccess(orgId);

  const url = new URL(request.url);
  const agentId = url.searchParams.get("agentId") ?? undefined;
  const from = url.searchParams.get("from") ?? undefined;
  const to = url.searchParams.get("to") ?? undefined;

  const data = await getCostsData(orgId, { agentId, from, to });
  return Response.json(data);
}
