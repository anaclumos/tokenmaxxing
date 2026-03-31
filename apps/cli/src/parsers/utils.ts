import { createHash } from "node:crypto"
import { createReadStream, readFileSync } from "node:fs"
import { createInterface } from "node:readline"

// Read a JSONL file line by line, yielding parsed JSON objects
export async function* readJsonl<T = unknown>(path: string): AsyncGenerator<T> {
  const rl = createInterface({
    input: createReadStream(path, "utf-8"),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed: T = JSON.parse(trimmed)
    yield parsed
  }
}

export function readJsonFile<T>(path: string): T {
  const parsed: T = JSON.parse(readFileSync(path, "utf-8"))
  return parsed
}

// SHA-256 hash for session deduplication (never send raw session IDs)
export function sessionHash(client: string, sessionId: string): string {
  return createHash("sha256").update(`${client}:${sessionId}`).digest("hex")
}
