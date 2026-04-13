import { validateOrgAccess } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { providerKeys } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { z, ZodError } from "zod";
import { storeProviderKey, deleteProviderKey } from "@/lib/services/keys";

const storeKeySchema = z.object({
  provider: z.string().min(1),
  apiKey: z.string().min(1),
});

const deleteKeySchema = z.object({
  provider: z.string().min(1),
});

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  await validateOrgAccess(orgId);
  const db = getDb();

  const rows = await db
    .select({
      id: providerKeys.id,
      provider: providerKeys.provider,
      validatedAt: providerKeys.validatedAt,
      createdAt: providerKeys.createdAt,
    })
    .from(providerKeys)
    .where(eq(providerKeys.orgId, orgId));

  const masked = rows.map((row) => ({
    ...row,
    maskedKey: "••••••••",
  }));

  return Response.json(masked);
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const session = await validateOrgAccess(orgId);

  try {
    const body = storeKeySchema.parse(await req.json());
    await storeProviderKey(orgId, body.provider, body.apiKey, session.userId);
    return Response.json({ provider: body.provider }, { status: 201 });
  } catch (e) {
    if (e instanceof ZodError) {
      return Response.json({ error: e.issues }, { status: 400 });
    }
    throw e;
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  await validateOrgAccess(orgId);

  try {
    const body = deleteKeySchema.parse(await req.json());
    await deleteProviderKey(orgId, body.provider);
    return Response.json({ deleted: true });
  } catch (e) {
    if (e instanceof ZodError) {
      return Response.json({ error: e.issues }, { status: 400 });
    }
    throw e;
  }
}
