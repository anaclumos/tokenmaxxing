import { describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import { join } from "node:path"

import { sessionHash, projectFromCwd } from "./utils"

describe("sessionHash", () => {
  test("returns 64-char hex string", () => {
    const hash = sessionHash("claude-code", "session-123")
    expect(hash).toHaveLength(64)
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
  })

  test("is deterministic", () => {
    const a = sessionHash("codex", "abc")
    const b = sessionHash("codex", "abc")
    expect(a).toBe(b)
  })

  test("differs by client", () => {
    const a = sessionHash("claude-code", "same-id")
    const b = sessionHash("codex", "same-id")
    expect(a).not.toBe(b)
  })
})

describe("projectFromCwd", () => {
  const home = homedir()

  test("strips homedir and Developer prefix", () => {
    expect(projectFromCwd(join(home, "Developer", "my-app"))).toBe("my-app")
  })

  test("strips Projects prefix", () => {
    expect(projectFromCwd(join(home, "Projects", "foo", "bar"))).toBe("foo/bar")
  })

  test("strips code prefix", () => {
    expect(projectFromCwd(join(home, "code", "org", "repo"))).toBe("org/repo")
  })

  test("preserves nested paths after prefix", () => {
    expect(projectFromCwd(join(home, "Developer", "org", "mono", "packages", "api"))).toBe("org/mono/packages/api")
  })

  test("handles paths without common prefix", () => {
    expect(projectFromCwd(join(home, "workspace", "project"))).toBe("workspace/project")
  })

  test("handles absolute paths outside homedir", () => {
    expect(projectFromCwd("/tmp/builds/my-project")).toBe("tmp/builds/my-project")
  })
})
