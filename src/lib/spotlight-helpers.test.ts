import { describe, it, expect } from "vitest";
import {
  buildNavItems,
  buildIndexItems,
  buildSavedQueryItems,
  buildClusterItems,
  resolveRestPreload,
  filterSpotlightItems,
  parseSpotlightInput,
  filterCommands,
  buildCommandInputValue,
  SPOTLIGHT_COMMANDS,
} from "./spotlight-helpers";
import type { SpotlightItem } from "./spotlight-helpers";
import type { SavedQuery } from "./rest-query-storage";
import type { ClusterConfig } from "@/types/cluster";

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

function makeCluster(overrides?: Partial<ClusterConfig>): ClusterConfig {
  return {
    id: "c1",
    name: "Production",
    url: "https://es-prod.example.com",
    auth: { type: "none" },
    color: "#3b82f6",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildNavItems
// ---------------------------------------------------------------------------

describe("buildNavItems", () => {
  it("returns the four navigation pages", () => {
    const items = buildNavItems();
    expect(items).toHaveLength(4);
    expect(items.map((i) => i.page)).toEqual(["dashboard", "indices", "rest", "settings"]);
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
// buildClusterItems
// ---------------------------------------------------------------------------

describe("buildClusterItems", () => {
  const clusters = [
    makeCluster({ id: "c1", name: "Production" }),
    makeCluster({ id: "c2", name: "Staging" }),
    makeCluster({ id: "c3", name: "Development" }),
  ];

  it("returns all clusters except the active one", () => {
    const items = buildClusterItems(clusters, "c1");
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.cluster.id)).toEqual(["c2", "c3"]);
    expect(items.every((i) => i.type === "cluster")).toBe(true);
  });

  it("returns all clusters when activeClusterId is null", () => {
    const items = buildClusterItems(clusters, null);
    expect(items).toHaveLength(3);
  });

  it("returns empty array for empty input", () => {
    expect(buildClusterItems([], "c1")).toEqual([]);
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
    ...buildClusterItems(
      [
        makeCluster({ id: "c1", name: "Production", url: "https://es-prod.example.com" }),
        makeCluster({ id: "c2", name: "Staging", url: "https://es-staging.example.com" }),
      ],
      null,
    ),
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

  it("filters settings nav item by label", () => {
    const result = filterSpotlightItems(allItems, "settings");
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("nav");
    if (result[0].type === "nav") {
      expect(result[0].page).toBe("settings");
    }
  });

  it("filters cluster items by name", () => {
    const result = filterSpotlightItems(allItems, "Staging");
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("cluster");
    if (result[0].type === "cluster") {
      expect(result[0].cluster.name).toBe("Staging");
    }
  });

  it("filters cluster items by URL", () => {
    const result = filterSpotlightItems(allItems, "es-prod");
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("cluster");
    if (result[0].type === "cluster") {
      expect(result[0].cluster.name).toBe("Production");
    }
  });

  it("returns empty when nothing matches", () => {
    const result = filterSpotlightItems(allItems, "zzz-nonexistent");
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseSpotlightInput
// ---------------------------------------------------------------------------

describe("parseSpotlightInput", () => {
  it("returns search mode for normal text", () => {
    const state = parseSpotlightInput("dashboard");
    expect(state).toEqual({ mode: "search", search: "dashboard" });
  });

  it("returns search mode for empty string", () => {
    const state = parseSpotlightInput("");
    expect(state).toEqual({ mode: "search", search: "" });
  });

  it("returns command-list mode for just '>'", () => {
    const state = parseSpotlightInput(">");
    expect(state).toEqual({ mode: "command-list", filter: "" });
  });

  it("returns command-list mode for '> ' (with space)", () => {
    const state = parseSpotlightInput("> ");
    expect(state).toEqual({ mode: "command-list", filter: "" });
  });

  it("returns command-list mode with filter for partial command text", () => {
    const state = parseSpotlightInput("> Sel");
    expect(state).toEqual({ mode: "command-list", filter: "Sel" });
  });

  it("returns command-list mode for unrecognized command text", () => {
    const state = parseSpotlightInput("> Unknown Command");
    expect(state).toEqual({ mode: "command-list", filter: "Unknown Command" });
  });

  it("returns command-active mode for '> Select Cluster'", () => {
    const state = parseSpotlightInput("> Select Cluster");
    expect(state).toEqual({
      mode: "command-active",
      command: SPOTLIGHT_COMMANDS[0],
      filter: "",
    });
  });

  it("returns command-active mode for '> Select Cluster ' (with trailing space)", () => {
    const state = parseSpotlightInput("> Select Cluster ");
    expect(state).toEqual({
      mode: "command-active",
      command: SPOTLIGHT_COMMANDS[0],
      filter: "",
    });
  });

  it("returns command-active mode with filter for '> Select Cluster prod'", () => {
    const state = parseSpotlightInput("> Select Cluster prod");
    expect(state).toEqual({
      mode: "command-active",
      command: SPOTLIGHT_COMMANDS[0],
      filter: "prod",
    });
  });

  it("is case-insensitive for command matching", () => {
    const state = parseSpotlightInput("> select cluster");
    expect(state.mode).toBe("command-active");
  });

  it("handles leading whitespace before '>'", () => {
    const state = parseSpotlightInput("  > ");
    expect(state).toEqual({ mode: "command-list", filter: "" });
  });
});

// ---------------------------------------------------------------------------
// filterCommands
// ---------------------------------------------------------------------------

describe("filterCommands", () => {
  it("returns all commands when filter is empty", () => {
    const result = filterCommands(SPOTLIGHT_COMMANDS, "");
    expect(result).toEqual(SPOTLIGHT_COMMANDS);
  });

  it("filters commands by label substring", () => {
    const result = filterCommands(SPOTLIGHT_COMMANDS, "cluster");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("select-cluster");
  });

  it("is case-insensitive", () => {
    const result = filterCommands(SPOTLIGHT_COMMANDS, "SELECT");
    expect(result).toHaveLength(1);
  });

  it("returns empty when nothing matches", () => {
    const result = filterCommands(SPOTLIGHT_COMMANDS, "zzz");
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildCommandInputValue
// ---------------------------------------------------------------------------

describe("buildCommandInputValue", () => {
  it("builds '> Select Cluster ' for the Select Cluster command", () => {
    const value = buildCommandInputValue(SPOTLIGHT_COMMANDS[0]);
    expect(value).toBe("> Select Cluster ");
  });

  it("ends with a trailing space", () => {
    const value = buildCommandInputValue({ id: "test", label: "Test" });
    expect(value.endsWith(" ")).toBe(true);
  });
});
