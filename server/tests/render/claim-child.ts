// Native-loopback fault injection only. Never a deployed worker entry point.
import { postgresDatabase } from "../../db/postgres";
import { claim } from "../../worker/jobs/queue";
const url = new URL(process.env.AXFLUXO_TEST_POSTGRES_URL!);
if (
  !["127.0.0.1", "localhost"].includes(url.hostname) ||
  !url.pathname.startsWith("/axfluxo_video_test")
)
  throw new Error("test DB required");
const db = postgresDatabase(
  { connectionString: url.toString() },
  "axfluxo_video_render",
);
const c = await claim(db, () => 0);
process.stdout.write(
  JSON.stringify(c ? { job: c.job, token: c.token } : null) + "\n",
);
setInterval(() => undefined, 1000);
