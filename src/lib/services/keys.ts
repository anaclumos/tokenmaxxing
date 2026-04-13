import { getDb } from "@/lib/db";
import { providerKeys, orgDeks, secretAccessLog } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import {
  generateDek,
  encryptWithDek,
  decryptWithDek,
  encryptDek,
  decryptDek,
  getKek,
} from "@/lib/crypto/keys";

async function getOrCreateDek(
  orgId: string,
): Promise<{ dek: Buffer; version: number }> {
  const db = getDb();
  const kek = getKek();

  const existing = await db.query.orgDeks.findFirst({
    where: eq(orgDeks.orgId, orgId),
  });

  if (existing) {
    return { dek: decryptDek(existing.encryptedDek, kek), version: existing.kekVersion };
  }

  const dek = generateDek();
  const encrypted = encryptDek(dek, kek);

  await db
    .insert(orgDeks)
    .values({ orgId, encryptedDek: encrypted, kekVersion: 1 })
    .onConflictDoNothing();

  const row = await db.query.orgDeks.findFirst({
    where: eq(orgDeks.orgId, orgId),
  });

  return { dek: decryptDek(row!.encryptedDek, kek), version: row!.kekVersion };
}

export async function resolveOrgKeys(
  orgId: string,
): Promise<Record<string, string>> {
  const db = getDb();

  const dekRow = await db.query.orgDeks.findFirst({
    where: eq(orgDeks.orgId, orgId),
  });
  if (!dekRow) return {};

  const kek = getKek();
  const dek = decryptDek(dekRow.encryptedDek, kek);

  const keys = await db.query.providerKeys.findMany({
    where: eq(providerKeys.orgId, orgId),
  });

  const result: Record<string, string> = {};
  for (const key of keys) {
    const { ciphertext, iv } = JSON.parse(key.encryptedKey);
    result[key.provider] = decryptWithDek(ciphertext, iv, dek);
  }

  await db.insert(secretAccessLog).values({
    orgId,
    accessor: "system",
    resourceType: "provider_key",
  });

  return result;
}

export async function storeProviderKey(
  orgId: string,
  provider: string,
  apiKey: string,
  userId: string,
) {
  const db = getDb();
  const { dek, version } = await getOrCreateDek(orgId);
  const { ciphertext, iv } = encryptWithDek(apiKey, dek);

  await db
    .delete(providerKeys)
    .where(
      and(eq(providerKeys.orgId, orgId), eq(providerKeys.provider, provider)),
    );

  await db.insert(providerKeys).values({
    orgId,
    provider,
    encryptedKey: JSON.stringify({ ciphertext, iv }),
    dekVersion: version,
    createdBy: userId,
  });

  await db.insert(secretAccessLog).values({
    orgId,
    accessor: userId,
    resourceType: "provider_key",
  });
}

export async function deleteProviderKey(orgId: string, provider: string) {
  const db = getDb();
  await db
    .delete(providerKeys)
    .where(
      and(eq(providerKeys.orgId, orgId), eq(providerKeys.provider, provider)),
    );
}
