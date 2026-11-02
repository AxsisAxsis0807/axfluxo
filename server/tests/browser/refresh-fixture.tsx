import { createRoot } from "react-dom/client";
import DeveloperVideoPanel from "../../../src/features/video/DeveloperVideoPanel";
import { DeveloperVideoStatus } from "../../../src/features/video/DeveloperVideoStatus";
import {
  createVideoApiClient,
  type VideoSessionSource,
} from "../../../src/services/video/api-client";
const root = createRoot(document.getElementById("root")!);
const run = async (
  mode: "expired" | "forbidden" | "held" | "waiting" | "failed",
) => {
  const session: VideoSessionSource = {
    getSession: async () => ({
      data: {
        session: {
          access_token: "secret-access-token",
          expires_at: mode === "expired" ? 1 : Date.now() / 1000 + 3600,
        },
      },
      error: null,
    }),
    refreshSession: async () => {
      throw new Error("refresh-secret https://signed.example?token=secret");
    },
  };
  const id = "11111111-1111-4111-8111-111111111111";
  const transport: typeof fetch = async () => {
    if (mode === "expired") throw new Error("expired token must never be sent");
    return new Response(
      mode === "waiting"
        ? JSON.stringify({
            id,
            ownerId: id,
            jobs: [
              { id, state: "queued", rangeIndex: 0, attempt: 1, retryOf: null },
            ],
            outputs: [],
          })
        : "private backend detail",
      {
        status:
          mode === "waiting"
            ? 200
            : mode === "forbidden"
              ? 403
              : mode === "held"
                ? 503
                : 500,
      },
    );
  };
  const client = createVideoApiClient({
    baseUrl: "https://api.example",
    session,
    fetch: transport,
  });
  if (mode === "expired") {
    root.render(<DeveloperVideoPanel client={client} />);
    return;
  }
  const result = await client.getBatch(id);
  root.render(<DeveloperVideoStatus state={result.state} />);
};
Object.assign(window, { runVideoFixture: run });
