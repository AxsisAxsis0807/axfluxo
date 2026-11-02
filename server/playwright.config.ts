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
        // Branded Chrome includes the proprietary H.264/AAC codecs required by MP4.
        // The bundled Chromium/CfT binary on CI is not a codec-equivalent substitute.
        channel: "chrome",
        launchOptions: {
          executablePath:
            process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
            [
              "/usr/bin/google-chrome",
              "/usr/bin/google-chrome-stable",
              "/usr/bin/chromium",
            ].find(existsSync),
          args: ["--no-sandbox", "--disable-dev-shm-usage"],
        },
      },
    },
    { name: "webkit", use: { ...devices["iPhone 13"], browserName: "webkit" } },
  ],
});
