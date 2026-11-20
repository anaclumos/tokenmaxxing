import { expect, test } from "bun:test";
import { preparedHomes } from "./edge-async-sweep-fixtures.ts";
import { agyAccounts, agyIdentity, agyStore, agyToken, agyEnv, installAgyVersionBin, installFakeAgy, serveAgyQuota, writeAgyLive } from "./edge-agy-fixtures.ts";
import { readConfig, run } from "./edge-telemetry-fixtures.ts";

test("init --agy imports a live antigravity-oauth-token that has id_token_email and no id_token, and does not start an isolated login", async () => {
  const homes = preparedHomes();
  const agy = installAgyVersionBin(homes);
  const token = agyToken({ email: "Dev@Example.com", access: "live-access", refresh: "live-refresh", idToken: false });
  writeAgyLive(homes, token);
  const stub = serveAgyQuota({});
  try {
    const result = await run(["init", "--agy"], agyEnv(homes, stub, { binDir: agy.dir }));
    const id = agyIdentity("dev@example.com");
    expect({
      exitCode: result.exitCode,
      accounts: agyAccounts(homes).map((a) => ({ id: a.id, label: a.label, email: a.email })),
      store: agyStore(homes, id),
      agyBin: readConfig(homes)?.agyBin,
      stderr: result.stderr,
    }).toEqual({
      exitCode: 0,
      accounts: [{ id, label: "dev@example.com", email: "dev@example.com" }],
      store: { doc: token, mode: 0o600 },
      agyBin: agy.bin,
      stderr: "",
    });
  } finally {
    stub.stop();
  }
}, 30_000);

test("init --agy with a live id_token pools sha256(sub) even when id_token_email is present", async () => {
  const homes = preparedHomes();
  const agy = installAgyVersionBin(homes);
  const token = agyToken({ sub: "google-sub-agy-live", email: "Dev@Example.com", access: "sub-access", refresh: "sub-refresh" });
  writeAgyLive(homes, token);
  const stub = serveAgyQuota({});
  try {
    const result = await run(["init", "--agy"], agyEnv(homes, stub, { binDir: agy.dir }));
    const id = agyIdentity("google-sub-agy-live");
    expect({
      exitCode: result.exitCode,
      accounts: agyAccounts(homes).map((a) => ({ id: a.id, email: a.email })),
      store: agyStore(homes, id) != null,
      stderr: result.stderr,
    }).toEqual({
      exitCode: 0,
      accounts: [{ id, email: "dev@example.com" }],
      store: true,
      stderr: "",
    });
  } finally {
    stub.stop();
  }
}, 30_000);

test("add --agy pools an isolated login whose antigravity-oauth-token has id_token_email and no id_token", async () => {
  const homes = preparedHomes();
  const token = agyToken({ email: "Add@Example.com", access: "add-access", refresh: "add-refresh", idToken: false });
  const agy = installFakeAgy(homes, JSON.stringify(token));
  const stub = serveAgyQuota({});
  try {
    const result = await run(["add", "--agy"], agyEnv(homes, stub, { binDir: agy.dir }));
    const id = agyIdentity("add@example.com");
    expect({
      exitCode: result.exitCode,
      accounts: agyAccounts(homes).map((a) => ({ id: a.id, label: a.label, email: a.email })),
      store: agyStore(homes, id),
      logins: agy.logins().length,
      stderr: result.stderr,
    }).toEqual({
      exitCode: 0,
      accounts: [{ id, label: "add@example.com", email: "add@example.com" }],
      store: { doc: token, mode: 0o600 },
      logins: 1,
      stderr: "",
    });
  } finally {
    stub.stop();
  }
}, 30_000);
