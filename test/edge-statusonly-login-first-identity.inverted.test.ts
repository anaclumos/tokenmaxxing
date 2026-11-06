import { afterAll, expect, test } from "bun:test";
import { fakeBin, scratchDir, useEnv } from "./edge-providers-fixtures.ts";

const LOGIN = JSON.stringify({
  providers: {
    device: { access_token: "tok-device" },
    meta: { access_token: "tok-meta", user_email: " Dev@Example.com " },
  },
});

const onPath = scratchDir("bin-on-path");
fakeBin(
  onPath,
  "muse",
  ['if [ "$1" != "login" ]; then echo "Muse Code 1.4.0"; exit 0; fi', 'mkdir -p "$XDG_CONFIG_HOME/muse"', `printf '%s' '${LOGIN}' > "$XDG_CONFIG_HOME/muse/auth.json"`].join("\n"),
);

const restoreEnv = useEnv({
  HOME: scratchDir("home"),
  TOKENMAXXING_HOME: scratchDir("state"),
  XDG_CONFIG_HOME: scratchDir("config"),
  TOKENMAXXING_XDG_CONFIG_HOME: undefined,
  TOKENMAXXING_MUSE_BIN: undefined,
  PATH: `${onPath}:${process.env.PATH ?? ""}`,
});
afterAll(restoreEnv);

const { muse } = await import("../src/lib/muse.ts");

test("inverted: a status-only login pools the first entry that carries an identity, skipping a provider entry without one", async () => {
  const harvest = await muse.login();

  expect({ id: harvest?.id, email: harvest?.email }).not.toEqual({
    id: new Bun.CryptoHasher("sha256").update("dev@example.com").digest("hex"),
    email: "dev@example.com",
  });
}, 30_000);
