import { defineConfig } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(__dirname, "dist");

export default defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  retries: 0,
  use: {
    // Chrome extensions require a persistent context launched via the test
    // fixtures, so browser-level config is minimal here.
    headless: false, // Extensions cannot run in headless mode
    viewport: { width: 1280, height: 720 },
  },
  projects: [
    {
      name: "chromium-extension",
      use: {
        // These are passed through to our custom fixture
        launchOptions: {
          args: [
            `--disable-extensions-except=${extensionPath}`,
            `--load-extension=${extensionPath}`,
            "--no-first-run",
            "--disable-gpu",
            "--no-sandbox",
          ],
        },
      },
    },
  ],
});
