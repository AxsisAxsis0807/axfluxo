import { createRoot } from "react-dom/client";
import CloudLibrary from "../../../src/features/developer/CloudLibrary";
import { createVideoApiClient } from "../../../src/services/video/api-client";
import { cloudClient } from "../../../src/services/cloud-library/client";
const owner = "11111111-1111-4111-8111-111111111111",
  id = "22222222-2222-4222-8222-222222222222";
const transport: typeof fetch = async (input, init) => {
  const url = new URL(String(input)),
    body = init?.body ? JSON.parse(String(init.body)) : {};
  let state = JSON.parse(sessionStorage.getItem("mock-cloud-state") ?? "null");
  if (url.pathname === "/v1/developer/me")
    return Response.json({ ownerId: owner, membership: "developer" });
  if (url.pathname === "/cloud/folders")
    return Response.json({ items: [], nextCursor: null });
  if (url.pathname === "/cloud/assets")
    return Response.json({ items: [], nextCursor: null });
  if (url.pathname === "/cloud/uploads") {
    state = {
      id,
      ownerId: owner,
      name: body.name,
      size: body.size,
      sha256: body.sha256,
      partSize: 16 * 1024 * 1024,
      partCount: 1,
      state: "uploading",
      parts: [],
      error: null,
      assetId: null,
      versionId: null,
    };
    sessionStorage.setItem("mock-cloud-state", JSON.stringify(state));
  }
  if (url.pathname.endsWith("/part")) {
    sessionStorage.setItem("mock-md5", body.md5);
    return Response.json({
      url: "https://storage.test/part",
      headers: {},
      expiresAt: Date.now() + 300000,
    });
  }
  if (url.pathname.endsWith("/complete")) {
    state.state = "verifying";
    sessionStorage.setItem("mock-cloud-state", JSON.stringify(state));
  }
  return Response.json(state);
};
window.fetch = async (_input, init) => {
  Object.assign(window, { storagePutStarted: true });
  if (sessionStorage.getItem("allow-upload"))
    return new Response(null, {
      headers: { etag: '"' + sessionStorage.getItem("mock-md5") + '"' },
    });
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener(
      "abort",
      () => reject(new DOMException("background pause", "AbortError")),
      { once: true },
    );
  });
};
const session = {
  getSession: async () => ({
    data: {
      session: {
        access_token: "private-test-token",
        expires_at: Date.now() / 1000 + 3600,
      },
    },
    error: null,
  }),
  refreshSession: async () => ({ data: { session: null }, error: null }),
};
createRoot(document.getElementById("root")!).render(
  <CloudLibrary
    client={cloudClient(
      createVideoApiClient({
        baseUrl: "https://api.test",
        session,
        fetch: transport,
      }),
    )}
  />,
);
