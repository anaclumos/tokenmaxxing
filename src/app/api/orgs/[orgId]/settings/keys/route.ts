import { validateOrgAccess } from "@/lib/auth";
import { listProviderKeyStatus } from "@/lib/board/data";
import {
  deleteProviderKey,
  storeProviderKey,
} from "@/lib/services/keys";
import { ZodError, z } from "zod";

const saveKeySchema = z.object({
  provider: z.string().trim().min(1),
  apiKey: z.string().trim().min(1),
});

const deleteKeySchema = z.object({
  provider: z.string().trim().min(1),
});

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  await validateOrgAccess(orgId);

  return Response.json(await listProviderKeyStatus(orgId));
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const session = await validateOrgAccess(orgId);

  try {
    const body = saveKeySchema.parse(await request.json());
    await storeProviderKey(orgId, body.provider, body.apiKey, session.userId);
    return Response.json({ provider: body.provider }, { status: 201 });
  } catch (error) {
    if (error instanceof ZodError) {
      return Response.json({ error: error.issues }, { status: 400 });
    }

    throw error;
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  await validateOrgAccess(orgId);

  try {
    const body = deleteKeySchema.parse(await request.json());
    await deleteProviderKey(orgId, body.provider);
    return Response.json({ deleted: true });
  } catch (error) {
    if (error instanceof ZodError) {
      return Response.json({ error: error.issues }, { status: 400 });
    }

    throw error;
  }
}
