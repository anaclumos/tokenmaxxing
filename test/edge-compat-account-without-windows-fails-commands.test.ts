import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanEnv, dropSandbox, runMain, sandbox } from "./edge-compat-fixtures.ts";

function parsedOrRaw(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

test("an account record without windows makes status --cached and emails fail on the index schema", async () => {
  const box = sandbox("no-windows");
  try {
    const record = { id: crypto.randomUUID(), label: "seat", email: "seat@example.com", tier: "max 5x", addedAt: new Date(0).toISOString() };
    writeFileSync(join(box.tm, "accounts.json"), JSON.stringify({ version: 2, accounts: [record] }));
    const env = cleanEnv(box, {});
    const status = await runMain({ args: ["status", "--cached", "--json"], env, cwd: box.root });
    const emails = await runMain({ args: ["emails"], env, cwd: box.root });

    expect({ status: { ...status, doc: parsedOrRaw(status.stdout) }, emails }).toMatchObject({
      status: { exitCode: 1, doc: { ok: false, error: expect.stringMatching(/accounts\.json does not match its schema \(.*windows/) } },
      emails: { exitCode: 1, stdout: "", stderr: expect.stringMatching(/accounts\.json does not match its schema \(.*windows/) },
    });
  } finally {
    dropSandbox(box);
  }
}, 30_000);
