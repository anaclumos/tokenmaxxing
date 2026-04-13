import { execFileSync } from "node:child_process";

export default async function globalSetup() {
  const env = {
    ...process.env,
    DATABASE_URL: "postgres://tokenmaxxing:tokenmaxxing@localhost:5432/tokenmaxxing",
    ENCRYPTION_KEY: "dGVzdGtleXRlc3RrZXl0ZXN0a2V5dGVzdGtleXM=",
  };

  console.log("[setup] Starting Postgres...");
  execFileSync("docker", ["compose", "up", "-d", "postgres"], {
    stdio: "inherit",
  });

  console.log("[setup] Waiting for Postgres to be ready...");
  for (let i = 0; i < 30; i++) {
    try {
      execFileSync(
        "docker",
        ["compose", "exec", "-T", "postgres", "pg_isready", "-U", "tokenmaxxing"],
        { stdio: "pipe" },
      );
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  console.log("[setup] Pushing schema...");
  execFileSync("bunx", ["drizzle-kit", "push", "--force"], {
    stdio: "inherit",
    env,
  });

  console.log("[setup] Seeding database...");
  execFileSync("bun", ["run", "src/lib/db/seed.ts"], {
    stdio: "inherit",
    env,
  });

  console.log("[setup] Ready.");
}
