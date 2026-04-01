import { createHash } from "node:crypto"
import { createReadStream, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { relative } from "node:path"
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
    try {
      yield JSON.parse(trimmed) as T
    } catch {
      // Skip malformed JSONL lines (truncated writes, corrupted files)
    }
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

// Extract a recognizable project name from a working directory path.
// Strips homedir and common dev directory prefixes (Developer, Projects, code).
export function projectFromCwd(cwd: string): string {
  const home = homedir();
  const rel = cwd.startsWith(home) ? relative(home, cwd) : cwd;
  const parts = rel.split("/").filter(Boolean);
  if (["Developer", "Projects", "code", "src", "repos"].includes(parts[0])) {
    parts.shift();
  }
  return parts.join("/") || rel;
}
