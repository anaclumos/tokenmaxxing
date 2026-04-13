import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

export function generateDek(): Buffer {
  return randomBytes(32);
}

export function encryptWithDek(
  plaintext: string,
  dek: Buffer,
): { ciphertext: string; iv: string } {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, dek, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: Buffer.concat([encrypted, authTag]).toString("base64"),
    iv: iv.toString("base64"),
  };
}

export function decryptWithDek(
  ciphertext: string,
  iv: string,
  dek: Buffer,
): string {
  const ivBuf = Buffer.from(iv, "base64");
  const raw = Buffer.from(ciphertext, "base64");
  const authTag = raw.subarray(raw.length - AUTH_TAG_LENGTH);
  const encrypted = raw.subarray(0, raw.length - AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, dek, ivBuf);
  decipher.setAuthTag(authTag);
  return Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString("utf8");
}

export function encryptDek(dek: Buffer, kek: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, kek, iv);
  const encrypted = Buffer.concat([cipher.update(dek), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, encrypted, authTag]).toString("base64");
}

export function decryptDek(encryptedDek: string, kek: Buffer): Buffer {
  const raw = Buffer.from(encryptedDek, "base64");
  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(raw.length - AUTH_TAG_LENGTH);
  const encrypted = raw.subarray(IV_LENGTH, raw.length - AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, kek, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

export function getKek(): Buffer {
  return Buffer.from(process.env.ENCRYPTION_KEY!, "base64");
}
