// Append-only logging. NEVER logs secret material - callers must pass only
// non-secret context (account uuids/emails, percentages, status strings).

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { paths } from "./paths.ts";

/** Redact anything that looks like a token so an accidental pass-through can't leak. */
export function redact(s: string): string {
  return s
    // JWT-ish / long opaque tokens
    .replace(/\b(sk-ant-[A-Za-z0-9._-]{6,})/g, "sk-ant-***")
    .replace(/\b([A-Za-z0-9_-]{40,})\b/g, (m) => `${m.slice(0, 4)}...(${m.length})`);
}

export function log(event: string, fields: Record<string, unknown> = {}): void {
  try {
    mkdirSync(dirname(paths.logFile), { recursive: true });
    const parts = Object.entries(fields).map(([k, v]) => {
      const str = z.string().safeParse(v);
      return `${k}=${redact(str.success ? str.data : JSON.stringify(v))}`;
    });
    appendFileSync(paths.logFile, `${new Date().toISOString()} ${event} ${parts.join(" ")}\n`);
  } catch {
    // logging must never throw into a hook / supervisor path
  }
}
