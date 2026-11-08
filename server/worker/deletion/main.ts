import { isEntrypoint } from "../../runtime/lifecycle";
import { launchWorker } from "../runtime/main";
if (isEntrypoint(import.meta.url, ["deletion.mjs", "deletion/main.ts"]))
  launchWorker("deletion");
