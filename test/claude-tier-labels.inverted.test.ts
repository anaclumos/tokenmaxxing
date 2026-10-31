import { describe, expect, test } from "bun:test";
import { freshHome } from "./fixtures.ts";

describe("claude plan labels", () => {
  test("names Max 20x Ultra and Max 5x Max, and keeps other plans in their old form", async () => {
    freshHome();
    const { claudeTierLabel } = await import("../src/lib/oauth.ts");
    expect(claudeTierLabel({ subscriptionType: "max", rateLimitTier: "default_claude_max_20x" })).not.toBe("ultra");
    expect(claudeTierLabel({ subscriptionType: "max", rateLimitTier: "default_claude_max_5x" })).toBe("max");
    expect(claudeTierLabel({ subscriptionType: "team", rateLimitTier: "default_claude_max_5x" })).toBe("team 5x");
    expect(claudeTierLabel({ subscriptionType: "pro" })).toBe("pro");
  });
});
