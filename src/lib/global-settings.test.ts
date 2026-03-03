import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  loadGlobalSettings,
  saveGlobalSettings,
  setVimMode,
} from "./global-settings";

// ---------------------------------------------------------------------------
// Mock localStorage
// ---------------------------------------------------------------------------

const store: Record<string, string> = {};

beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key];

  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
  });
});

// ---------------------------------------------------------------------------
// loadGlobalSettings
// ---------------------------------------------------------------------------

describe("loadGlobalSettings", () => {
  it("returns defaults when nothing is stored", () => {
    const settings = loadGlobalSettings();
    expect(settings).toEqual({ vimModeEnabled: false });
  });

  it("reads persisted settings", () => {
    store["indexlens_global_settings"] = JSON.stringify({ vimModeEnabled: true });
    const settings = loadGlobalSettings();
    expect(settings.vimModeEnabled).toBe(true);
  });

  it("returns defaults for corrupted JSON", () => {
    store["indexlens_global_settings"] = "not-json";
    const settings = loadGlobalSettings();
    expect(settings).toEqual({ vimModeEnabled: false });
  });

  it("returns defaults for invalid data types", () => {
    store["indexlens_global_settings"] = JSON.stringify({ vimModeEnabled: "yes" });
    const settings = loadGlobalSettings();
    expect(settings.vimModeEnabled).toBe(false);
  });

  it("fills in missing fields with defaults", () => {
    store["indexlens_global_settings"] = JSON.stringify({});
    const settings = loadGlobalSettings();
    expect(settings.vimModeEnabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// saveGlobalSettings
// ---------------------------------------------------------------------------

describe("saveGlobalSettings", () => {
  it("persists settings to localStorage", () => {
    saveGlobalSettings({ vimModeEnabled: true });
    const raw = store["indexlens_global_settings"];
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw);
    expect(parsed.vimModeEnabled).toBe(true);
  });

  it("round-trips with loadGlobalSettings", () => {
    saveGlobalSettings({ vimModeEnabled: true });
    const loaded = loadGlobalSettings();
    expect(loaded.vimModeEnabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// setVimMode
// ---------------------------------------------------------------------------

describe("setVimMode", () => {
  it("enables vim mode", () => {
    setVimMode(true);
    const settings = loadGlobalSettings();
    expect(settings.vimModeEnabled).toBe(true);
  });

  it("disables vim mode", () => {
    setVimMode(true);
    setVimMode(false);
    const settings = loadGlobalSettings();
    expect(settings.vimModeEnabled).toBe(false);
  });
});
