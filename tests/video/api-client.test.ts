import { describe, expect, it, vi } from "vitest";
import {
  createVideoApiClient,
  batchState,
  videoStateMessage,
  type VideoSessionSource,
} from "../../src/services/video/api-client";
import type { BatchView } from "../../server/contracts/video";
const id = "11111111-1111-4111-8111-111111111111",
  now = 1_800_000_000_000;
const fresh = { access_token: "fresh-token", expires_at: now / 1000 + 3600 };
const stale = {
  access_token: "stale-secret-token",
  expires_at: now / 1000 - 1,
};
const source = (session: typeof fresh | null = fresh): VideoSessionSource => ({
  getSession: async () => ({ data: { session }, error: null }),
  refreshSession: async () => ({ data: { session: fresh }, error: null }),
});
const batch = (state: BatchView["jobs"][number]["state"]): BatchView => ({
  id,
  ownerId: id,
  jobs: [{ id, state, rangeIndex: 0, attempt: 1, retryOf: null }],
  outputs: [],
});
describe("video browser session client", () => {
  it("returns a safe expiry state on refresh rejection without sending stale tokens", async () => {
    const session = source(stale),
      transport = vi.fn();
    session.refreshSession = async () => {
      throw new Error("refresh secret https://signed.example?token=private");
    };
    const client = createVideoApiClient({
      baseUrl: "https://api.example",
      session,
      fetch: transport,
      now: () => now,
    });
    const result = await client.me();
    expect(result).toEqual({
      ok: false,
      state: "auth-expired",
      code: "AUTH_EXPIRED",
    });
    expect(transport).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/secret|signed|private/);
    expect(videoStateMessage[result.state]).toContain(
      "端末内の編集データは保持",
    );
  });
  it("handles SDK refresh error results without clearing the session or forwarding raw details", async () => {
    const session = source(stale),
      transport = vi.fn();
    session.refreshSession = async () => ({
      data: { session: null },
      error: { message: "secret invalid refresh token" },
    });
    const client = createVideoApiClient({
      baseUrl: "https://api.example",
      session,
      fetch: transport,
      now: () => now,
    });
    expect(await client.me()).toEqual({
      ok: false,
      state: "auth-expired",
      code: "AUTH_EXPIRED",
    });
    expect(transport).not.toHaveBeenCalled();
    expect((await session.getSession()).data.session).toEqual(stale);
  });
  it("distinguishes signed-out, forbidden, held and failure", async () => {
    expect(
      (
        await createVideoApiClient({
          baseUrl: "https://api.example",
          session: source(null),
          now: () => now,
        }).me()
      ).state,
    ).toBe("unauthenticated");
    for (const [status, state] of [
      [403, "forbidden"],
      [503, "held"],
      [500, "failed"],
    ] as const) {
      const transport = vi.fn<typeof fetch>(
        async () => new Response("secret", { status }),
      );
      const result = await createVideoApiClient({
        baseUrl: "https://api.example",
        session: source(),
        fetch: transport,
        now: () => now,
      }).me();
      expect(result.state).toBe(state);
      expect(JSON.stringify(result)).not.toContain("secret");
    }
  });
  it("coalesces refresh and retries 401 once with the exact same body/key", async () => {
    let current = fresh;
    const session = source();
    session.getSession = async () => ({
      data: { session: current },
      error: null,
    });
    session.refreshSession = vi.fn(async () => {
      current = { ...fresh, access_token: "renewed-token" };
      return { data: { session: current }, error: null };
    });
    const requests: RequestInit[] = [];
    const transport = vi.fn<typeof fetch>(async (_url, init) => {
      requests.push(init!);
      return new Response(
        requests.length === 1
          ? ""
          : JSON.stringify({ batchId: id, job: batch("queued").jobs[0] }),
        { status: requests.length === 1 ? 401 : 202 },
      );
    });
    const client = createVideoApiClient({
      baseUrl: "https://api.example",
      session,
      fetch: transport,
      now: () => now,
    });
    expect((await client.retry(id, "stable-key")).ok).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[0].body).toBe(requests[1].body);
    expect(new Headers(requests[0].headers).get("idempotency-key")).toBe(
      new Headers(requests[1].headers).get("idempotency-key"),
    );
    expect(new Headers(requests[1].headers).get("authorization")).toBe(
      "Bearer renewed-token",
    );
    expect(requests[1]).toMatchObject({
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
    });
  });
  it("shares a refresh across concurrent requests and stops on repeated 401", async () => {
    const session = source(stale);
    session.refreshSession = vi.fn(async () => {
      await Promise.resolve();
      return { data: { session: fresh }, error: null };
    });
    const transport = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ ownerId: id, membership: "developer" }), {
          status: 200,
        }),
    );
    const client = createVideoApiClient({
      baseUrl: "https://api.example",
      session,
      fetch: transport,
      now: () => now,
    });
    const results = await Promise.all([client.me(), client.me()]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(session.refreshSession).toHaveBeenCalledTimes(1);
    const repeated = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 401 }),
    );
    const denied = await createVideoApiClient({
      baseUrl: "https://api.example",
      session: source(),
      fetch: repeated,
      now: () => now,
    }).me();
    expect(denied.state).toBe("auth-expired");
    expect(repeated).toHaveBeenCalledTimes(2);
  });
  it("maps waiting/held/failed and selects the latest retry for each range", () => {
    expect(batchState(batch("queued"))).toBe("waiting");
    expect(batchState(batch("held"))).toBe("held");
    expect(batchState(batch("failed"))).toBe("failed");
    const retried = batch("failed");
    retried.jobs.push({ ...retried.jobs[0], attempt: 2, state: "queued" });
    expect(batchState(retried)).toBe("waiting");
  });
});
