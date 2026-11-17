import { generateKeyPair, SignJWT } from "jose";
import { expect, it, vi } from "vitest";
import { jwtVerifier } from "../../api/auth";
import { blompReadSigner } from "../../storage/blomp-signing";
import type { BlompRef } from "../../storage/blomp";
const owner = "11111111-1111-4111-8111-111111111111",
  other = "22222222-2222-4222-8222-222222222222";
const ref: BlompRef = {
  provider: "blomp",
  location: "test",
  key: "server-owned-key",
};
async function fixture() {
  const keys = await generateKeyPair("ES256");
  const now = new Date("2026-11-17T00:00:00Z");
  const token = async (patch: Record<string, unknown> = {}) =>
    "Bearer " +
    (await new SignJWT({
      sub: owner,
      role: "authenticated",
      iss: "https://issuer.invalid",
      aud: "authenticated",
      iat: now.getTime() / 1000,
      exp: now.getTime() / 1000 + 600,
      ...patch,
    })
      .setProtectedHeader({ alg: "ES256" })
      .sign(keys.privateKey));
  const verify = jwtVerifier(async () => keys.publicKey, {
    issuer: "https://issuer.invalid",
    audience: "authenticated",
    now: () => now,
  });
  const catalog = vi.fn(async () => ({
    owner,
    ref,
    size: 5 * 1024 ** 3,
    verified: true,
    readable: true,
  }));
  const sign = vi.fn(async () => ({
    url: "https://dummy.invalid/signed",
    expiresAt: now.getTime() + 60000,
  }));
  const signer = blompReadSigner({
    verify,
    catalog,
    storage: { sign },
    enabled: () => true,
    now: () => now.getTime(),
  });
  return { signer, catalog, sign, token };
}
it("uses verified JWT owner and catalog reference only; repeated reads are bounded", async () => {
  const { signer, catalog, sign, token } = await fixture();
  const authorization = await token();
  for (let i = 0; i < 10; i++) await signer(authorization, { fileId: other });
  await expect(signer(authorization, { fileId: other })).rejects.toMatchObject({
    status: 429,
  });
  expect(catalog).toHaveBeenCalledWith(owner, other);
  expect(sign).toHaveBeenCalledWith(ref, "GET");
});
it.each([
  { ownerId: other },
  { key: "arbitrary" },
  { bucket: "arbitrary" },
  { url: "https://127.0.0.1" },
  { operation: "PUT" },
])("rejects untrusted request properties %s", async (extra) => {
  const { signer, sign, token } = await fixture();
  await expect(
    signer(await token(), { fileId: other, ...extra }),
  ).rejects.toThrow();
  expect(sign).not.toHaveBeenCalled();
});
it.each([
  { iss: "https://evil.invalid" },
  { aud: "other" },
  { exp: 1 },
  { sub: "forged" },
  { role: "anon" },
])("rejects token claims %s", async (patch) => {
  const { signer, sign, token } = await fixture();
  await expect(signer(await token(patch), { fileId: other })).rejects.toThrow();
  expect(sign).not.toHaveBeenCalled();
});
it("rejects unsigned owner substitution and tampered JWT", async () => {
  const { signer, sign, token } = await fixture();
  const auth = await token();
  const pieces = auth.split(".");
  pieces[1] = Buffer.from(JSON.stringify({ sub: other })).toString("base64url");
  await expect(signer(pieces.join("."), { fileId: other })).rejects.toThrow();
  expect(sign).not.toHaveBeenCalled();
});
it("refuses other owner, unverified content and revoked access", async () => {
  const { signer, catalog, sign, token } = await fixture();
  catalog.mockResolvedValueOnce({
    owner: other,
    ref,
    size: 1,
    verified: true,
    readable: true,
  });
  await expect(signer(await token(), { fileId: other })).rejects.toThrow(
    "FILE_ACCESS_DENIED",
  );
  catalog.mockResolvedValueOnce({
    owner,
    ref,
    size: 1,
    verified: false,
    readable: true,
  });
  await expect(signer(await token(), { fileId: other })).rejects.toThrow(
    "FILE_ACCESS_DENIED",
  );
  expect(sign).not.toHaveBeenCalled();
  catalog
    .mockResolvedValueOnce({
      owner,
      ref,
      size: 1,
      verified: true,
      readable: true,
    })
    .mockResolvedValueOnce({
      owner,
      ref,
      size: 1,
      verified: true,
      readable: false,
    });
  await expect(signer(await token(), { fileId: other })).rejects.toThrow(
    "FILE_ACCESS_DENIED",
  );
});
it("rejects auth expiry during recovery before any signing", async () => {
  const { signer, sign, token } = await fixture();
  await expect(
    signer(await token({ exp: 1 }), { fileId: other }),
  ).rejects.toMatchObject({ status: 401 });
  expect(sign).not.toHaveBeenCalled();
});
it("discards a freshly generated URL if JWT validation expires before response", async () => {
  const verify = vi
    .fn()
    .mockResolvedValueOnce({ ownerId: owner })
    .mockRejectedValueOnce(Error("AUTH_EXPIRED"));
  const catalog = async () => ({
    owner,
    ref,
    size: 1,
    readable: true,
    verified: true,
  });
  const sign = vi.fn(async () => ({
    url: "https://dummy.invalid",
    expiresAt: Date.now() + 60000,
  }));
  const signer = blompReadSigner({
    verify,
    catalog,
    storage: { sign },
    enabled: () => true,
  });
  await expect(signer("Bearer dummy", { fileId: other })).rejects.toThrow(
    "AUTH_EXPIRED",
  );
  expect(sign).toHaveBeenCalledOnce();
});
