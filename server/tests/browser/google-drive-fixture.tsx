import { createRoot } from "react-dom/client";
import GoogleDrivePanel from "../../../src/features/video/GoogleDrivePanel";
import { createVideoApiClient } from "../../../src/services/video/api-client";
const session = {
  getSession: async () => ({
    data: {
      session: { access_token: "supabase-test-token", expires_at: 9999999999 },
    },
    error: null,
  }),
  refreshSession: async () => ({ data: { session: null }, error: null }),
};
createRoot(document.getElementById("root")!).render(
  <GoogleDrivePanel
    client={createVideoApiClient({
      baseUrl: "https://drive-api.test",
      session,
    })}
  />,
);
