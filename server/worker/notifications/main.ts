import { isEntrypoint } from "../../runtime/lifecycle";
import { launchWorker } from "../runtime/main";
if (
  isEntrypoint(import.meta.url, ["notifications.mjs", "notifications/main.ts"])
)
  launchWorker("notifications");
