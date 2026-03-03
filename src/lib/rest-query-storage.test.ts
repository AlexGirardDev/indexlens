import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  addHistoryEntry,
  addSavedQuery,
  deleteSavedQuery,
  renameSavedQuery,
  loadHistory,
  saveHistory,
  loadSavedQueries,
  saveSavedQueries,
} from "./rest-query-storage";
import type { RestHistoryEntry, SavedQuery } from "./rest-query-storage";

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
// addHistoryEntry
// ---------------------------------------------------------------------------

describe("addHistoryEntry", () => {
  it("adds an entry to an empty list", () => {
    const result = addHistoryEntry([], {
      method: "GET",
      endpoint: "/_cat/health",
      body: "",
    });
    expect(result).toHaveLength(1);
    expect(result[0].method).toBe("GET");
    expect(result[0].endpoint).toBe("/_cat/health");
    expect(result[0].id).toBeTruthy();
    expect(result[0].timestamp).toBeGreaterThan(0);
  });

  it("prepends newest entry first", () => {
    const first = addHistoryEntry([], {
      method: "GET",
      endpoint: "/a",
      body: "",
    });
    const second = addHistoryEntry(first, {
      method: "POST",
      endpoint: "/b",
      body: "{}",
    });
    expect(second).toHaveLength(2);
    expect(second[0].method).toBe("POST");
    expect(second[1].method).toBe("GET");
  });

  it("de-duplicates equivalent entries", () => {
    const first = addHistoryEntry([], {
      method: "GET",
      endpoint: "/x",
      body: "",
    });
    const second = addHistoryEntry(first, {
      method: "GET",
      endpoint: "/x",
      body: "",
    });
    expect(second).toHaveLength(1);
  });

  it("caps history at 20 items", () => {
    let entries: RestHistoryEntry[] = [];
    for (let i = 0; i < 25; i++) {
      entries = addHistoryEntry(entries, {
        method: "GET",
        endpoint: `/index-${i}/_search`,
        body: "",
      });
    }
    expect(entries).toHaveLength(20);
    // The newest should be first
    expect(entries[0].endpoint).toBe("/index-24/_search");
  });

  it("moves duplicate to the front rather than adding a second copy", () => {
    let entries: RestHistoryEntry[] = [];
    entries = addHistoryEntry(entries, { method: "GET", endpoint: "/a", body: "" });
    entries = addHistoryEntry(entries, { method: "GET", endpoint: "/b", body: "" });
    entries = addHistoryEntry(entries, { method: "GET", endpoint: "/a", body: "" });
    expect(entries).toHaveLength(2);
    expect(entries[0].endpoint).toBe("/a");
    expect(entries[1].endpoint).toBe("/b");
  });
});

// ---------------------------------------------------------------------------
// Saved query helpers
// ---------------------------------------------------------------------------

describe("addSavedQuery", () => {
  it("adds a saved query to an empty list", () => {
    const result = addSavedQuery([], {
      name: "My Query",
      method: "POST",
      endpoint: "/my-index/_search",
      body: '{"query":{"match_all":{}}}',
    });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("My Query");
    expect(result[0].id).toBeTruthy();
  });

  it("prepends new queries", () => {
    let queries: SavedQuery[] = [];
    queries = addSavedQuery(queries, {
      name: "First",
      method: "GET",
      endpoint: "/a",
      body: "",
    });
    queries = addSavedQuery(queries, {
      name: "Second",
      method: "GET",
      endpoint: "/b",
      body: "",
    });
    expect(queries[0].name).toBe("Second");
    expect(queries[1].name).toBe("First");
  });
});

describe("deleteSavedQuery", () => {
  it("removes a query by id", () => {
    let queries = addSavedQuery([], {
      name: "Q1",
      method: "GET",
      endpoint: "/a",
      body: "",
    });
    queries = addSavedQuery(queries, {
      name: "Q2",
      method: "GET",
      endpoint: "/b",
      body: "",
    });
    const id = queries[0].id;
    const result = deleteSavedQuery(queries, id);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Q1");
  });
});

describe("renameSavedQuery", () => {
  it("renames a query by id", () => {
    const queries = addSavedQuery([], {
      name: "Old Name",
      method: "GET",
      endpoint: "/a",
      body: "",
    });
    const result = renameSavedQuery(queries, queries[0].id, "New Name");
    expect(result[0].name).toBe("New Name");
    expect(result[0].updatedAt).toBeGreaterThanOrEqual(queries[0].updatedAt);
  });
});

// ---------------------------------------------------------------------------
// localStorage persistence
// ---------------------------------------------------------------------------

describe("loadHistory / saveHistory", () => {
  it("returns empty array when no data stored", () => {
    expect(loadHistory("cluster-1")).toEqual([]);
  });

  it("round-trips history data", () => {
    const entries = addHistoryEntry([], {
      method: "GET",
      endpoint: "/test",
      body: "",
    });
    saveHistory("cluster-1", entries);
    const loaded = loadHistory("cluster-1");
    expect(loaded).toEqual(entries);
  });

  it("isolates data per cluster", () => {
    const e1 = addHistoryEntry([], { method: "GET", endpoint: "/a", body: "" });
    const e2 = addHistoryEntry([], { method: "POST", endpoint: "/b", body: "{}" });
    saveHistory("c1", e1);
    saveHistory("c2", e2);
    expect(loadHistory("c1")[0].endpoint).toBe("/a");
    expect(loadHistory("c2")[0].endpoint).toBe("/b");
  });

  it("handles invalid JSON gracefully", () => {
    store["indexlens_rest_history_bad"] = "not-json";
    expect(loadHistory("bad")).toEqual([]);
  });
});

describe("loadSavedQueries / saveSavedQueries", () => {
  it("returns empty array when no data stored", () => {
    expect(loadSavedQueries("cluster-1")).toEqual([]);
  });

  it("round-trips saved query data", () => {
    const queries = addSavedQuery([], {
      name: "Test",
      method: "GET",
      endpoint: "/t",
      body: "",
    });
    saveSavedQueries("cluster-1", queries);
    const loaded = loadSavedQueries("cluster-1");
    expect(loaded).toEqual(queries);
  });

  it("handles invalid JSON gracefully", () => {
    store["indexlens_rest_saved_bad"] = "{{{";
    expect(loadSavedQueries("bad")).toEqual([]);
  });
});
