import { validateOrgAccess } from "@/lib/auth";
import { listActivityEntries } from "@/lib/board/data";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  await validateOrgAccess(orgId);

  const url = new URL(request.url);
  const actorType = url.searchParams.get("actorType") ?? undefined;
  const resourceType = url.searchParams.get("resourceType") ?? undefined;

  const rows = await listActivityEntries(orgId, { actorType, resourceType });
  return Response.json(rows);
}
