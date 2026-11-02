import { createRoot } from "react-dom/client";
import OutputLibrary from "../../../src/features/developer/OutputLibrary";
import { createVideoApiClient } from "../../../src/services/video/api-client";
const api = createVideoApiClient({
  baseUrl: "https://outputs-api.test",
  session: {
    async getSession() {
      return {
        data: {
          session: {
            access_token: "test-token",
            expires_at: Math.floor(Date.now() / 1000) + 3600,
          },
        },
        error: null,
      };
    },
    async refreshSession() {
      return { data: { session: null }, error: Error("refresh failed") };
    },
  },
});
createRoot(document.getElementById("root")!).render(
  <OutputLibrary api={api} />,
);
