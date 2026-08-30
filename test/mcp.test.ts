import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  captureCli,
  createTokenmaxxingMcpServer,
  mutationsEnabled,
  refuseAmbientStoreEnv,
  scrubSecrets,
} from "../src/entries/mcp.ts";

const MUTATIONS_ENV = "TOKENMAXXING_AGENT_MUTATIONS";

beforeEach(() => {
  delete process.env[MUTATIONS_ENV];
  delete process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
});

afterEach(() => {
  delete process.env[MUTATIONS_ENV];
  delete process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
});

describe("mcp helpers", () => {
  test("scrubSecrets redacts bearer and sk-ant tokens", () => {
    const raw = 'Authorization: Bearer abc.def.ghi sk-ant-api03-DEADBEEF accessToken: "secret-value"';
    const scrubbed = scrubSecrets(raw);
    expect(scrubbed).not.toContain("abc.def.ghi");
    expect(scrubbed).not.toContain("sk-ant-api03-DEADBEEF");
    expect(scrubbed).not.toContain("secret-value");
    expect(scrubbed).toContain("[redacted]");
  });

  test("refuseAmbientStoreEnv prefers secure-storage over config-dir", () => {
    const suiteConfigDir = process.env.CLAUDE_CONFIG_DIR;
    if (suiteConfigDir == null || suiteConfigDir === "") {
      throw new Error("expected test/setup.ts to set CLAUDE_CONFIG_DIR");
    }
    expect(refuseAmbientStoreEnv()).toBe(suiteConfigDir);
    process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = "/tmp/secure-mcp-test";
    expect(refuseAmbientStoreEnv()).toBe("/tmp/secure-mcp-test");
  });

  test("captureCli keeps console.log off the real stdout stream", async () => {
    const cap = await captureCli(() => {
      console.log("hello-mcp");
      console.error("warn-mcp");
      return 7;
    });
    expect(cap).toEqual({ code: 7, stdout: "hello-mcp", stderr: "warn-mcp" });
  });

  test("captureCli serializes concurrent callers so console patches do not interleave", async () => {
    const slow = captureCli(async () => {
      console.log("a");
      await Bun.sleep(30);
      console.log("b");
      return 1;
    });
    const fast = captureCli(async () => {
      console.log("c");
      return 2;
    });
    const [a, b] = await Promise.all([slow, fast]);
    expect(a).toEqual({ code: 1, stdout: "a\nb", stderr: "" });
    expect(b).toEqual({ code: 2, stdout: "c", stderr: "" });
  });

  test("mutationsEnabled is only true when env is exactly 1", () => {
    expect(mutationsEnabled()).toBe(false);
    process.env[MUTATIONS_ENV] = "true";
    expect(mutationsEnabled()).toBe(false);
    process.env[MUTATIONS_ENV] = "1";
    expect(mutationsEnabled()).toBe(true);
  });
});

describe("mcp tools", () => {
  async function withClient(run: (client: Client) => Promise<void>): Promise<void> {
    const server = createTokenmaxxingMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      await run(client);
    } finally {
      await client.close();
      await server.close();
    }
  }

  test("lists the expected tools", async () => {
    await withClient(async (client) => {
      const listed = await client.listTools();
      const names = listed.tools.map((t) => t.name).sort();
      expect(names).toEqual([
        "config_get",
        "config_set",
        "config_unset",
        "doctor",
        "help",
        "pool_check",
        "pool_ls",
        "pool_status",
        "pool_switch",
      ].sort());
    });
  });

  test("pool_switch without confirm is denied", async () => {
    await withClient(async (client) => {
      const result = await client.callTool({ name: "pool_switch", arguments: { confirm: false } });
      const text = JSON.stringify(result);
      expect(text).toContain("confirm=true");
      expect(result.isError).toBe(true);
    });
  });

  test("pool_switch with confirm but without mutations env is denied", async () => {
    await withClient(async (client) => {
      const result = await client.callTool({ name: "pool_switch", arguments: { confirm: true } });
      const text = JSON.stringify(result);
      expect(text).toContain(MUTATIONS_ENV);
      expect(result.isError).toBe(true);
    });
  });

  test("pool_ls returns a non-error text result under the suite home", async () => {
    await withClient(async (client) => {
      const result = await client.callTool({ name: "pool_ls", arguments: {} });
      const text = JSON.stringify(result);
      expect(text).toContain("exit 0");
      expect(result.isError).not.toBe(true);
    });
  });

  test("help mentions the dual mutation gate and hard denies", async () => {
    await withClient(async (client) => {
      const result = await client.callTool({ name: "help", arguments: {} });
      const text = JSON.stringify(result);
      expect(text).toContain(MUTATIONS_ENV);
      expect(text).toContain("status --force");
      expect(text).toContain("credential blobs");
    });
  });
});
