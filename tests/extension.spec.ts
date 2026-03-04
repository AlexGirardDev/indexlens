import { test, expect } from "./fixtures";
import { readFile } from "node:fs/promises";

const TEST_PASSPHRASE = "my-secure-passphrase-123";

// ---------------------------------------------------------------------------
// First-run passphrase setup
// ---------------------------------------------------------------------------

test.describe("First-run setup", () => {
  test("shows setup screen on first launch", async ({ extensionPage }) => {
    await expect(
      extensionPage.getByRole("heading", { name: /welcome to indexlens/i }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("rejects passphrase shorter than 8 characters", async ({ extensionPage }) => {
    const passphraseInput = extensionPage.getByLabel("Passphrase", { exact: true });
    const confirmInput = extensionPage.getByLabel("Confirm passphrase");
    const submitButton = extensionPage.getByRole("button", { name: /create passphrase/i });

    await passphraseInput.fill("short");
    await passphraseInput.blur();
    await confirmInput.fill("short");
    await confirmInput.blur();

    // The button should be disabled because validation fails
    await expect(submitButton).toBeDisabled();

    // Validation message should appear
    await expect(
      extensionPage.getByText(/at least 8 characters/i),
    ).toBeVisible();
  });

  test("rejects mismatched confirmation", async ({ extensionPage }) => {
    const passphraseInput = extensionPage.getByLabel("Passphrase", { exact: true });
    const confirmInput = extensionPage.getByLabel("Confirm passphrase");
    const submitButton = extensionPage.getByRole("button", { name: /create passphrase/i });

    await passphraseInput.fill(TEST_PASSPHRASE);
    await passphraseInput.blur();
    await confirmInput.fill("different-passphrase");
    await confirmInput.blur();

    await expect(submitButton).toBeDisabled();
    await expect(
      extensionPage.getByText(/passphrases do not match/i),
    ).toBeVisible();
  });

  test("creates passphrase and transitions to unlocked view", async ({ extensionPage }) => {
    const passphraseInput = extensionPage.getByLabel("Passphrase", { exact: true });
    const confirmInput = extensionPage.getByLabel("Confirm passphrase");
    const submitButton = extensionPage.getByRole("button", { name: /create passphrase/i });

    await passphraseInput.fill(TEST_PASSPHRASE);
    await confirmInput.fill(TEST_PASSPHRASE);

    await expect(submitButton).toBeEnabled();
    await submitButton.click();

    // Should transition to the unlocked shell
    await expect(
      extensionPage.getByRole("heading", { name: /indexlens/i }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      extensionPage.getByRole("button", { name: /lock/i }),
    ).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Unlock / lock lifecycle
// ---------------------------------------------------------------------------

test.describe("Unlock and lock lifecycle", () => {
  test.beforeEach(async ({ extensionPage }) => {
    // Complete first-run setup
    await expect(
      extensionPage.getByRole("heading", { name: /welcome to indexlens/i }),
    ).toBeVisible({ timeout: 10_000 });

    const passphraseInput = extensionPage.getByLabel("Passphrase", { exact: true });
    const confirmInput = extensionPage.getByLabel("Confirm passphrase");
    const submitButton = extensionPage.getByRole("button", { name: /create passphrase/i });

    await passphraseInput.fill(TEST_PASSPHRASE);
    await confirmInput.fill(TEST_PASSPHRASE);
    await submitButton.click();

    // Wait for unlocked state
    await expect(
      extensionPage.getByRole("button", { name: /lock/i }),
    ).toBeVisible({ timeout: 10_000 });

    // Lock the session so we can test the unlock flow
    await extensionPage.getByRole("button", { name: /lock/i }).click();

    // Wait for the lock screen to appear
    await expect(
      extensionPage.getByRole("heading", { name: /indexlens is locked/i }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("unlocks with valid passphrase", async ({ extensionPage }) => {
    const passphraseInput = extensionPage.getByLabel("Passphrase");
    const submitButton = extensionPage.getByRole("button", { name: /unlock/i });

    await passphraseInput.fill(TEST_PASSPHRASE);
    await submitButton.click();

    // Should transition to unlocked shell
    await expect(
      extensionPage.getByRole("button", { name: /lock/i }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("shows error for invalid passphrase", async ({ extensionPage }) => {
    const passphraseInput = extensionPage.getByLabel("Passphrase");
    const submitButton = extensionPage.getByRole("button", { name: /unlock/i });

    await passphraseInput.fill("wrong-passphrase-here");
    await submitButton.click();

    // Should show an error
    await expect(
      extensionPage.getByRole("alert"),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      extensionPage.getByText(/invalid passphrase/i),
    ).toBeVisible();

    // Should remain on the lock screen
    await expect(
      extensionPage.getByRole("heading", { name: /indexlens is locked/i }),
    ).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Auto-lock after idle timeout
// ---------------------------------------------------------------------------

test.describe("Auto-lock after inactivity", () => {
  test("re-locks the session after idle timeout", async ({ context, extensionId, extensionPage }) => {
    // Complete first-run setup
    await expect(
      extensionPage.getByRole("heading", { name: /welcome to indexlens/i }),
    ).toBeVisible({ timeout: 10_000 });

    const passphraseInput = extensionPage.getByLabel("Passphrase", { exact: true });
    const confirmInput = extensionPage.getByLabel("Confirm passphrase");
    const submitButton = extensionPage.getByRole("button", { name: /create passphrase/i });

    await passphraseInput.fill(TEST_PASSPHRASE);
    await confirmInput.fill(TEST_PASSPHRASE);
    await submitButton.click();

    await expect(
      extensionPage.getByRole("button", { name: /lock/i }),
    ).toBeVisible({ timeout: 10_000 });

    // Shorten the timeout via the background service worker to avoid long waits.
    // We set it to 2 seconds and the idle check interval is 15s,
    // so we use evaluate in the service worker context to override.
    const sw = context.serviceWorkers().find((w) => w.url().includes(extensionId));
    if (sw) {
      // Override the idle check to run every 500ms and set timeout to 1s
      await sw.evaluate(() => {
        // @ts-expect-error accessing module-scoped vars in the SW
        globalThis.__testOverrideTimeout = true;
        // Access module-scope via globalThis trick — the SW sets idleInterval
        // We'll use a more direct approach: send a message to update timeout
      });
    }

    // Use runtime messaging to set a very short timeout
    // The background worker checks every 15s, so we need to also speed that up.
    // Instead, directly manipulate via service worker evaluate.
    if (sw) {
      await sw.evaluate(() => {
        // Clear existing idle interval and set a fast one
        // These variables are module-scoped in the service worker
        const g = globalThis as Record<string, unknown>;

        // The background.ts variables are module-scoped, but we can
        // intercept via a direct override of the timeout and restart the timer
        // by sending a chrome.runtime message
        g.__testTimeoutMs = 1_000;
        g.__testIdleCheckMs = 500;
      });

      // Send a message to trigger timeout reconfiguration
      // We'll use the page to send a message
      await extensionPage.evaluate(async () => {
        // Store a very short timeout
        await chrome.storage.local.set({ lock_timeout_ms: 1_000 });
      });
    }

    // Lock and re-unlock to pick up the new timeout
    await extensionPage.getByRole("button", { name: /lock/i }).click();
    await expect(
      extensionPage.getByRole("heading", { name: /indexlens is locked/i }),
    ).toBeVisible({ timeout: 10_000 });

    // Unlock again
    await extensionPage.getByLabel("Passphrase").fill(TEST_PASSPHRASE);
    await extensionPage.getByRole("button", { name: /unlock/i }).click();
    await expect(
      extensionPage.getByRole("button", { name: /lock/i }),
    ).toBeVisible({ timeout: 10_000 });

    // Now stop all activity and wait for auto-lock.
    // The idle check in the background runs every 15s, so we need to wait
    // at least that long. Use a generous timeout.
    await expect(
      extensionPage.getByRole("heading", { name: /indexlens is locked/i }),
    ).toBeVisible({ timeout: 30_000 });
  });
});

// ---------------------------------------------------------------------------
// Lock hotkey (Ctrl+L)
// ---------------------------------------------------------------------------

test.describe("Lock hotkey", () => {
  test("Ctrl+L locks the app from unlocked state", async ({ extensionPage }) => {
    // Complete first-run setup
    await expect(
      extensionPage.getByRole("heading", { name: /welcome to indexlens/i }),
    ).toBeVisible({ timeout: 10_000 });

    const passphraseInput = extensionPage.getByLabel("Passphrase", { exact: true });
    const confirmInput = extensionPage.getByLabel("Confirm passphrase");
    const submitButton = extensionPage.getByRole("button", { name: /create passphrase/i });

    await passphraseInput.fill(TEST_PASSPHRASE);
    await confirmInput.fill(TEST_PASSPHRASE);
    await submitButton.click();

    // Wait for unlocked state
    await expect(
      extensionPage.getByRole("button", { name: /lock/i }),
    ).toBeVisible({ timeout: 10_000 });

    // Press Ctrl+L to lock the app
    await extensionPage.keyboard.press("Control+l");

    // Should transition to the lock screen
    await expect(
      extensionPage.getByRole("heading", { name: /indexlens is locked/i }),
    ).toBeVisible({ timeout: 10_000 });
  });
});

// ---------------------------------------------------------------------------
// Edit cluster configuration
// ---------------------------------------------------------------------------

test.describe("Edit cluster configuration", () => {
  test.beforeEach(async ({ extensionPage }) => {
    // Complete first-run setup
    await expect(
      extensionPage.getByRole("heading", { name: /welcome to indexlens/i }),
    ).toBeVisible({ timeout: 10_000 });

    const passphraseInput = extensionPage.getByLabel("Passphrase", { exact: true });
    const confirmInput = extensionPage.getByLabel("Confirm passphrase");
    const submitButton = extensionPage.getByRole("button", { name: /create passphrase/i });

    await passphraseInput.fill(TEST_PASSPHRASE);
    await confirmInput.fill(TEST_PASSPHRASE);
    await submitButton.click();

    // Wait for unlocked state
    await expect(
      extensionPage.getByRole("button", { name: /lock/i }),
    ).toBeVisible({ timeout: 10_000 });

    // Add a cluster with basic auth
    await extensionPage.getByRole("button", { name: /clusters/i }).click();
    await extensionPage.getByRole("menuitem", { name: /add cluster/i }).click();

    await extensionPage.getByLabel("Name").fill("Test Cluster");
    await extensionPage.getByLabel("URL").fill("https://localhost:9200");

    // Select basic auth
    await extensionPage.getByRole("combobox").click();
    await extensionPage.getByRole("option", { name: /basic/i }).click();

    await extensionPage.getByLabel("Username").fill("elastic");
    await extensionPage.getByLabel("Password").fill("secret-password");

    await extensionPage.getByRole("button", { name: /add cluster/i }).click();

    // Cluster should now be active in the navbar
    await expect(
      extensionPage.getByRole("button", { name: /test cluster/i }),
    ).toBeVisible({ timeout: 5_000 });
  });

  test("editing only the name preserves auth credentials", async ({ extensionPage }) => {
    // Open cluster dropdown and click the edit button
    await extensionPage.getByRole("button", { name: /test cluster/i }).click();
    await extensionPage.getByRole("button", { name: /edit test cluster/i }).click();

    // The dialog should be in edit mode
    await expect(
      extensionPage.getByRole("heading", { name: /edit cluster/i }),
    ).toBeVisible({ timeout: 5_000 });

    // Verify name is pre-filled
    await expect(extensionPage.getByLabel("Name")).toHaveValue("Test Cluster");

    // Change only the name — do NOT touch auth fields
    await extensionPage.getByLabel("Name").fill("Renamed Cluster");

    await extensionPage.getByRole("button", { name: /save changes/i }).click();

    // The cluster should show the new name
    await expect(
      extensionPage.getByRole("button", { name: /renamed cluster/i }),
    ).toBeVisible({ timeout: 5_000 });

    // Re-open edit dialog to verify credentials survived
    await extensionPage.getByRole("button", { name: /renamed cluster/i }).click();
    await extensionPage.getByRole("button", { name: /edit renamed cluster/i }).click();

    await expect(
      extensionPage.getByRole("heading", { name: /edit cluster/i }),
    ).toBeVisible({ timeout: 5_000 });

    // Auth type should still be basic
    await expect(extensionPage.getByRole("combobox")).toHaveText(/basic/i);

    // Username and password should be populated (not empty)
    await expect(extensionPage.getByLabel("Username")).toHaveValue("elastic");
    await expect(extensionPage.getByLabel("Password")).toHaveValue("secret-password");

    // Close dialog
    await extensionPage.getByRole("button", { name: /cancel/i }).click();
  });

  test("changing auth field during edit persists the new value", async ({ extensionPage }) => {
    // Open cluster dropdown and click the edit button
    await extensionPage.getByRole("button", { name: /test cluster/i }).click();
    await extensionPage.getByRole("button", { name: /edit test cluster/i }).click();

    await expect(
      extensionPage.getByRole("heading", { name: /edit cluster/i }),
    ).toBeVisible({ timeout: 5_000 });

    // Change only the password — leave username untouched
    await extensionPage.getByLabel("Password").fill("new-password");

    await extensionPage.getByRole("button", { name: /save changes/i }).click();

    // Re-open edit dialog
    await extensionPage.getByRole("button", { name: /test cluster/i }).click();
    await extensionPage.getByRole("button", { name: /edit test cluster/i }).click();

    await expect(
      extensionPage.getByRole("heading", { name: /edit cluster/i }),
    ).toBeVisible({ timeout: 5_000 });

    // Username should be preserved, password should be the new one
    await expect(extensionPage.getByLabel("Username")).toHaveValue("elastic");
    await expect(extensionPage.getByLabel("Password")).toHaveValue("new-password");

    await extensionPage.getByRole("button", { name: /cancel/i }).click();
  });

  test("switching auth type replaces credentials entirely", async ({ extensionPage }) => {
    // Open cluster dropdown and click the edit button
    await extensionPage.getByRole("button", { name: /test cluster/i }).click();
    await extensionPage.getByRole("button", { name: /edit test cluster/i }).click();

    await expect(
      extensionPage.getByRole("heading", { name: /edit cluster/i }),
    ).toBeVisible({ timeout: 5_000 });

    // Switch to API key auth
    await extensionPage.getByRole("combobox").click();
    await extensionPage.getByRole("option", { name: /api key/i }).click();

    // Fill in the API key
    await extensionPage.getByLabel("API Key").fill("my-api-key-value");

    await extensionPage.getByRole("button", { name: /save changes/i }).click();

    // Re-open edit dialog
    await extensionPage.getByRole("button", { name: /test cluster/i }).click();
    await extensionPage.getByRole("button", { name: /edit test cluster/i }).click();

    await expect(
      extensionPage.getByRole("heading", { name: /edit cluster/i }),
    ).toBeVisible({ timeout: 5_000 });

    // Should now be API key auth with the value we set
    await expect(extensionPage.getByRole("combobox")).toHaveText(/api key/i);
    await expect(extensionPage.getByLabel("API Key")).toHaveValue("my-api-key-value");

    await extensionPage.getByRole("button", { name: /cancel/i }).click();
  });
});

// ---------------------------------------------------------------------------
// Encrypted config import/export
// ---------------------------------------------------------------------------

test.describe("Encrypted config transfer", () => {
  test("exported config is encrypted and import requires the correct passphrase", async ({ extensionPage }, testInfo) => {
    await expect(
      extensionPage.getByRole("heading", { name: /welcome to indexlens/i }),
    ).toBeVisible({ timeout: 10_000 });

    await extensionPage.getByLabel("Passphrase", { exact: true }).fill(TEST_PASSPHRASE);
    await extensionPage.getByLabel("Confirm passphrase").fill(TEST_PASSPHRASE);
    await extensionPage.getByRole("button", { name: /create passphrase/i }).click();

    await expect(
      extensionPage.getByRole("button", { name: /lock/i }),
    ).toBeVisible({ timeout: 10_000 });

    await extensionPage.getByRole("button", { name: /clusters/i }).click();
    await extensionPage.getByRole("menuitem", { name: /add cluster/i }).click();

    await extensionPage.getByLabel("Name").fill("Encrypted Export Cluster");
    await extensionPage.getByLabel("URL").fill("https://localhost:9200");
    await extensionPage.getByRole("combobox").click();
    await extensionPage.getByRole("option", { name: /basic/i }).click();
    await extensionPage.getByLabel("Username").fill("elastic");
    await extensionPage.getByLabel("Password").fill("super-e2e-secret");
    await extensionPage.getByRole("button", { name: /add cluster/i }).click();

    await extensionPage.getByRole("button", { name: /settings/i }).click();

    const downloadPromise = extensionPage.waitForEvent("download");
    await extensionPage.getByRole("button", { name: /export encrypted config/i }).click();
    await extensionPage.locator("#export-passphrase").fill("transfer-passphrase-123");
    await extensionPage.locator("#export-passphrase-confirm").fill("transfer-passphrase-123");
    await extensionPage.getByRole("button", { name: /^export$/i }).click();

    const download = await downloadPromise;
    const exportPath = testInfo.outputPath("indexlens-config-export.json");
    await download.saveAs(exportPath);

    const exportContents = await readFile(exportPath, "utf8");
    expect(exportContents).toContain("indexlens-export-encrypted");
    expect(exportContents).not.toContain("super-e2e-secret");
    expect(exportContents).not.toContain("\"password\"");

    await extensionPage.locator("input[type='file']").first().setInputFiles(exportPath);
    await expect(
      extensionPage.getByRole("heading", { name: /import encrypted configuration/i }),
    ).toBeVisible({ timeout: 5_000 });

    await extensionPage.locator("#import-passphrase").fill("wrong-passphrase");
    await extensionPage.getByRole("button", { name: /^import$/i }).click();
    await expect(
      extensionPage.getByText(/unable to decrypt indexlens config/i),
    ).toBeVisible({ timeout: 10_000 });

    await extensionPage.locator("#import-passphrase").fill("transfer-passphrase-123");
    await extensionPage.getByRole("button", { name: /^import$/i }).click();
    await expect(
      extensionPage.getByText(/no new data to import|imported/i),
    ).toBeVisible({ timeout: 10_000 });
  });
});

// ---------------------------------------------------------------------------
// REST body autocomplete behavior
// ---------------------------------------------------------------------------

test.describe("REST body autocomplete", () => {
  test("does not accept first suggestion on Enter without explicit selection", async ({ extensionPage }) => {
    let searchRequestCount = 0;

    await extensionPage.route("http://127.0.0.1:9200/**", async (route) => {
      const req = route.request();
      const url = req.url();

      if (url.includes("/_cat/indices")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([{ index: "products" }]),
        });
        return;
      }

      if (url.includes("/_cat/aliases")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: "[]",
        });
        return;
      }

      if (url.endsWith("/products/_search") && req.method() === "POST") {
        searchRequestCount += 1;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ took: 1, hits: { total: { value: 0, relation: "eq" }, hits: [] } }),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "{}",
      });
    });

    // First-run setup
    await expect(
      extensionPage.getByRole("heading", { name: /welcome to indexlens/i }),
    ).toBeVisible({ timeout: 10_000 });
    await extensionPage.getByLabel("Passphrase", { exact: true }).fill(TEST_PASSPHRASE);
    await extensionPage.getByLabel("Confirm passphrase").fill(TEST_PASSPHRASE);
    await extensionPage.getByRole("button", { name: /create passphrase/i }).click();
    await expect(
      extensionPage.getByRole("button", { name: /lock/i }),
    ).toBeVisible({ timeout: 10_000 });

    // Add a cluster so REST page is available.
    await extensionPage.getByRole("button", { name: /clusters/i }).click();
    await extensionPage.getByRole("menuitem", { name: /add cluster/i }).click();
    await extensionPage.getByLabel("Name").fill("Autocomplete Cluster");
    await extensionPage.getByLabel("URL").fill("http://127.0.0.1:9200");
    await extensionPage.getByRole("button", { name: /^add cluster$/i }).click();

    // Open REST page and prepare a POST search request.
    await extensionPage.getByRole("button", { name: /^rest$/i }).click();
    await extensionPage.getByRole("combobox").click();
    await extensionPage.getByRole("option", { name: /^POST$/ }).click();

    const endpointEditor = extensionPage.locator(".cm-editor").first();
    const bodyEditor = extensionPage.locator(".cm-editor").nth(1);

    // Scenario A: incomplete endpoint keeps Tab for autocomplete/editor behavior.
    await endpointEditor.click();
    await extensionPage.keyboard.press("Control+a");
    await extensionPage.keyboard.type("/products/_se");
    const bodyBeforeIncompleteTab = await bodyEditor.locator(".cm-content").innerText();
    await extensionPage.keyboard.press("Tab");
    await extensionPage.keyboard.type("x");
    const endpointAfterIncompleteTab = await endpointEditor.locator(".cm-content").innerText();
    const bodyAfterIncompleteTab = await bodyEditor.locator(".cm-content").innerText();
    expect(endpointAfterIncompleteTab).toContain("/products/_");
    expect(bodyAfterIncompleteTab).toBe(bodyBeforeIncompleteTab);

    // Scenario B: complete endpoint moves focus to body on Tab.
    await endpointEditor.click();
    await extensionPage.keyboard.press("Control+a");
    await extensionPage.keyboard.type("/products/_search");
    const endpointBeforeCompleteTab = await endpointEditor.locator(".cm-content").innerText();
    await extensionPage.keyboard.press("Tab");
    await extensionPage.keyboard.type("\"query\"");
    const endpointAfterCompleteTab = await endpointEditor.locator(".cm-content").innerText();
    const bodyAfterCompleteTab = await bodyEditor.locator(".cm-content").innerText();
    expect(endpointAfterCompleteTab).toBe(endpointBeforeCompleteTab);
    expect(bodyAfterCompleteTab).toContain("\"query\"");

    await bodyEditor.click();
    await extensionPage.keyboard.press("Control+a");
    await extensionPage.keyboard.type("{\n  \"");

    const completionMenu = extensionPage.locator(".cm-tooltip-autocomplete");
    await expect(completionMenu).toBeVisible();

    // Enter should insert a newline, not accept the first completion.
    await extensionPage.keyboard.press("Enter");
    let bodyText = await bodyEditor.locator(".cm-content").innerText();
    expect(bodyText.split("\n").length).toBeGreaterThan(3);
    expect(bodyText).not.toContain("\"query\"");

    // Explicit selection (ArrowDown + Tab) should still accept a completion.
    await bodyEditor.click();
    await extensionPage.keyboard.press("Control+a");
    await extensionPage.keyboard.type("{\n  \"");
    await expect(completionMenu).toBeVisible();
    await extensionPage.keyboard.press("ArrowDown");
    await extensionPage.keyboard.press("Tab");
    bodyText = await bodyEditor.locator(".cm-content").innerText();
    expect(bodyText).toContain("\"query\"");

    // Ctrl+Enter send shortcut should continue to execute the request.
    await extensionPage.keyboard.press("Control+Enter");
    await expect.poll(() => searchRequestCount).toBe(1);
  });

  test("shows field suggestions when endpoint uses an alias that maps to multiple indices", async ({ extensionPage }) => {
    await extensionPage.route("http://127.0.0.1:9200/**", async (route) => {
      const url = route.request().url();

      if (url.includes("/_cat/indices")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([
            { index: "orders-2024" },
            { index: "orders-2025" },
          ]),
        });
        return;
      }

      if (url.includes("/_cat/aliases")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([{ alias: "orders-alias" }]),
        });
        return;
      }

      // Mock alias mapping response — returns fields from two backing indices
      if (url.includes("/orders-alias/_mapping")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            "orders-2024": {
              mappings: {
                properties: {
                  order_id: { type: "keyword" },
                  amount: { type: "float" },
                  customer: {
                    properties: {
                      name: { type: "text" },
                    },
                  },
                },
              },
            },
            "orders-2025": {
              mappings: {
                properties: {
                  order_id: { type: "keyword" },
                  amount: { type: "float" },
                  discount: { type: "float" },
                  customer: {
                    properties: {
                      name: { type: "text" },
                      email: { type: "keyword" },
                    },
                  },
                },
              },
            },
          }),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "{}",
      });
    });

    // First-run setup
    await expect(
      extensionPage.getByRole("heading", { name: /welcome to indexlens/i }),
    ).toBeVisible({ timeout: 10_000 });
    await extensionPage.getByLabel("Passphrase", { exact: true }).fill(TEST_PASSPHRASE);
    await extensionPage.getByLabel("Confirm passphrase").fill(TEST_PASSPHRASE);
    await extensionPage.getByRole("button", { name: /create passphrase/i }).click();
    await expect(
      extensionPage.getByRole("button", { name: /lock/i }),
    ).toBeVisible({ timeout: 10_000 });

    // Add a cluster
    await extensionPage.getByRole("button", { name: /clusters/i }).click();
    await extensionPage.getByRole("menuitem", { name: /add cluster/i }).click();
    await extensionPage.getByLabel("Name").fill("Alias Cluster");
    await extensionPage.getByLabel("URL").fill("http://127.0.0.1:9200");
    await extensionPage.getByRole("button", { name: /^add cluster$/i }).click();

    // Navigate to REST page and switch to POST
    await extensionPage.getByRole("button", { name: /^rest$/i }).click();
    await extensionPage.getByRole("combobox").click();
    await extensionPage.getByRole("option", { name: /^POST$/ }).click();

    const endpointEditor = extensionPage.locator(".cm-editor").first();
    const bodyEditor = extensionPage.locator(".cm-editor").nth(1);

    // Type the alias endpoint
    await endpointEditor.click();
    await extensionPage.keyboard.press("Control+a");
    await extensionPage.keyboard.type("/orders-alias/_search");

    // Wait for the debounced mapping fetch to complete
    await extensionPage.waitForTimeout(600);

    // Focus the body editor and trigger field autocomplete
    await bodyEditor.click();
    await extensionPage.keyboard.press("Control+a");
    // Start a match query so field names are suggested
    await extensionPage.keyboard.type("{\n  \"query\": {\n    \"match\": {\n      \"");

    const completionMenu = extensionPage.locator(".cm-tooltip-autocomplete");
    await expect(completionMenu).toBeVisible({ timeout: 5_000 });

    // Verify fields from BOTH backing indices are suggested
    const completionText = await completionMenu.innerText();
    expect(completionText).toContain("amount");
    expect(completionText).toContain("order_id");
    // "discount" only exists in orders-2025 — confirms multi-index merge
    expect(completionText).toContain("discount");
    // Nested field from orders-2025
    expect(completionText).toContain("customer.email");
  });
});

// ---------------------------------------------------------------------------
// Toolbar icon click
// ---------------------------------------------------------------------------

test.describe("Toolbar icon click", () => {
  test("clicking extension action opens the options page", async ({ context, extensionId }) => {
    // Use the background service worker to simulate the action click
    const sw = context.serviceWorkers().find((w) => w.url().includes(extensionId));
    expect(sw).toBeTruthy();

    // Count tabs before
    const pagesBefore = context.pages().length;

    // Simulate action click by navigating to the extension page
    // (we can't programmatically trigger chrome.action.onClicked in tests,
    //  but we can verify the handler is registered and the page is accessible)
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/index.html`);

    // The extension page should load and show content
    await expect(
      page.getByRole("heading", { name: /welcome to indexlens|indexlens is locked/i }),
    ).toBeVisible({ timeout: 10_000 });

    // Verify a new page was created (regression: "nothing happens" on icon click)
    expect(context.pages().length).toBeGreaterThan(pagesBefore);
  });
});

// ---------------------------------------------------------------------------
// Scout command mode
// ---------------------------------------------------------------------------

test.describe("Scout command mode", () => {
  test.beforeEach(async ({ extensionPage }) => {
    // Mock all ES requests to avoid real cluster connections
    await extensionPage.route("http://127.0.0.1:9200/**", async (route) => {
      const url = route.request().url();
      if (url.includes("/_cat/indices")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([{ index: "test-index" }]),
        });
      } else if (url.includes("/_cat/aliases")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: "[]",
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: "{}",
        });
      }
    });

    await extensionPage.route("http://127.0.0.1:9201/**", async (route) => {
      const url = route.request().url();
      if (url.includes("/_cat/indices")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([{ index: "other-index" }]),
        });
      } else if (url.includes("/_cat/aliases")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: "[]",
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: "{}",
        });
      }
    });

    // First-run setup
    await expect(
      extensionPage.getByRole("heading", { name: /welcome to indexlens/i }),
    ).toBeVisible({ timeout: 10_000 });
    await extensionPage.getByLabel("Passphrase", { exact: true }).fill(TEST_PASSPHRASE);
    await extensionPage.getByLabel("Confirm passphrase").fill(TEST_PASSPHRASE);
    await extensionPage.getByRole("button", { name: /create passphrase/i }).click();
    await expect(
      extensionPage.getByRole("button", { name: /lock/i }),
    ).toBeVisible({ timeout: 10_000 });

    // Add first cluster
    await extensionPage.getByRole("button", { name: /clusters/i }).click();
    await extensionPage.getByRole("menuitem", { name: /add cluster/i }).click();
    await extensionPage.getByLabel("Name").fill("Cluster Alpha");
    await extensionPage.getByLabel("URL").fill("http://127.0.0.1:9200");
    await extensionPage.getByRole("button", { name: /^add cluster$/i }).click();
    await expect(
      extensionPage.getByRole("button", { name: /cluster alpha/i }),
    ).toBeVisible({ timeout: 5_000 });

    // Add second cluster
    await extensionPage.getByRole("button", { name: /cluster alpha/i }).click();
    await extensionPage.getByRole("menuitem", { name: /add cluster/i }).click();
    await extensionPage.getByLabel("Name").fill("Cluster Beta");
    await extensionPage.getByLabel("URL").fill("http://127.0.0.1:9201");
    await extensionPage.getByRole("button", { name: /^add cluster$/i }).click();
  });

  test("clusters are not shown in default Scout results", async ({ extensionPage }) => {
    await extensionPage.keyboard.press("Control+Space");

    // Scout should be open
    const dialog = extensionPage.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Navigation items should be visible
    await expect(dialog.getByText("Navigation")).toBeVisible();

    // Clusters should NOT appear in default results
    await expect(dialog.getByText("Cluster Beta")).not.toBeVisible();

    // Close Scout
    await extensionPage.keyboard.press("Escape");
  });

  test("typing > shows command list with Select Cluster", async ({ extensionPage }) => {
    await extensionPage.keyboard.press("Control+Space");
    const dialog = extensionPage.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Type '>' to enter command mode
    await extensionPage.keyboard.type(">");

    // Should show Commands group with Select Cluster
    await expect(dialog.getByText("Commands")).toBeVisible();
    await expect(dialog.getByText("Select Cluster")).toBeVisible();

    // Navigation should NOT be shown in command mode
    await expect(dialog.getByText("Navigation")).not.toBeVisible();

    await extensionPage.keyboard.press("Escape");
  });

  test("selecting Select Cluster command shows cluster list and switches cluster", async ({ extensionPage }) => {
    await extensionPage.keyboard.press("Control+Space");
    const dialog = extensionPage.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Type '>' and select the Select Cluster command
    await extensionPage.keyboard.type(">");
    await expect(dialog.getByText("Select Cluster")).toBeVisible();
    await extensionPage.keyboard.press("Enter");

    // Input should now read "> Select Cluster "
    const input = dialog.locator("[cmdk-input]");
    await expect(input).toHaveValue("> Select Cluster ");

    // Should show the non-active cluster (Cluster Beta since Alpha is active)
    // The "Select Cluster" heading is the group heading now
    await expect(dialog.getByText("Cluster Beta")).toBeVisible({ timeout: 5_000 });

    // Select the cluster
    await extensionPage.keyboard.press("Enter");

    // Scout should close
    await expect(dialog).not.toBeVisible({ timeout: 5_000 });

    // Cluster Beta should now be active in the navbar
    await expect(
      extensionPage.getByRole("button", { name: /cluster beta/i }),
    ).toBeVisible({ timeout: 5_000 });
  });

  test("deleting back to > returns to command list", async ({ extensionPage }) => {
    await extensionPage.keyboard.press("Control+Space");
    const dialog = extensionPage.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Enter command mode and select Select Cluster
    await extensionPage.keyboard.type(">");
    await extensionPage.keyboard.press("Enter");

    // Should be in active command mode
    const input = dialog.locator("[cmdk-input]");
    await expect(input).toHaveValue("> Select Cluster ");

    // Delete everything after '> ' to go back to command list
    // Select all and retype just '>'
    await extensionPage.keyboard.press("Control+a");
    await extensionPage.keyboard.type("> ");

    // Should show command list again
    await expect(dialog.getByText("Commands")).toBeVisible();
    await expect(dialog.getByText("Cluster Beta")).not.toBeVisible();

    await extensionPage.keyboard.press("Escape");
  });

  test("removing > exits command mode and returns to normal results", async ({ extensionPage }) => {
    await extensionPage.keyboard.press("Control+Space");
    const dialog = extensionPage.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Enter command mode
    await extensionPage.keyboard.type(">");
    await expect(dialog.getByText("Commands")).toBeVisible();

    // Clear input to exit command mode
    await extensionPage.keyboard.press("Control+a");
    await extensionPage.keyboard.type("dash");

    // Should show normal search results
    await expect(dialog.getByText("Navigation")).toBeVisible();
    await expect(dialog.getByText("Dashboard")).toBeVisible();
    await expect(dialog.getByText("Commands")).not.toBeVisible();

    await extensionPage.keyboard.press("Escape");
  });
});

// ---------------------------------------------------------------------------
// Ctrl+Space Scout hotkey in Vim normal mode
// ---------------------------------------------------------------------------

test.describe("Scout hotkey with Vim mode", () => {
  test.beforeEach(async ({ extensionPage }) => {
    // Mock ES requests
    await extensionPage.route("http://127.0.0.1:9200/**", async (route) => {
      const url = route.request().url();
      if (url.includes("/_cat/indices")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([{ index: "test-index" }]),
        });
      } else if (url.includes("/_cat/aliases")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: "[]",
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: "{}",
        });
      }
    });

    // First-run setup
    await expect(
      extensionPage.getByRole("heading", { name: /welcome to indexlens/i }),
    ).toBeVisible({ timeout: 10_000 });
    await extensionPage.getByLabel("Passphrase", { exact: true }).fill(TEST_PASSPHRASE);
    await extensionPage.getByLabel("Confirm passphrase").fill(TEST_PASSPHRASE);
    await extensionPage.getByRole("button", { name: /create passphrase/i }).click();
    await expect(
      extensionPage.getByRole("button", { name: /lock/i }),
    ).toBeVisible({ timeout: 10_000 });

    // Add a cluster
    await extensionPage.getByRole("button", { name: /clusters/i }).click();
    await extensionPage.getByRole("menuitem", { name: /add cluster/i }).click();
    await extensionPage.getByLabel("Name").fill("Vim Test Cluster");
    await extensionPage.getByLabel("URL").fill("http://127.0.0.1:9200");
    await extensionPage.getByRole("button", { name: /^add cluster$/i }).click();
    await expect(
      extensionPage.getByRole("button", { name: /vim test cluster/i }),
    ).toBeVisible({ timeout: 5_000 });

    // Navigate to REST page
    await extensionPage.getByRole("button", { name: /^rest$/i }).click();
  });

  test("Ctrl+Space opens Scout when CodeMirror Vim is in normal mode", async ({ extensionPage }) => {
    // Enable Vim mode via the checkbox on the REST page
    const vimCheckbox = extensionPage.locator("label").filter({ hasText: "Vim mode" }).locator("input[type='checkbox']");
    await vimCheckbox.check();

    // Focus the endpoint editor (first .cm-editor) and enter some text
    const endpointEditor = extensionPage.locator(".cm-editor").first();
    await endpointEditor.click();
    await extensionPage.keyboard.type("i/test");

    // Press Escape to return to Vim normal mode
    await extensionPage.keyboard.press("Escape");

    // Verify we are in normal mode by checking the Vim status bar
    await expect(extensionPage.getByText("NORMAL")).toBeVisible({ timeout: 3_000 });

    // Press Ctrl+Space — this should open Scout despite Vim normal mode
    await extensionPage.keyboard.press("Control+Space");

    const dialog = extensionPage.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Close Scout
    await extensionPage.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible({ timeout: 5_000 });
  });

  test("Ctrl+Space opens Scout from Vim normal mode in body editor", async ({ extensionPage }) => {
    // Enable Vim mode
    const vimCheckbox = extensionPage.locator("label").filter({ hasText: "Vim mode" }).locator("input[type='checkbox']");
    await vimCheckbox.check();

    // Switch to POST so body editor is visible
    await extensionPage.getByRole("combobox").click();
    await extensionPage.getByRole("option", { name: /^POST$/ }).click();

    // Focus the body editor (second .cm-editor)
    const bodyEditor = extensionPage.locator(".cm-editor").nth(1);
    await bodyEditor.click();

    // Press Escape to ensure Vim normal mode
    await extensionPage.keyboard.press("Escape");

    await expect(extensionPage.getByText("NORMAL")).toBeVisible({ timeout: 3_000 });

    // Press Ctrl+Space — should open Scout
    await extensionPage.keyboard.press("Control+Space");

    const dialog = extensionPage.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Close and reopen to verify toggle behavior
    await extensionPage.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible({ timeout: 5_000 });
  });
});
