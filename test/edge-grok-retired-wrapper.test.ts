import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "./edge-telemetry-fixtures.ts";
import { preparedHomes, startStub, stubEnv } from "./edge-async-sweep-fixtures.ts";

test("a CLI run removes the grok wrapper an older version installed, so grok is no longer intercepted", async () => {
  const homes = preparedHomes();
  const wrapper = join(homes.state, "bin", "grok");
  mkdirSync(join(homes.state, "bin"), { recursive: true });
  writeFileSync(wrapper, "#!/bin/sh\nexec tokenmaxxing __supervise-grok \"$@\"\n", { mode: 0o755 });
  const stub = startStub({ gated: [] });
  try {
    const result = await run(["status", "--cached"], stubEnv(homes, stub.base));
    expect({ exitCode: result.exitCode, wrapperRemains: existsSync(wrapper), stderr: result.stderr }).toMatchObject({ exitCode: 0, wrapperRemains: false });
  } finally {
    stub.stop();
  }
}, 30_000);
