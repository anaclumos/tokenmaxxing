import { expect, test } from "bun:test";
import { run } from "./edge-telemetry-fixtures.ts";
import { preparedHomes, startStub, stubEnv } from "./edge-async-sweep-fixtures.ts";
import { telemetrySetting } from "./edge-cli-surface-fixtures.ts";

test("inverted: telemetry on with a second operand exits 2 with the operand limit and leaves telemetry off", async () => {
  const homes = preparedHomes();
  const stub = startStub({ gated: [] });
  try {
    const result = await run(["telemetry", "on", "now"], stubEnv(homes, stub.base));
    expect({
      exitCode: result.exitCode,
      limitNamed: result.stderr.includes("telemetry takes at most 1 argument, got: on now"),
      stateReported: result.stdout.includes("telemetry is"),
      telemetry: telemetrySetting(homes),
      stderr: result.stderr,
    }).not.toMatchObject({ exitCode: 2, limitNamed: true, stateReported: false, telemetry: false });
  } finally {
    stub.stop();
  }
}, 30_000);
