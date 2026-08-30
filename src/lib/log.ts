import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { paths } from "./paths.ts";

const LOG_MAX_BYTES = 5_000_000;

function redact(s: string): string {
  return s
    .replace(/\b(sk-ant-[A-Za-z0-9._-]{6,})/g, "sk-ant-***")
    .replace(/\b([A-Za-z0-9_-]{40,})\b/g, (m) => `${m.slice(0, 4)}...(${m.length})`);
}

let echo: ((input: { event: string; parts: string }) => void) | null = null;

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
    if (existsSync(paths.logFile) && statSync(paths.logFile).size > LOG_MAX_BYTES) {
      renameSync(paths.logFile, `${paths.logFile}.old`);
    }
    appendFileSync(paths.logFile, `${new Date().toISOString()} ${event} ${line}\n`);
  } catch {
  }
  try {
    echo?.({ event, parts: line });
  } catch {
  }
}
