import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";
export default defineConfig({
  testDir: "tests/browser",
  testMatch: "**/*.spec.ts",
  workers: 1,
  timeout: 30000,
  outputDir: "../test-results/video-browser",
  use: { headless: true, trace: "retain-on-failure" },
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        launchOptions: {
          executablePath:
            process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
            (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
          args: ["--no-sandbox", "--disable-dev-shm-usage"],
        },
      },
    },
    { name: "webkit", use: { ...devices["iPhone 13"], browserName: "webkit" } },
  ],
});
