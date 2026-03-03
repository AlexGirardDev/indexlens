/**
 * Persistence layer for per-cluster REST history and saved queries.
 *
 * Uses localStorage (non-sensitive request metadata).
 * Each cluster gets its own namespaced key for history and saved queries.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RestHistoryEntry {
  id: string;
  method: string;
  endpoint: string;
  body: string;
  timestamp: number;
}

export interface SavedQuery {
  id: string;
  name: string;
  method: string;
  endpoint: string;
  body: string;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HISTORY_PREFIX = "indexlens_rest_history_";
const SAVED_PREFIX = "indexlens_rest_saved_";
const MAX_HISTORY = 20;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function historyKey(clusterId: string): string {
  return `${HISTORY_PREFIX}${clusterId}`;
}

function savedKey(clusterId: string): string {
  return `${SAVED_PREFIX}${clusterId}`;
}

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeJson<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or unavailable — silently fail so UI stays usable
  }
}

export function generateId(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

// ---------------------------------------------------------------------------
// History helpers (pure functions + read/write wrappers)
// ---------------------------------------------------------------------------

/** Two entries are equivalent if method, endpoint, and body match. */
function entriesEqual(a: RestHistoryEntry, b: Omit<RestHistoryEntry, "id" | "timestamp">): boolean {
  return a.method === b.method && a.endpoint === b.endpoint && a.body === b.body;
}

/**
 * Add a history entry, de-duplicate, and cap at MAX_HISTORY.
 * Returns the new list (newest first).
 */
export function addHistoryEntry(
  existing: RestHistoryEntry[],
  entry: Omit<RestHistoryEntry, "id" | "timestamp">,
): RestHistoryEntry[] {
  const filtered = existing.filter((e) => !entriesEqual(e, entry));
  const newEntry: RestHistoryEntry = {
    ...entry,
    id: generateId(),
    timestamp: Date.now(),
  };
  return [newEntry, ...filtered].slice(0, MAX_HISTORY);
}

// ---------------------------------------------------------------------------
// Saved query helpers (pure functions)
// ---------------------------------------------------------------------------

export function addSavedQuery(
  existing: SavedQuery[],
  query: { name: string; method: string; endpoint: string; body: string },
): SavedQuery[] {
  const now = Date.now();
  const newQuery: SavedQuery = {
    id: generateId(),
    ...query,
    createdAt: now,
    updatedAt: now,
  };
  return [newQuery, ...existing];
}

export function deleteSavedQuery(existing: SavedQuery[], id: string): SavedQuery[] {
  return existing.filter((q) => q.id !== id);
}

export function renameSavedQuery(existing: SavedQuery[], id: string, name: string): SavedQuery[] {
  return existing.map((q) => (q.id === id ? { ...q, name, updatedAt: Date.now() } : q));
}

// ---------------------------------------------------------------------------
// Read / write for a specific cluster
// ---------------------------------------------------------------------------

export function loadHistory(clusterId: string): RestHistoryEntry[] {
  const data = readJson<RestHistoryEntry[]>(historyKey(clusterId));
  if (!Array.isArray(data)) return [];
  return data;
}

export function saveHistory(clusterId: string, entries: RestHistoryEntry[]): void {
  writeJson(historyKey(clusterId), entries);
}

export function loadSavedQueries(clusterId: string): SavedQuery[] {
  const data = readJson<SavedQuery[]>(savedKey(clusterId));
  if (!Array.isArray(data)) return [];
  return data;
}

export function saveSavedQueries(clusterId: string, queries: SavedQuery[]): void {
  writeJson(savedKey(clusterId), queries);
}
