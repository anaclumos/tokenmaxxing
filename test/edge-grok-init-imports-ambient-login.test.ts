import { expect, test } from "bun:test";
import { join } from "node:path";
import { readConfig, run } from "./edge-telemetry-fixtures.ts";
import { preparedHomes } from "./edge-async-sweep-fixtures.ts";
import { fileTree, grokAccounts, grokAuthText, grokEntry, grokEnv, grokStore, installGrok, listed, loginRuns, serveGrokCredits, withPath, writeGrokAuth } from "./edge-grok-statusonly-fixtures.ts";

const FIRST = "5acd9b76-af8c-4e3d-8b6b-7cdf2e8a4d95";
const SECOND = "6bde0c87-b09d-4f4e-9c7d-8de03b9f5ea6";

test("init --grok copies the first login of ~/.grok/auth.json into a 0600 store verbatim, leaves that home byte-identical, runs no grok login, pins grokBin, and installs no grok wrapper", async () => {
  const homes = preparedHomes();
  const grok = installGrok();
  const first = grokEntry(FIRST, { email: "first@example.com", expiresAt: Date.now() + 3_600_000 });
  const second = grokEntry(SECOND, { email: "second@example.com" });
  const ambient = join(homes.home, ".grok");
  writeGrokAuth(ambient, { [FIRST]: first, [SECOND]: second });
  const stub = serveGrokCredits({});
  try {
    const result = await run(["init", "--grok"], grokEnv(homes, stub, withPath(grok.dir)));
    expect({
      exitCode: result.exitCode,
      accounts: grokAccounts(homes),
      store: grokStore(homes, FIRST),
      secondStore: grokStore(homes, SECOND),
      ambient: fileTree(ambient),
      logins: loginRuns(homes, grok),
      grokBin: readConfig(homes)?.grokBin,
      wrapperInstalled: listed(join(homes.state, "bin")).includes("grok"),
      saysStatusOnly: result.stdout.includes("status-only"),
      pointsAtAdd: result.stdout.includes("add --grok"),
      stderr: result.stderr,
    }).toEqual({
      exitCode: 0,
      accounts: [{ id: FIRST, label: "first@example.com", email: "first@example.com" }],
      store: { doc: { [FIRST]: first }, mode: 0o600 },
      secondStore: null,
      ambient: { "auth.json": grokAuthText({ [FIRST]: first, [SECOND]: second }) },
      logins: [],
      grokBin: grok.bin,
      wrapperInstalled: false,
      saysStatusOnly: true,
      pointsAtAdd: true,
      stderr: "",
    });
  } finally {
    stub.stop();
  }
}, 30_000);
