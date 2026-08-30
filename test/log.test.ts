import { describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { log, setLogEcho } from "../src/lib/log.ts";
import { paths } from "../src/lib/paths.ts";

describe("setLogEcho", () => {
  test("tees each event to the printer with the same redacted parts as the file line", () => {
    const seen: { event: string; parts: string }[] = [];
    setLogEcho({ printer: (entry) => seen.push(entry) });
    log("echo_test", { thread: "C0123:100.001", token: "sk-ant-oat01-abcdef" });
    setLogEcho({ printer: () => {} });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.event).toBe("echo_test");
    expect(seen[0]?.parts).toBe("thread=C0123:100.001 token=sk-ant-***");
    const fileLine = readFileSync(paths.logFile, "utf8").trimEnd().split("\n").at(-1);
    expect(fileLine?.endsWith("echo_test thread=C0123:100.001 token=sk-ant-***")).toBe(true);
  });

  test("a throwing printer never escapes log(), and the file line still lands first", () => {
    setLogEcho({
      printer: () => {
        throw new Error("boom");
      },
    });
    expect(() => log("echo_throw")).not.toThrow();
    setLogEcho({ printer: () => {} });
    const fileLine = readFileSync(paths.logFile, "utf8").trimEnd().split("\n").at(-1);
    expect(fileLine?.includes("echo_throw")).toBe(true);
  });

  test("an unwritable log file does not silence the echo", () => {
    const seen: { event: string; parts: string }[] = [];
    writeFileSync(paths.logFile, readFileSync(paths.logFile, "utf8"));
    chmodSync(paths.logFile, 0o400);
    setLogEcho({ printer: (entry) => seen.push(entry) });
    log("echo_readonly", { n: 1 });
    setLogEcho({ printer: () => {} });
    chmodSync(paths.logFile, 0o644);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.parts).toBe("n=1");
    expect(readFileSync(paths.logFile, "utf8").includes("echo_readonly")).toBe(false);
  });
});
