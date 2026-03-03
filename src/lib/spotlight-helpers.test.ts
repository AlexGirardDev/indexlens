import { describe, it, expect } from "vitest";
import {
  buildNavItems,
  buildIndexItems,
  buildSavedQueryItems,
  resolveRestPreload,
  filterSpotlightItems,
} from "./spotlight-helpers";
import type { SpotlightItem } from "./spotlight-helpers";
import type { SavedQuery } from "./rest-query-storage";

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function makeSavedQuery(overrides?: Partial<SavedQuery>): SavedQuery {
  return {
    id: "q1",
    name: "Health Check",
    method: "GET",
    endpoint: "/_cluster/health",
    body: "",
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildNavItems
// ---------------------------------------------------------------------------

describe("buildNavItems", () => {
  it("returns the three navigation pages", () => {
    const items = buildNavItems();
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.page)).toEqual(["dashboard", "indices", "rest"]);
    expect(items.every((i) => i.type === "nav")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildIndexItems
// ---------------------------------------------------------------------------

describe("buildIndexItems", () => {
  it("maps raw indices to spotlight items", () => {
    const items = buildIndexItems([
      { name: "logs-2024", aliases: ["logs"] },
      { name: "metrics", aliases: [] },
    ]);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      type: "index",
      name: "logs-2024",
      aliases: ["logs"],
    });
    expect(items[1].aliases).toEqual([]);
  });

  it("returns empty array for empty input", () => {
    expect(buildIndexItems([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildSavedQueryItems
// ---------------------------------------------------------------------------

describe("buildSavedQueryItems", () => {
  it("wraps saved queries in spotlight items", () => {
    const query = makeSavedQuery();
    const items = buildSavedQueryItems([query]);
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("saved-query");
    expect(items[0].query).toBe(query);
  });
});

// ---------------------------------------------------------------------------
// resolveRestPreload
// ---------------------------------------------------------------------------

describe("resolveRestPreload", () => {
  it("extracts method, endpoint, and body from a saved query", () => {
    const query = makeSavedQuery({
      method: "POST",
      endpoint: "/my-index/_search",
      body: '{"query":{"match_all":{}}}',
    });
    const result = resolveRestPreload(query);
    expect(result).toEqual({
      method: "POST",
      endpoint: "/my-index/_search",
      body: '{"query":{"match_all":{}}}',
    });
  });

  it("handles empty body", () => {
    const query = makeSavedQuery({ method: "GET", endpoint: "/_cat/health", body: "" });
    const result = resolveRestPreload(query);
    expect(result.body).toBe("");
  });

  it("does not include extra SavedQuery fields (id, name, timestamps)", () => {
    const query = makeSavedQuery();
    const result = resolveRestPreload(query);
    const keys = Object.keys(result).sort();
    expect(keys).toEqual(["body", "endpoint", "method"]);
  });
});

// ---------------------------------------------------------------------------
// filterSpotlightItems
// ---------------------------------------------------------------------------

describe("filterSpotlightItems", () => {
  const allItems: SpotlightItem[] = [
    ...buildNavItems(),
    ...buildIndexItems([
      { name: "logs-2024", aliases: ["current-logs"] },
      { name: "metrics", aliases: [] },
    ]),
    ...buildSavedQueryItems([
      makeSavedQuery({ id: "q1", name: "Health Check", method: "GET", endpoint: "/_cluster/health" }),
      makeSavedQuery({ id: "q2", name: "Search Logs", method: "POST", endpoint: "/logs-2024/_search" }),
    ]),
  ];

  it("returns all items when search is empty", () => {
    expect(filterSpotlightItems(allItems, "")).toEqual(allItems);
  });

  it("filters nav items by label", () => {
    const result = filterSpotlightItems(allItems, "dash");
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("nav");
    if (result[0].type === "nav") {
      expect(result[0].page).toBe("dashboard");
    }
  });

  it("filters index items by name", () => {
    const result = filterSpotlightItems(allItems, "metrics");
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("index");
  });

  it("filters index items by alias", () => {
    const result = filterSpotlightItems(allItems, "current-logs");
    expect(result).toHaveLength(1);
    if (result[0].type === "index") {
      expect(result[0].name).toBe("logs-2024");
    }
  });

  it("filters saved queries by name", () => {
    const result = filterSpotlightItems(allItems, "Health");
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("saved-query");
  });

  it("filters saved queries by endpoint", () => {
    const result = filterSpotlightItems(allItems, "_cluster");
    expect(result).toHaveLength(1);
    if (result[0].type === "saved-query") {
      expect(result[0].query.name).toBe("Health Check");
    }
  });

  it("is case insensitive", () => {
    const result = filterSpotlightItems(allItems, "LOGS");
    // Should match index "logs-2024", alias "current-logs", and saved query "Search Logs" / endpoint "/logs-2024/_search"
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it("returns empty when nothing matches", () => {
    const result = filterSpotlightItems(allItems, "zzz-nonexistent");
    expect(result).toEqual([]);
  });
});
