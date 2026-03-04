#!/usr/bin/env npx tsx

/**
 * Automated screenshot capture for README documentation.
 *
 * Prerequisites:
 *   1. npm run build          (build the extension)
 *   2. docker compose up -d   (start ES clusters)
 *   3. node scripts/seed-clusters.mjs  (populate data)
 *   4. npx playwright install chromium
 *
 * Usage:
 *   npx tsx scripts/take-screenshots.mts
 */

import { chromium } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(__dirname, "..", "dist");
const screenshotDir = path.resolve(__dirname, "..", "docs", "screenshots");

const PASSPHRASE = "screenshot-passphrase-2025";

// Cluster configs — must match docker-compose.yml.
// Production is added first so the richer dataset appears in screenshots.
const CLUSTERS = [
  { name: "Production", url: "http://localhost:9200", colorIndex: 3 },  // green
  { name: "Staging", url: "http://localhost:9201", colorIndex: 5 },    // blue
];

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log("Launching browser with extension...");

  const context = await chromium.launchPersistentContext("", {
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      "--no-first-run",
      "--disable-gpu",
      "--no-sandbox",
    ],
  });

  // Find the extension ID from the service worker
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker");
  const extensionId = sw.url().split("/")[2];
  console.log(`Extension ID: ${extensionId}`);

  const page = await context.newPage();
  const extUrl = `chrome-extension://${extensionId}/index.html`;
  await page.goto(extUrl, { waitUntil: "load" });

  // ── Setup screen screenshot ───────────────────────────────────────────────
  console.log("📸 Setup screen...");
  await page.getByText("Welcome to IndexLens").waitFor({ timeout: 30_000 });
  await sleep(500);
  await page.screenshot({
    path: path.join(screenshotDir, "setup-screen.png"),
  });

  // Complete setup
  await page.getByLabel("Passphrase", { exact: true }).fill(PASSPHRASE);
  await page.getByLabel("Confirm passphrase").fill(PASSPHRASE);
  await page.getByRole("button", { name: /create passphrase/i }).click();
  await page.getByRole("button", { name: "Lock" }).waitFor({ timeout: 15_000 });

  // ── Lock screen screenshot ────────────────────────────────────────────────
  console.log("📸 Lock screen...");
  await page.keyboard.press("Control+l");
  await page.getByText("IndexLens is locked").waitFor({ timeout: 10_000 });
  await sleep(500);
  await page.screenshot({
    path: path.join(screenshotDir, "lock-screen.png"),
  });

  // Unlock
  await page.getByLabel("Passphrase").fill(PASSPHRASE);
  await page.getByRole("button", { name: /unlock/i }).click();
  await page.getByRole("button", { name: "Lock" }).waitFor({ timeout: 15_000 });

  // ── Add clusters ──────────────────────────────────────────────────────────
  for (let i = 0; i < CLUSTERS.length; i++) {
    const cluster = CLUSTERS[i];
    console.log(`  Adding cluster: ${cluster.name}...`);

    // After first cluster is added, the dropdown trigger shows that cluster's name
    const clusterDropdown =
      i === 0
        ? page.getByRole("button", { name: /clusters/i })
        : page.locator("header").getByRole("button").first();

    await clusterDropdown.click();
    await page.getByRole("menuitem", { name: /add cluster/i }).click();

    await page.locator("#cluster-name").fill(cluster.name);
    await page.locator("#cluster-url").fill(cluster.url);

    const colorButtons = page.locator('button[aria-label^="Select color"]');
    await colorButtons.nth(cluster.colorIndex).click();

    await page.getByRole("button", { name: /add cluster/i }).click();
    await sleep(1500);
  }

  // Switch back to Production cluster (Staging was added last, so it's active)
  console.log("  Switching to Production cluster...");
  await page.locator("header").getByRole("button").first().click();
  await page.getByRole("menuitem", { name: "Production" }).click();
  await sleep(2000);

  // ── Dashboard screenshot ──────────────────────────────────────────────────
  console.log("📸 Dashboard...");
  await page.getByRole("button", { name: "Dashboard" }).click();
  await sleep(2000);
  await page.screenshot({
    path: path.join(screenshotDir, "dashboard.png"),
  });

  // ── Indices page screenshot ───────────────────────────────────────────────
  console.log("📸 Indices...");
  await page.getByRole("button", { name: "Indices" }).click();
  await sleep(2000);
  await page.screenshot({
    path: path.join(screenshotDir, "indices.png"),
  });

  // ── Documents page screenshot ─────────────────────────────────────────────
  console.log("📸 Documents...");
  // Click on the "products" index link in the table
  await page.locator("button", { hasText: "products" }).first().click();
  await sleep(2000);

  // Type a partial field name in the query editor to show field autocomplete.
  // The query editor is the first .cm-editor on the documents page.
  const queryEditor = page.locator(".cm-editor").first();
  await queryEditor.click();
  await sleep(300);
  await page.keyboard.type("pr", { delay: 80 });
  await sleep(800);

  await page.screenshot({
    path: path.join(screenshotDir, "documents.png"),
  });

  // Dismiss autocomplete
  await page.keyboard.press("Escape");
  await sleep(200);

  // ── REST console screenshot ───────────────────────────────────────────────
  console.log("📸 REST console...");
  await page.getByRole("button", { name: "Rest" }).click();
  await sleep(1000);

  // 1. Select POST method
  await page.getByRole("combobox").click();
  await sleep(200);
  await page.getByRole("option", { name: "POST" }).click();
  await sleep(300);

  // 2. Type the endpoint
  const endpointEditor = page.locator(".cm-editor").first();
  await endpointEditor.click();
  await page.keyboard.type("products/_search", { delay: 30 });
  await page.keyboard.press("Escape"); // dismiss autocomplete
  await sleep(300);

  // 3. Send a match_all first to populate the response panel with real data
  await page.getByRole("button", { name: "Send" }).click();
  await sleep(2000);

  // 4. Build a query through the autocomplete cascade to reach field-level suggestions.
  //    The body editor starts with "{\n  \n}".
  const bodyEditor = page.locator(".cm-editor").nth(1);
  await bodyEditor.click();
  await sleep(200);
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Backspace");
  await sleep(200);

  // Build query structure via autocomplete cascade.
  // selectOnOpen:false means we need ArrowDown to focus an item before Tab accepts.

  // Type { → autocomplete shows DSL keywords. Filter to "query".
  await page.keyboard.type("{", { delay: 50 });
  await sleep(400);
  await page.keyboard.type("que", { delay: 60 });
  await sleep(400);
  await page.keyboard.press("ArrowDown"); // focus "query"
  await sleep(100);
  await page.keyboard.press("Tab");       // accept → "query": { | }
  await sleep(600);

  // Inside "query", autocomplete cascades → query types. Filter to "match".
  await page.keyboard.type("mat", { delay: 60 });
  await sleep(400);
  await page.keyboard.press("ArrowDown"); // focus "match"
  await sleep(100);
  await page.keyboard.press("Tab");       // accept → "match": { | }
  await sleep(600);

  // Inside "match", autocomplete should show field names from the index mapping.
  // Type "ca" to filter to "category", showing field-level awareness.
  await page.keyboard.type("ca", { delay: 80 });
  await sleep(800);

  // Scroll to top so the navbar is visible in the screenshot
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(200);

  await page.screenshot({
    path: path.join(screenshotDir, "rest-console.png"),
  });

  // Dismiss autocomplete for clean state
  await page.keyboard.press("Escape");
  await sleep(200);

  // ── Scout search screenshot ──────────────────────────────────────────────
  console.log("📸 Scout search...");
  // Move focus out of CodeMirror before opening Scout
  await page.getByRole("button", { name: "Dashboard" }).click();
  await sleep(500);
  await page.keyboard.press("Control+Space");
  await sleep(800);
  await page.screenshot({
    path: path.join(screenshotDir, "scout-search.png"),
  });
  await page.keyboard.press("Escape");

  // ── Done ──────────────────────────────────────────────────────────────────
  console.log("\n✅ All screenshots saved to docs/screenshots/");
  await context.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
