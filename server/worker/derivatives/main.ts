import { isEntrypoint } from "../../runtime/lifecycle";
import { launchWorker } from "../runtime/main";
if (isEntrypoint(import.meta.url, ["derivatives.mjs", "derivatives/main.ts"]))
  launchWorker("derivatives");
