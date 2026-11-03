import { defineConfig } from "@playwright/test";
import existing from "./playwright.config";
export default defineConfig({
  ...existing,
  testDir: "tests/developer-published",
  outputDir: "test-results/developer-access",
});
