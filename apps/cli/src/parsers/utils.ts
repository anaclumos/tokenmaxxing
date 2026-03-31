import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";

// Read a JSONL file line by line, yielding parsed JSON objects
export async function* readJsonl<T = unknown>(path: string): AsyncGenerator<T> {
  const rl = createInterface({
    input: createReadStream(path, "utf-8"),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      yield JSON.parse(trimmed) as T;
    } catch {
      // Skip malformed lines
    }
  }
}

// SHA-256 hash for session deduplication (never send raw session IDs)
export function sessionHash(client: string, sessionId: string): string {
  return createHash("sha256").update(`${client}:${sessionId}`).digest("hex");
}
