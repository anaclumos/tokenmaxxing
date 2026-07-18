// Append-only logging. NEVER logs secret material - callers must pass only
// non-secret context (account uuids/emails, percentages, status strings).

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { paths } from "./paths.ts";

/** Redact anything that looks like a token so an accidental pass-through can't leak. */
function redact(s: string): string {
  return s
    // JWT-ish / long opaque tokens
    .replace(/\b(sk-ant-[A-Za-z0-9._-]{6,})/g, "sk-ant-***")
    .replace(/\b([A-Za-z0-9_-]{40,})\b/g, (m) => `${m.slice(0, 4)}...(${m.length})`);
}

let echo: ((input: { event: string; parts: string }) => void) | null = null;

/** Tee every subsequent log() line to a terminal printer. Only the serve
 *  daemon opts in: hooks and the statusline own their stdout protocol, so the
 *  echo stays off by default. The printer receives the same redacted parts the
 *  file line gets. */
export function setLogEcho(input: { printer: (input: { event: string; parts: string }) => void }): void {
  echo = input.printer;
}

export function log(event: string, fields: Record<string, unknown> = {}): void {
  let line = "";
  try {
    line = Object.entries(fields)
      .map(([k, v]) => {
        const str = z.string().safeParse(v);
        return `${k}=${redact(str.success ? str.data : JSON.stringify(v))}`;
      })
      .join(" ");
    mkdirSync(dirname(paths.logFile), { recursive: true });
    appendFileSync(paths.logFile, `${new Date().toISOString()} ${event} ${line}\n`);
  } catch {
    // logging must never throw into a hook / supervisor path
  }
  // separate from the file sink: an unwritable log file must not also silence
  // the terminal echo (that is exactly when the daemon needs to stay visible).
  try {
    echo?.({ event, parts: line });
  } catch {
    // the echo printer must never throw into the daemon either
  }
}
