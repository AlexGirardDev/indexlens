import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildExportPayload,
  parseIndexLensPayload,
  parseElasticvuePayload,
  mergeClusters,
  mergeSavedQueries,
  INDEXLENS_EXPORT_VERSION,
} from "./config-transfer";
import type { ClusterConfig } from "@/types/cluster";
import type { SavedQuery } from "@/lib/rest-query-storage";

// ---------------------------------------------------------------------------
// Mock crypto.randomUUID for deterministic tests
// ---------------------------------------------------------------------------

let uuidCounter = 0;
beforeEach(() => {
  uuidCounter = 0;
  vi.stubGlobal("crypto", {
    ...globalThis.crypto,
    randomUUID: () => `test-uuid-${++uuidCounter}`,
  });
});

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeCluster(overrides?: Partial<ClusterConfig>): ClusterConfig {
  return {
    id: "c1",
    name: "Dev Cluster",
    url: "http://localhost:9200",
    auth: { type: "none" },
    color: "#ef4444",
    ...overrides,
  };
}

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
// buildExportPayload
// ---------------------------------------------------------------------------

describe("buildExportPayload", () => {
  it("produces a versioned payload", () => {
    const clusters = [makeCluster()];
    const savedQueries = { c1: [makeSavedQuery()] };
    const payload = buildExportPayload(clusters, savedQueries);

    expect(payload.version).toBe(INDEXLENS_EXPORT_VERSION);
    expect(payload.clusters).toEqual(clusters);
    expect(payload.savedQueries).toEqual(savedQueries);
    expect(payload.exportedAt).toBeTruthy();
  });

  it("handles empty state", () => {
    const payload = buildExportPayload([], {});
    expect(payload.clusters).toEqual([]);
    expect(payload.savedQueries).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// parseIndexLensPayload
// ---------------------------------------------------------------------------

describe("parseIndexLensPayload", () => {
  it("parses a valid payload", () => {
    const clusters = [makeCluster()];
    const savedQueries = { c1: [makeSavedQuery()] };
    const raw = {
      version: INDEXLENS_EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      clusters,
      savedQueries,
    };

    const result = parseIndexLensPayload(raw);
    expect(result.clusters).toEqual(clusters);
    expect(result.savedQueries).toEqual(savedQueries);
    expect(result.warnings).toHaveLength(0);
  });

  it("throws on non-object input", () => {
    expect(() => parseIndexLensPayload("bad")).toThrow("expected an object");
    expect(() => parseIndexLensPayload(null)).toThrow("expected an object");
  });

  it("throws on wrong version", () => {
    expect(() => parseIndexLensPayload({ version: 99 })).toThrow("Unsupported");
  });

  it("skips invalid clusters with warnings", () => {
    const raw = {
      version: INDEXLENS_EXPORT_VERSION,
      clusters: [makeCluster(), { name: "bad" }, "not an object"],
      savedQueries: {},
    };
    const result = parseIndexLensPayload(raw);
    expect(result.clusters).toHaveLength(1);
    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
  });

  it("skips invalid saved queries with warnings", () => {
    const raw = {
      version: INDEXLENS_EXPORT_VERSION,
      clusters: [],
      savedQueries: {
        c1: [makeSavedQuery(), { bad: true }],
        c2: "not-an-array",
      },
    };
    const result = parseIndexLensPayload(raw);
    expect(result.savedQueries.c1).toHaveLength(1);
    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
  });

  it("handles all auth types", () => {
    const clusters = [
      makeCluster({ id: "a", auth: { type: "none" } }),
      makeCluster({ id: "b", auth: { type: "basic", username: "u", password: "p" } }),
      makeCluster({ id: "c", auth: { type: "apikey", apiKey: "key" } }),
      makeCluster({ id: "d", auth: { type: "bearer", token: "tok" } }),
    ];
    const raw = {
      version: INDEXLENS_EXPORT_VERSION,
      clusters,
      savedQueries: {},
    };
    const result = parseIndexLensPayload(raw);
    expect(result.clusters).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// parseElasticvuePayload
// ---------------------------------------------------------------------------

describe("parseElasticvuePayload", () => {
  const SAMPLE_ELASTICVUE = {
    version: "1.13.0",
    store: {
      connection: {
        clusters: [
          {
            name: "NTX - Dev",
            uri: "https://ntx-dev.es.us-east-2.aws.elastic-cloud.com",
            uuid: "uPAWf-yDTD2QVjCoQoJ2eQ",
            auth: {
              authType: "basicAuth",
              authData: { username: "elastic", password: "secret" },
            },
          },
          {
            name: "Local",
            uri: "http://localhost:9200",
            uuid: "NNZJHxSgS8qqekQDJrTx7A",
            auth: { authType: "none", authData: {} },
          },
        ],
      },
    },
    idb: {
      "uPAWf-yDTD2QVjCoQoJ2eQ": {
        restQuerySavedQueries: [
          { method: "POST", path: "/index/_search", body: '{"query":{"match_all":{}}}', id: 1 },
          { method: "GET", path: "/_cat/health", body: "", id: 2 },
        ],
      },
      "NNZJHxSgS8qqekQDJrTx7A": {
        restQuerySavedQueries: [],
      },
    },
  };

  it("parses clusters from Elasticvue format", () => {
    const result = parseElasticvuePayload(SAMPLE_ELASTICVUE);
    expect(result.clusters).toHaveLength(2);

    expect(result.clusters[0].name).toBe("NTX - Dev");
    expect(result.clusters[0].url).toBe("https://ntx-dev.es.us-east-2.aws.elastic-cloud.com");
    expect(result.clusters[0].auth).toEqual({
      type: "basic",
      username: "elastic",
      password: "secret",
    });

    expect(result.clusters[1].name).toBe("Local");
    expect(result.clusters[1].url).toBe("http://localhost:9200");
    expect(result.clusters[1].auth).toEqual({ type: "none" });
  });

  it("assigns deterministic colors to clusters", () => {
    const result = parseElasticvuePayload(SAMPLE_ELASTICVUE);
    expect(result.clusters[0].color).toBe("#ef4444"); // index 0 → red
    expect(result.clusters[1].color).toBe("#f97316"); // index 1 → orange
  });

  it("maps saved queries to matching cluster IDs", () => {
    const result = parseElasticvuePayload(SAMPLE_ELASTICVUE);
    const firstClusterId = result.clusters[0].id;

    const queries = result.savedQueries[firstClusterId];
    expect(queries).toHaveLength(2);
    expect(queries[0].method).toBe("POST");
    expect(queries[0].endpoint).toBe("/index/_search");
    expect(queries[1].method).toBe("GET");
    expect(queries[1].endpoint).toBe("/_cat/health");
  });

  it("generates query names from method + path", () => {
    const result = parseElasticvuePayload(SAMPLE_ELASTICVUE);
    const firstClusterId = result.clusters[0].id;
    const queries = result.savedQueries[firstClusterId];
    expect(queries[0].name).toBe("POST /index/_search");
  });

  it("skips clusters without URL", () => {
    const data = {
      store: { connection: { clusters: [{ name: "Bad", uuid: "x" }] } },
      idb: {},
    };
    const result = parseElasticvuePayload(data);
    expect(result.clusters).toHaveLength(0);
    expect(result.warnings).toContain('Skipped cluster "Bad": no URL');
  });

  it("handles missing idb section", () => {
    const data = {
      store: {
        connection: {
          clusters: [{ name: "Test", uri: "http://localhost:9200", uuid: "x" }],
        },
      },
    };
    const result = parseElasticvuePayload(data);
    expect(result.clusters).toHaveLength(1);
    expect(Object.keys(result.savedQueries)).toHaveLength(0);
  });

  it("handles missing store section", () => {
    const result = parseElasticvuePayload({});
    expect(result.clusters).toHaveLength(0);
    expect(result.warnings).toContain("No clusters found in Elasticvue config");
  });

  it("throws on non-object input", () => {
    expect(() => parseElasticvuePayload("bad")).toThrow("expected an object");
  });

  it("strips trailing slashes from URLs", () => {
    const data = {
      store: {
        connection: {
          clusters: [{ name: "Test", uri: "http://localhost:9200///", uuid: "x" }],
        },
      },
      idb: {},
    };
    const result = parseElasticvuePayload(data);
    expect(result.clusters[0].url).toBe("http://localhost:9200");
  });

  it("maps unknown auth types to none", () => {
    const data = {
      store: {
        connection: {
          clusters: [
            {
              name: "Test",
              uri: "http://localhost:9200",
              uuid: "x",
              auth: { authType: "customSso", authData: {} },
            },
          ],
        },
      },
      idb: {},
    };
    const result = parseElasticvuePayload(data);
    expect(result.clusters[0].auth).toEqual({ type: "none" });
  });
});

// ---------------------------------------------------------------------------
// mergeClusters
// ---------------------------------------------------------------------------

describe("mergeClusters", () => {
  it("merges non-duplicate clusters", () => {
    const existing = [makeCluster({ id: "c1", name: "A", url: "http://a:9200" })];
    const incoming = [makeCluster({ id: "c2", name: "B", url: "http://b:9200" })];

    const { merged, added, skipped } = mergeClusters(existing, incoming);
    expect(merged).toHaveLength(2);
    expect(added).toBe(1);
    expect(skipped).toBe(0);
  });

  it("skips duplicates based on url + name + auth type", () => {
    const c = makeCluster({ name: "Dev", url: "http://localhost:9200", auth: { type: "none" } });
    const dup = makeCluster({ id: "other-id", name: "Dev", url: "http://localhost:9200", auth: { type: "none" } });

    const { merged, added, skipped } = mergeClusters([c], [dup]);
    expect(merged).toHaveLength(1);
    expect(added).toBe(0);
    expect(skipped).toBe(1);
  });

  it("is case-insensitive for URL and name", () => {
    const c = makeCluster({ name: "Dev", url: "http://Localhost:9200" });
    const dup = makeCluster({ id: "x", name: "dev", url: "http://localhost:9200" });

    const { skipped } = mergeClusters([c], [dup]);
    expect(skipped).toBe(1);
  });

  it("treats different auth types as different clusters", () => {
    const c1 = makeCluster({ name: "Dev", url: "http://localhost:9200", auth: { type: "none" } });
    const c2 = makeCluster({
      id: "c2",
      name: "Dev",
      url: "http://localhost:9200",
      auth: { type: "basic", username: "u", password: "p" },
    });

    const { merged, added } = mergeClusters([c1], [c2]);
    expect(merged).toHaveLength(2);
    expect(added).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// mergeSavedQueries
// ---------------------------------------------------------------------------

describe("mergeSavedQueries", () => {
  it("merges non-duplicate queries", () => {
    const existing = [makeSavedQuery({ id: "q1", method: "GET", endpoint: "/a", body: "" })];
    const incoming = [makeSavedQuery({ id: "q2", method: "POST", endpoint: "/b", body: "{}" })];

    const { merged, added, skipped } = mergeSavedQueries(existing, incoming);
    expect(merged).toHaveLength(2);
    expect(added).toBe(1);
    expect(skipped).toBe(0);
  });

  it("skips duplicates based on method + endpoint + body", () => {
    const q = makeSavedQuery({ method: "GET", endpoint: "/health", body: "" });
    const dup = makeSavedQuery({ id: "q2", name: "Different Name", method: "GET", endpoint: "/health", body: "" });

    const { merged, skipped } = mergeSavedQueries([q], [dup]);
    expect(merged).toHaveLength(1);
    expect(skipped).toBe(1);
  });

  it("allows same endpoint with different methods", () => {
    const q1 = makeSavedQuery({ method: "GET", endpoint: "/test", body: "" });
    const q2 = makeSavedQuery({ id: "q2", method: "POST", endpoint: "/test", body: "" });

    const { merged, added } = mergeSavedQueries([q1], [q2]);
    expect(merged).toHaveLength(2);
    expect(added).toBe(1);
  });

  it("handles empty existing list", () => {
    const incoming = [makeSavedQuery()];
    const { merged, added } = mergeSavedQueries([], incoming);
    expect(merged).toHaveLength(1);
    expect(added).toBe(1);
  });
});
