import { afterAll, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeBin, scratchDir, serve, useEnv } from "./edge-providers-fixtures.ts";

const onPath = scratchDir("bin-on-path");
const record = join(scratchDir("vibe-record"), "env.txt");
const liveHome = scratchDir("vibe-home");

fakeBin(
  onPath,
  "vibe",
  [
    'if [ "$1" = "--version" ]; then echo "vibe 3.1.0"; exit 0; fi',
    '[ "$1" = "--setup" ] || exit 9',
    `printf '%s|%s|%s' "$VIBE_TEST_DISABLE_KEYRING" "\${MISTRAL_API_KEY-unset}" "\${VIBE_CLI_OIDC_ENABLED-unset}" > '${record}'`,
    `printf "MISTRAL_API_KEY='onboard-key'\\n" > "$VIBE_HOME/.env"`,
  ].join("\n"),
);

const users: Record<string, unknown> = {
  "Bearer onboard-key": { id: "user_test", email: " Dev@Example.com ", organization: { id: "org_test", name: "Test Org" } },
  "Bearer live-key": { id: "user_live", email: "live@example.com", organization: { id: "org_test", name: "Test Org" } },
};

const stub = serve((req) => {
  const user = new URL(req.url).pathname === "/mistral/v1/users/me" ? users[req.headers.get("authorization") ?? ""] : undefined;
  return user === undefined ? Response.json({ detail: "Unauthorized" }, { status: 401 }) : Response.json(user);
});

const restoreEnv = useEnv({
  HOME: scratchDir("home"),
  TOKENMAXXING_HOME: scratchDir("state"),
  VIBE_HOME: liveHome,
  MISTRAL_API_KEY: "inherited-key",
  VIBE_CLI_OIDC_ENABLED: "1",
  TOKENMAXXING_VIBE_BIN: undefined,
  TOKENMAXXING_VIBE_API_URL: `${stub.base}/mistral`,
  PATH: `${onPath}:${process.env.PATH ?? ""}`,
});
afterAll(() => {
  stub.stop();
  restoreEnv();
});

const { paths, vibeAuthJsonFor } = await import("../src/lib/paths.ts");
const { vibe } = await import("../src/lib/vibe.ts");

const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

test("vibe login runs vibe --setup in a throwaway VIBE_HOME with the keyring off and no inherited key, and pools the key under the Mistral user and organization", async () => {
  const harvest = await vibe.login();
  await harvest?.park();
  const id = sha256("user_test:org_test");
  const store = vibeAuthJsonFor(id);

  expect({
    id: harvest?.id,
    email: harvest?.email,
    childEnv: readFileSync(record, "utf8"),
    store: JSON.parse(readFileSync(store, "utf8")),
    storeMode: statSync(store).mode & 0o777,
    usable: await vibe.storeUsable({ id, label: "vibe-one", email: null, tier: null, addedAt: new Date(0).toISOString(), windows: [] }),
    onboardLeft: readdirSync(paths.onboardDir).filter((name) => name.startsWith("vibe-")),
  }).toEqual({
    id,
    email: "dev@example.com",
    childEnv: "1|unset|unset",
    store: { id, apiKey: "onboard-key" },
    storeMode: 0o600,
    usable: true,
    onboardLeft: [],
  });
}, 30_000);

test("vibe init pools the key in VIBE_HOME/.env, quoted and followed by a comment, without starting a login", async () => {
  writeFileSync(join(liveHome, ".env"), 'OTHER=1\nexport MISTRAL_API_KEY="live-key" # set by vibe\n');

  const harvest = await vibe.importLive();

  expect({ id: harvest?.id, email: harvest?.email }).toEqual({ id: sha256("user_live:org_test"), email: "live@example.com" });
}, 30_000);
