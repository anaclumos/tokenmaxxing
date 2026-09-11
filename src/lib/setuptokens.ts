import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { paths } from "./paths.ts";
import { writeFileAtomic } from "./atomic.ts";

export const CURSOR_SECRET_VALUE_CAP_BYTES = 4096;
export const SETUP_TOKEN_STALE_MS = 335 * 86_400_000;

const SetupTokenSchema = z.object({ label: z.string().min(1), token: z.string().min(1), mintedAt: z.number() });
export type SetupToken = z.infer<typeof SetupTokenSchema>;

const SetupTokensFileSchema = z.object({ version: z.literal(1), tokens: z.array(SetupTokenSchema).default([]) });
export type SetupTokensFile = z.infer<typeof SetupTokensFileSchema>;

export const CloudTokenSchema = z.object({ label: z.string().min(1), token: z.string().min(1) });
export type CloudToken = z.infer<typeof CloudTokenSchema>;
export const CloudTokensSchema = z.array(CloudTokenSchema).min(1);

export function loadSetupTokens(): SetupTokensFile {
  if (!existsSync(paths.setupTokensJson)) return { version: 1, tokens: [] };
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(paths.setupTokensJson, "utf8"));
  } catch {
    throw new Error(`${paths.setupTokensJson} is corrupt (unparsable JSON) - refusing to treat a damaged token store as empty; repair or remove the file`);
  }
  const parsed = SetupTokensFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`${paths.setupTokensJson} does not match the setup-token schema - repair or remove the file`);
  }
  return parsed.data;
}

export function saveSetupTokens(file: SetupTokensFile): void {
  writeFileAtomic(paths.setupTokensJson, JSON.stringify(SetupTokensFileSchema.parse(file), null, 2) + "\n");
}

export function cursorSecretValue(tokens: SetupToken[]): string {
  return JSON.stringify(CloudTokensSchema.parse(tokens.map(({ label, token }) => ({ label, token }))));
}
