import { requireOrgAdmin, validateOrgAccess } from "@/lib/auth";
import { listOrgMcpInstallations } from "@/lib/board/data";
import { installMcpServer } from "@/lib/board/mutations";
import { ZodError, z } from "zod";

const installMcpSchema = z.object({
  catalogEntryId: z.string().uuid().optional(),
  customUrl: z.string().url().optional(),
  customName: z.string().trim().optional(),
});

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  await validateOrgAccess(orgId);

  return Response.json(await listOrgMcpInstallations(orgId));
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const session = await requireOrgAdmin();

  if (session.orgId !== orgId) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const body = installMcpSchema.parse(await request.json());
    if (!body.catalogEntryId && !body.customUrl) {
      return Response.json(
        { error: "Either catalogEntryId or customUrl is required" },
        { status: 400 },
      );
    }

    const installation = await installMcpServer({
      orgId,
      actorId: session.userId,
      catalogEntryId: body.catalogEntryId,
      customUrl: body.customUrl,
      customName: body.customName,
    });

    return Response.json(installation, { status: 201 });
  } catch (error) {
    if (error instanceof ZodError) {
      return Response.json({ error: error.issues }, { status: 400 });
    }

    throw error;
  }
}
