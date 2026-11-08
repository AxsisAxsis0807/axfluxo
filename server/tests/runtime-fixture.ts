// Isolated subprocess fixture: never connects to any database/service.
import { runService } from "../runtime/lifecycle";
import { runWorker } from "../worker/runtime/service";
import { spawnMedia } from "../worker/runtime/process";
void runService(
  async (signal) => {
    const task = async () => {
      const child = spawnMedia(
        process.execPath,
        [
          "-e",
          'process.on("SIGTERM",()=>{}); console.log("child-ready"); setInterval(()=>{},1000)',
        ],
        { stdio: ["ignore", "pipe", "pipe"], signal },
      );
      child.stdout!.on("data", (b) => process.stdout.write(b));
      await new Promise<void>((resolve) =>
        child.once("close", () => {
          process.stdout.write("child-closed\n");
          resolve();
        }),
      );
    };
    const loop = runWorker(
      [
        { name: "render", enabled: () => true, run: task },
        {
          name: "next-claim",
          enabled: () => true,
          run: async () => {
            process.stdout.write("unexpected-claim\n");
          },
        },
      ],
      signal,
    );
    return async () => {
      await loop;
      process.stdout.write("pool-closed\n");
    };
  },
  { VIDEO_SHUTDOWN_MS: "5000" },
);
