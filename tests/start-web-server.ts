import { execFileSync, spawn } from "node:child_process";

const env = {
  ...process.env,
  DATABASE_URL:
    process.env.DATABASE_URL ??
    "postgres://tokenmaxxing:tokenmaxxing@localhost:5432/tokenmaxxing",
  ENCRYPTION_KEY:
    process.env.ENCRYPTION_KEY ??
    "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
};

function run(command: string, args: string[]) {
  execFileSync(command, args, {
    env,
    stdio: "inherit",
  });
}

async function retry(step: string, fn: () => void | Promise<void>) {
  let lastError: unknown;

  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      await fn();
      return;
    } catch (error) {
      lastError = error;
      console.log(`[webserver] ${step} retry ${attempt}/10...`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  throw lastError;
}

async function waitForPostgres() {
  for (let i = 0; i < 30; i++) {
    try {
      run("docker", [
        "compose",
        "exec",
        "-T",
        "postgres",
        "pg_isready",
        "-U",
        "tokenmaxxing",
      ]);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  throw new Error("Postgres did not become ready in time");
}

async function main() {
  console.log("[webserver] Resetting Postgres volume...");
  run("docker", ["compose", "down", "-v"]);

  console.log("[webserver] Starting Postgres...");
  run("docker", ["compose", "up", "-d", "postgres"]);

  console.log("[webserver] Waiting for Postgres...");
  await waitForPostgres();

  console.log("[webserver] Pushing schema...");
  await retry("schema push", () => {
    run("bunx", ["drizzle-kit", "push", "--force"]);
  });

  console.log("[webserver] Seeding database...");
  await retry("database seed", () => {
    run("bun", ["run", "src/lib/db/seed.ts"]);
  });

  console.log("[webserver] Starting Next dev server...");
  const child = spawn("bun", ["run", "dev"], {
    env,
    stdio: "inherit",
  });

  const stopChild = (signal: NodeJS.Signals) => {
    child.kill(signal);
  };

  process.on("SIGINT", () => stopChild("SIGINT"));
  process.on("SIGTERM", () => stopChild("SIGTERM"));

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exit(code ?? 0);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
