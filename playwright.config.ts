import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "html",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
    screenshot: "on",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command:
      "BYPASS_AUTH=true NEXT_PUBLIC_BYPASS_AUTH=true bun run dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    env: {
      BYPASS_AUTH: "true",
      NEXT_PUBLIC_BYPASS_AUTH: "true",
      DATABASE_URL:
        process.env.DATABASE_URL ??
        "postgres://tokenmaxxing:tokenmaxxing@localhost:5432/tokenmaxxing",
      ENCRYPTION_KEY:
        process.env.ENCRYPTION_KEY ??
        "dGVzdGtleXRlc3RrZXl0ZXN0a2V5dGVzdGtleXM=",
    },
  },
  globalSetup: "./tests/global-setup.ts",
  globalTeardown: "./tests/global-teardown.ts",
});
