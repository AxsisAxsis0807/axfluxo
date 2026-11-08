import { isEntrypoint } from "../../runtime/lifecycle";
import { launchWorker } from "../runtime/main";
export { renderConfiguration } from "./config";
if (isEntrypoint(import.meta.url, ["render.mjs", "render/main.ts"]))
  launchWorker("render");
