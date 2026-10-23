import { describe, expect, it } from "vitest";
import { authClient, authError, publicAuthConfig } from "../src/services/auth";
describe("public auth configuration", () => {
  const key = "sb_publishable_test_public_key_1234567890";
  it("only accepts public publishable keys and HTTPS project URLs", () => {
    expect(publicAuthConfig("https://test.supabase.co", key)).toEqual({
      url: "https://test.supabase.co",
      key,
    });
    for (const invalid of [
      undefined,
      "sb_secret_abcdef",
      "service_role",
      "eyJhbGciOi...",
    ])
      expect(publicAuthConfig("https://test.supabase.co", invalid)).toBeNull();
    for (const url of [
      "http://test.supabase.co",
      "https://test.supabase.co.evil.com",
      "https://user:pass@test.supabase.co",
      "https://test.supabase.co/path",
      "broken",
    ])
      expect(publicAuthConfig(url, key)).toBeNull();
  });
  it("does not initialize sessions during SSR", () =>
    expect(authClient()).toBeNull());
  it("maps confirmation and rate limits to actionable Japanese errors", () => {
    expect(authError("email_not_confirmed")).toContain("確認メール");
    expect(authError("over_email_send_rate_limit")).toContain("上限");
    expect(authError("unknown")).not.toContain("unknown");
  });
});
