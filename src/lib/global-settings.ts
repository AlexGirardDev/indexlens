/**
 * Global UI settings persisted in localStorage.
 *
 * These settings are NOT cluster-scoped — they apply across all clusters
 * and sessions. Uses a single JSON blob under a namespaced key.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GlobalSettings {
  vimModeEnabled: boolean;
}

// ---------------------------------------------------------------------------
// Defaults & key
// ---------------------------------------------------------------------------

const STORAGE_KEY = "indexlens_global_settings";

const DEFAULTS: GlobalSettings = {
  vimModeEnabled: false,
};

// ---------------------------------------------------------------------------
// Read / Write
// ---------------------------------------------------------------------------

export function loadGlobalSettings(): GlobalSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<GlobalSettings>;
    return {
      vimModeEnabled:
        typeof parsed.vimModeEnabled === "boolean"
          ? parsed.vimModeEnabled
          : DEFAULTS.vimModeEnabled,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveGlobalSettings(settings: GlobalSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage full or unavailable — silently fail
  }
}

export function setVimMode(enabled: boolean): void {
  const settings = loadGlobalSettings();
  settings.vimModeEnabled = enabled;
  saveGlobalSettings(settings);
}
