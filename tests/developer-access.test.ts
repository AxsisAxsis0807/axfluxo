import { beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ getSession: vi.fn(), rpc: vi.fn() }));
vi.mock("../src/services/auth", () => ({
  authClient: () => ({ auth: { getSession: mock.getSession }, rpc: mock.rpc }),
}));
import { verifyDeveloperAccess } from "../src/services/developer/access";
const ownerId = "11111111-1111-4111-8111-111111111111";
beforeEach(() => {
  mock.getSession.mockResolvedValue({
    data: {
      session: {
        user: {
          id: ownerId,
          user_metadata: { role: "developer", is_developer: true },
        },
      },
    },
    error: null,
  });
  mock.rpc.mockResolvedValue({
    data: {
      ownerId,
      membership: "developer",
      validUntil: new Date(Date.now() + 60_000).toISOString(),
    },
    error: null,
  });
});
it("uses the authenticated server RPC without any video API configuration", async () => {
  expect((await verifyDeveloperAccess()).ownerId).toBe(ownerId);
  expect(mock.rpc).toHaveBeenCalledWith("axfluxo_developer_access");
});
it("does not trust metadata or malformed, mismatched or expired server responses", async () => {
  for (const data of [
    null,
    {},
    { ownerId, membership: "developer", validUntil: "2000-01-01T00:00:00Z" },
    {
      ownerId: "22222222-2222-4222-8222-222222222222",
      membership: "developer",
      validUntil: new Date(Date.now() + 60000).toISOString(),
    },
  ]) {
    mock.rpc.mockResolvedValue({ data, error: null });
    await expect(verifyDeveloperAccess()).rejects.toThrow(
      "開発者権限を確認できません",
    );
  }
});
it("fails closed on missing migration, RPC failure and anonymous sessions", async () => {
  mock.rpc.mockResolvedValue({ data: null, error: { code: "PGRST202" } });
  await expect(verifyDeveloperAccess()).rejects.toThrow("未設定");
  mock.rpc.mockRejectedValue(Error("network"));
  await expect(verifyDeveloperAccess()).rejects.toThrow();
  mock.getSession.mockResolvedValue({ data: { session: null }, error: null });
  mock.rpc.mockClear();
  await expect(verifyDeveloperAccess()).rejects.toThrow("ログイン");
  expect(mock.rpc).not.toHaveBeenCalled();
});
