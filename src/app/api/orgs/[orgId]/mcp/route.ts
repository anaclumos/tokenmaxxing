import { validateOrgAccess, requireOrgAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { orgMcpInstallations, mcpCatalogEntries } from "@/lib/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { z, ZodError } from "zod";

const installSchema = z.object({
  catalogEntryId: z.string().uuid().optional(),
  customUrl: z.string().url().optional(),
  customName: z.string().optional(),
});

export async function GET(
  req: Request,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  await validateOrgAccess(orgId);
  const db = getDb();

  const rows = await db
    .select()
    .from(orgMcpInstallations)
    .where(eq(orgMcpInstallations.orgId, orgId))
    .orderBy(desc(orgMcpInstallations.activatedAt));

  return Response.json(rows);
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const session = await requireOrgAdmin();
  if (session.orgId !== orgId) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  const db = getDb();

  try {
    const body = installSchema.parse(await req.json());
    if (!body.catalogEntryId && !body.customUrl) {
      return Response.json(
        { error: "Either catalogEntryId or customUrl is required" },
        { status: 400 },
      );
    }

    const [installation] = await db
      .insert(orgMcpInstallations)
      .values({
        orgId,
        catalogEntryId: body.catalogEntryId ?? null,
        customUrl: body.customUrl ?? null,
        customName: body.customName ?? null,
        status: "active",
        activatedBy: session.userId,
        activatedAt: new Date(),
      })
      .returning();

    return Response.json(installation, { status: 201 });
  } catch (e) {
    if (e instanceof ZodError) {
      return Response.json({ error: e.issues }, { status: 400 });
    }
    throw e;
  }
}
