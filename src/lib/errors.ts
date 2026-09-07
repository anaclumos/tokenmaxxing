import { z } from "zod";

const ErrnoSchema = z.object({ code: z.string() });

export function errnoCode(e: unknown): string | null {
  const parsed = ErrnoSchema.safeParse(e);
  return parsed.success ? parsed.data.code : null;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
