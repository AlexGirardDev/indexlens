/**
 * Playwright test fixtures for Chrome extension E2E testing.
 *
 * Provides a persistent BrowserContext with the extension loaded from dist/,
 * and helpers to locate the extension page and service worker.
 */

import { test as base, chromium, type BrowserContext, type Page } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(__dirname, "..", "dist");

export const test = base.extend<{
  context: BrowserContext;
  extensionId: string;
  extensionPage: Page;
}>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext("", {
      headless: false,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        "--no-first-run",
        "--disable-gpu",
        "--no-sandbox",
      ],
    });
    await use(context);
    await context.close();
  },

  extensionId: async ({ context }, use) => {
    // Wait for the service worker to register
    let serviceWorker = context.serviceWorkers()[0];
    if (!serviceWorker) {
      serviceWorker = await context.waitForEvent("serviceworker");
    }
    const extensionId = serviceWorker.url().split("/")[2];
    await use(extensionId);
  },

  extensionPage: async ({ context, extensionId }, use) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/index.html`);
    await use(page);
  },
});

export const expect = test.expect;
