// log(): the append-only file line and the serve daemon's terminal echo tee.

import { describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { log, setLogEcho } from "../src/lib/log.ts";
import { formatLogLine } from "../src/cli/serve.ts";
import { paths } from "../src/lib/paths.ts";

describe("setLogEcho", () => {
  test("tees each event to the printer with the same redacted parts as the file line", () => {
    const seen: { event: string; parts: string }[] = [];
    setLogEcho({ printer: (entry) => seen.push(entry) });
    log("serve.echo_test", { thread: "slack:C0123:100.001", token: "sk-ant-oat01-abcdef" });
    setLogEcho({ printer: () => {} });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.event).toBe("serve.echo_test");
    expect(seen[0]?.parts).toBe("thread=slack:C0123:100.001 token=sk-ant-***");
    const fileLine = readFileSync(paths.logFile, "utf8").trimEnd().split("\n").at(-1);
    expect(fileLine?.endsWith("serve.echo_test thread=slack:C0123:100.001 token=sk-ant-***")).toBe(true);
  });

  test("a throwing printer never escapes log(), and the file line still lands first", () => {
    setLogEcho({
      printer: () => {
        throw new Error("boom");
      },
    });
    expect(() => log("serve.echo_throw")).not.toThrow();
    setLogEcho({ printer: () => {} });
    const fileLine = readFileSync(paths.logFile, "utf8").trimEnd().split("\n").at(-1);
    expect(fileLine?.includes("serve.echo_throw")).toBe(true);
  });

  test("an unwritable log file does not silence the echo", () => {
    const seen: { event: string; parts: string }[] = [];
    writeFileSync(paths.logFile, readFileSync(paths.logFile, "utf8"));
    chmodSync(paths.logFile, 0o400);
    setLogEcho({ printer: (entry) => seen.push(entry) });
    log("serve.echo_readonly", { n: 1 });
    setLogEcho({ printer: () => {} });
    chmodSync(paths.logFile, 0o644);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.parts).toBe("n=1");
    expect(readFileSync(paths.logFile, "utf8").includes("serve.echo_readonly")).toBe(false);
  });
});

describe("formatLogLine", () => {
  test("renders HH:MM:SS, the event, and the parts on one line", () => {
    const line = formatLogLine({ event: "serve.message", parts: "thread=slack:C1:2 isMention=true" });
    const [time, event, ...rest] = line.split(" ");
    expect(event).toBe("serve.message");
    expect(rest.join(" ")).toBe("thread=slack:C1:2 isMention=true");
    const segments = (time ?? "").split(":");
    expect(segments).toHaveLength(3);
    for (const segment of segments) {
      expect(segment).toHaveLength(2);
      expect(Number.isInteger(Number(segment))).toBe(true);
    }
  });

  test("a field-less event has no trailing space", () => {
    const line = formatLogLine({ event: "serve.started", parts: "" });
    expect(line.endsWith(" serve.started")).toBe(true);
  });

  test("multi-line field values stay on one terminal line", () => {
    const line = formatLogLine({ event: "usage.probe_failed", parts: "stderr=first\nsecond\rthird" });
    expect(line.split("\n")).toHaveLength(1);
    expect(line.endsWith("stderr=first\\nsecond\\rthird")).toBe(true);
  });
});
