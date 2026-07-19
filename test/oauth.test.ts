import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { refreshCredential, InvalidGrantError, isAccessTokenExpiring } from "../src/lib/oauth.ts";
import type { OAuthCreds } from "../src/lib/types.ts";

let server: ReturnType<typeof Bun.serve>;
let lastBody: any = null;

beforeAll(() => {
  server = Bun.serve({
    port: 8791,
    hostname: "127.0.0.1",
    async fetch(req) {
      lastBody = await req.json();
      if (lastBody.refresh_token === "DEAD") {
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      }
      if (lastBody.refresh_token === "BOOM") {
        return new Response("upstream exploded", { status: 500 });
      }
      if (lastBody.refresh_token === "OMIT") {
        // rotation omitted: the schema allows it, and the client must keep
        // the previous refresh token instead of persisting undefined.
        return Response.json({
          access_token: "fresh-access-OMIT",
          expires_in: 3600,
          scope: "user:inference user:profile",
          token_type: "Bearer",
        });
      }
      return Response.json({
        access_token: "fresh-access-" + lastBody.refresh_token,
        refresh_token: "rotated-" + lastBody.refresh_token,
        expires_in: 3600,
        refresh_token_expires_in: 7776000,
        scope: "user:inference user:profile",
        token_type: "Bearer",
      });
    },
  });
});
afterAll(() => server.stop(true));

const base: OAuthCreds = {
  accessToken: "old",
  refreshToken: "rt-123",
  expiresAt: 0,
  scopes: ["user:inference", "user:profile"],
  subscriptionType: "max",
  rateLimitTier: "tier",
};

describe("oauth refresh grant", () => {
  test("refreshes, rotates token, recomputes expiry, preserves extras", async () => {
    const now = 1_000_000_000_000;
    const out = await refreshCredential(base, now);
    expect(out.accessToken).toBe("fresh-access-rt-123");
    expect(out.refreshToken).toBe("rotated-rt-123");
    expect(out.expiresAt).toBe(now + 3600 * 1000);
    expect(out.refreshTokenExpiresAt).toBe(now + 7776000 * 1000);
    expect(out.subscriptionType).toBe("max"); // preserved
    expect(out.rateLimitTier).toBe("tier");
    // request shape
    expect(lastBody.grant_type).toBe("refresh_token");
    expect(lastBody.client_id).toBeTruthy();
    expect(lastBody.scope).toBe("user:inference user:profile");
  });

  test("reuses previous refresh token when server omits it", async () => {
    // the OMIT sentinel makes the mock answer WITHOUT refresh_token: the old
    // version of this test always got a rotation back, so the fallback at
    // oauth.ts had zero coverage despite a test named for it (closing-review
    // catch) - losing the fallback persists refreshToken: undefined over the
    // account's parked backup and destroys its only grant.
    const creds = { ...base, refreshToken: "OMIT" };
    const out = await refreshCredential(creds, 0);
    expect(out.accessToken).toBe("fresh-access-OMIT");
    expect(out.refreshToken).toBe("OMIT");
  });

  test("invalid_grant throws InvalidGrantError", async () => {
    await expect(refreshCredential({ ...base, refreshToken: "DEAD" }, 0)).rejects.toBeInstanceOf(InvalidGrantError);
  });

  test("HTTP 500 throws a generic error (not InvalidGrant)", async () => {
    const p = refreshCredential({ ...base, refreshToken: "BOOM" }, 0);
    await expect(p).rejects.toThrow(/HTTP 500/);
    await expect(p).rejects.not.toBeInstanceOf(InvalidGrantError);
  });

  test("isAccessTokenExpiring", () => {
    const now = 1000;
    expect(isAccessTokenExpiring({ ...base, expiresAt: now + 60_000 }, 120_000, now)).toBe(true);
    expect(isAccessTokenExpiring({ ...base, expiresAt: now + 600_000 }, 120_000, now)).toBe(false);
  });
});
