import { mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import * as kc from "./keychain.ts";
import { keychain as kcNames, namespacedCredService, storeDirFor } from "./paths.ts";
import { CredentialBlobSchema, ErrnoSchema, type OAuthCreds } from "./types.ts";

export type CredTarget = ({ kind: "keychain" } & kc.KeychainTarget) | { kind: "file"; path: string };

const darwin = process.platform === "darwin";

export async function readItem(t: CredTarget): Promise<string | null> {
  if (t.kind === "keychain") return kc.readItem(t);
  try {
    return readFileSync(t.path, "utf8");
  } catch (e) {
    if (ErrnoSchema.safeParse(e).data?.code === "ENOENT") return null;
    throw e;
  }
}

export async function writeItem(t: CredTarget, secret: string): Promise<void> {
  if (t.kind === "keychain") return kc.writeItem(t, secret);
  mkdirSync(dirname(t.path), { recursive: true, mode: 0o700 });
  writeFileAtomic(t.path, secret, 0o600);
}

export async function deleteItem(t: CredTarget): Promise<boolean> {
  if (t.kind === "keychain") return kc.deleteItem(t);
  try {
    unlinkSync(t.path);
    return true;
  } catch (e) {
    if (ErrnoSchema.safeParse(e).data?.code === "ENOENT") return false;
    throw e;
  }
}

export function isolatedTarget(configDirRaw: string): CredTarget {
  return darwin
    ? { kind: "keychain", service: namespacedCredService(configDirRaw), account: kcNames.account }
    : { kind: "file", path: join(configDirRaw, ".credentials.json") };
}

export function storeTarget(accountId: string): CredTarget {
  return isolatedTarget(storeDirFor(accountId));
}

export async function readStore(accountId: string): Promise<OAuthCreds | null> {
  const raw = await readItem(storeTarget(accountId));
  return raw == null ? null : CredentialBlobSchema.parse(JSON.parse(raw)).claudeAiOauth;
}

export function claudeAiOauthOnly(fullBlobRaw: string): string {
  const b = CredentialBlobSchema.parse(JSON.parse(fullBlobRaw));
  return JSON.stringify({ claudeAiOauth: b.claudeAiOauth });
}
