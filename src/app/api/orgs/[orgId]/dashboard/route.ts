import { validateOrgAccess } from "@/lib/auth";
import { getDashboardData } from "@/lib/board/data";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  await validateOrgAccess(orgId);

  return Response.json(await getDashboardData(orgId));
}
