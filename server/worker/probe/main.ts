import { isEntrypoint } from "../../runtime/lifecycle";
import { launchWorker } from "../runtime/main";
if (isEntrypoint(import.meta.url, ["probe.mjs", "probe/main.ts"]))
  launchWorker("probe");
