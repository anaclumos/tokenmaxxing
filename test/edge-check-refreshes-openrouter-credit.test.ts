import { expect, test } from "bun:test";
import { run } from "./edge-telemetry-fixtures.ts";
import { preparedHomes, stubEnv } from "./edge-async-sweep-fixtures.ts";
import { apiKeyRecord, runWithStdin, serveOpenRouter } from "./edge-cli-surface-fixtures.ts";

test("the check tick rereads the credit of an OpenRouter key that key add stored, and sends no Anthropic key's secret to OpenRouter", async () => {
  const homes = preparedHomes();
  const openrouter = serveOpenRouter([7.25, 3.5]);
  try {
    const env = stubEnv(homes, openrouter.base);
    const added = [
      await runWithStdin(["key", "add", "router"], env, "sk-or-v1-edge-router-key\n"),
      await runWithStdin(["key", "add", "console", "20"], env, "sk-ant-api03-edge-console-key\n"),
    ];
    const check = await run(["check"], env);
    expect({
      exitCodes: [...added.map((r) => r.exitCode), check.exitCode],
      routerLeft: apiKeyRecord(homes, "router")?.openrouter?.remainingUsd,
      consoleOpenRouter: apiKeyRecord(homes, "console")?.openrouter ?? null,
      bearers: openrouter.bearers,
      stderr: [...added.map((r) => r.stderr), check.stderr],
    }).toMatchObject({
      exitCodes: [0, 0, 0],
      routerLeft: 3.5,
      consoleOpenRouter: null,
      bearers: ["Bearer sk-or-v1-edge-router-key", "Bearer sk-or-v1-edge-router-key"],
    });
  } finally {
    openrouter.stop();
  }
}, 30_000);
