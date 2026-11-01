import { createRoot } from "react-dom/client";
import { AllVersionsEditor } from "../../../src/features/all-versions/AllVersionsEditor";
import { createVideoApiClient } from "../../../src/services/video/api-client";
const api = createVideoApiClient({
  baseUrl: "https://av-api.test",
  session: {
    getSession: async () => ({
      data: {
        session: {
          access_token: "test-token",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        },
      },
      error: null,
    }),
    refreshSession: async () => ({
      data: { session: null },
      error: new Error("expired"),
    }),
  },
});
createRoot(document.getElementById("root")!).render(
  <AllVersionsEditor api={api} />,
);
