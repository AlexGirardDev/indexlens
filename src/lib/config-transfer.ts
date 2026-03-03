/**
 * Config transfer module for IndexLens import/export.
 *
 * Handles:
 * - Building IndexLens export payloads from current app state
 * - Validating and parsing imported IndexLens payloads
 * - Parsing Elasticvue JSON exports and mapping to IndexLens types
 * - Merge/dedupe behavior for imported clusters and saved queries
 */

import type { ClusterConfig, AuthConfig } from "@/types/cluster";
import { CLUSTER_COLORS } from "@/types/cluster";
import type { SavedQuery } from "@/lib/rest-query-storage";
import { generateId } from "@/lib/rest-query-storage";

// ---------------------------------------------------------------------------
// IndexLens export schema
// ---------------------------------------------------------------------------

export const INDEXLENS_EXPORT_VERSION = 1;

export interface IndexLensExportPayload {
  version: number;
  exportedAt: string;
  clusters: ClusterConfig[];
  savedQueries: Record<string, SavedQuery[]>;
}

// ---------------------------------------------------------------------------
// Build export payload from current app state
// ---------------------------------------------------------------------------

export function buildExportPayload(
  clusters: ClusterConfig[],
  savedQueries: Record<string, SavedQuery[]>,
): IndexLensExportPayload {
  return {
    version: INDEXLENS_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    clusters,
    savedQueries,
  };
}

// ---------------------------------------------------------------------------
// Validate and parse imported IndexLens payloads
// ---------------------------------------------------------------------------

export interface ImportResult {
  clusters: ClusterConfig[];
  savedQueries: Record<string, SavedQuery[]>;
  warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidAuthConfig(auth: unknown): auth is AuthConfig {
  if (!isRecord(auth)) return false;
  const type = auth.type;
  if (type === "none") return true;
  if (type === "basic") return typeof auth.username === "string" && typeof auth.password === "string";
  if (type === "apikey") return typeof auth.apiKey === "string";
  if (type === "bearer") return typeof auth.token === "string";
  return false;
}

function isValidCluster(c: unknown): c is ClusterConfig {
  if (!isRecord(c)) return false;
  return (
    typeof c.id === "string" &&
    typeof c.name === "string" &&
    typeof c.url === "string" &&
    typeof c.color === "string" &&
    isValidAuthConfig(c.auth)
  );
}

function isValidSavedQuery(q: unknown): q is SavedQuery {
  if (!isRecord(q)) return false;
  return (
    typeof q.id === "string" &&
    typeof q.name === "string" &&
    typeof q.method === "string" &&
    typeof q.endpoint === "string" &&
    typeof q.body === "string" &&
    typeof q.createdAt === "number" &&
    typeof q.updatedAt === "number"
  );
}

export function parseIndexLensPayload(data: unknown): ImportResult {
  const warnings: string[] = [];

  if (!isRecord(data)) {
    throw new Error("Invalid IndexLens config: expected an object");
  }

  if (data.version !== INDEXLENS_EXPORT_VERSION) {
    throw new Error(
      `Unsupported IndexLens config version: ${String(data.version)} (expected ${INDEXLENS_EXPORT_VERSION})`,
    );
  }

  const clusters: ClusterConfig[] = [];
  if (Array.isArray(data.clusters)) {
    for (const c of data.clusters) {
      if (isValidCluster(c)) {
        clusters.push(c);
      } else {
        warnings.push(`Skipped invalid cluster entry`);
      }
    }
  }

  const savedQueries: Record<string, SavedQuery[]> = {};
  if (isRecord(data.savedQueries)) {
    for (const [clusterId, queries] of Object.entries(data.savedQueries)) {
      if (Array.isArray(queries)) {
        const valid: SavedQuery[] = [];
        for (const q of queries) {
          if (isValidSavedQuery(q)) {
            valid.push(q);
          } else {
            warnings.push(`Skipped invalid saved query for cluster ${clusterId}`);
          }
        }
        if (valid.length > 0) {
          savedQueries[clusterId] = valid;
        }
      }
    }
  }

  return { clusters, savedQueries, warnings };
}

// ---------------------------------------------------------------------------
// Elasticvue import
// ---------------------------------------------------------------------------

interface ElasticvueAuth {
  authType?: string;
  authData?: Record<string, unknown>;
}

interface ElasticvueCluster {
  name?: string;
  uri?: string;
  uuid?: string;
  auth?: ElasticvueAuth;
}

interface ElasticvueSavedQuery {
  method?: string;
  path?: string;
  body?: string;
  id?: number | string;
}

function mapElasticvueAuth(auth: ElasticvueAuth | undefined): AuthConfig {
  if (!auth || auth.authType === "none" || !auth.authType) {
    return { type: "none" };
  }

  if (auth.authType === "basicAuth" && isRecord(auth.authData)) {
    const username = typeof auth.authData.username === "string" ? auth.authData.username : "";
    const password = typeof auth.authData.password === "string" ? auth.authData.password : "";
    return { type: "basic", username, password };
  }

  // Unknown auth type — default to none
  return { type: "none" };
}

function assignColor(index: number): string {
  return CLUSTER_COLORS[index % CLUSTER_COLORS.length];
}

export function parseElasticvuePayload(data: unknown): ImportResult {
  const warnings: string[] = [];
  const clusters: ClusterConfig[] = [];
  const savedQueries: Record<string, SavedQuery[]> = {};

  if (!isRecord(data)) {
    throw new Error("Invalid Elasticvue config: expected an object");
  }

  // Extract clusters from store.connection.clusters
  const store = isRecord(data.store) ? data.store : null;
  const connection = store && isRecord(store.connection) ? store.connection : null;
  const rawClusters = connection && Array.isArray(connection.clusters)
    ? (connection.clusters as unknown[])
    : [];

  if (rawClusters.length === 0) {
    warnings.push("No clusters found in Elasticvue config");
  }

  // Map from Elasticvue UUID → IndexLens cluster ID
  const uuidToId = new Map<string, string>();

  for (let i = 0; i < rawClusters.length; i++) {
    const raw = rawClusters[i] as Record<string, unknown>;
    if (!isRecord(raw)) {
      warnings.push(`Skipped invalid cluster at index ${i}`);
      continue;
    }

    const evCluster = raw as unknown as ElasticvueCluster;
    const name = typeof evCluster.name === "string" ? evCluster.name : `Cluster ${i + 1}`;
    const url = typeof evCluster.uri === "string" ? evCluster.uri.replace(/\/+$/, "") : "";
    const uuid = typeof evCluster.uuid === "string" ? evCluster.uuid : "";

    if (!url) {
      warnings.push(`Skipped cluster "${name}": no URL`);
      continue;
    }

    const id = crypto.randomUUID();
    if (uuid) {
      uuidToId.set(uuid, id);
    }

    clusters.push({
      id,
      name,
      url,
      auth: mapElasticvueAuth(evCluster.auth),
      color: assignColor(i),
    });
  }

  // Extract saved queries from idb[uuid].restQuerySavedQueries
  const idb = isRecord(data.idb) ? data.idb : null;
  if (idb) {
    for (const [uuid, clusterData] of Object.entries(idb)) {
      const clusterId = uuidToId.get(uuid);
      if (!clusterId) {
        // No matching cluster was imported for this UUID
        continue;
      }

      if (!isRecord(clusterData)) continue;
      const rawQueries = Array.isArray(clusterData.restQuerySavedQueries)
        ? (clusterData.restQuerySavedQueries as unknown[])
        : [];

      const mapped: SavedQuery[] = [];
      for (const rq of rawQueries) {
        if (!isRecord(rq)) continue;
        const evQuery = rq as unknown as ElasticvueSavedQuery;

        const method = typeof evQuery.method === "string" ? evQuery.method : "GET";
        const endpoint = typeof evQuery.path === "string" ? evQuery.path : "/";
        const body = typeof evQuery.body === "string" ? evQuery.body : "";

        const now = Date.now();
        mapped.push({
          id: generateId(),
          name: `${method} ${endpoint}`,
          method,
          endpoint,
          body,
          createdAt: now,
          updatedAt: now,
        });
      }

      if (mapped.length > 0) {
        savedQueries[clusterId] = mapped;
      }
    }
  }

  return { clusters, savedQueries, warnings };
}

// ---------------------------------------------------------------------------
// Merge / dedupe
// ---------------------------------------------------------------------------

/**
 * Create a fingerprint for a cluster based on URL + name + auth type.
 * Used for deduplication during import.
 */
function clusterFingerprint(c: ClusterConfig): string {
  return `${c.url.toLowerCase()}|${c.name.toLowerCase()}|${c.auth.type}`;
}

/**
 * Merge imported clusters with existing ones, skipping duplicates
 * based on URL + name + auth type fingerprint.
 */
export function mergeClusters(
  existing: ClusterConfig[],
  incoming: ClusterConfig[],
): { merged: ClusterConfig[]; added: number; skipped: number } {
  const seen = new Set(existing.map(clusterFingerprint));
  const merged = [...existing];
  let added = 0;
  let skipped = 0;

  for (const c of incoming) {
    const fp = clusterFingerprint(c);
    if (seen.has(fp)) {
      skipped++;
    } else {
      seen.add(fp);
      merged.push(c);
      added++;
    }
  }

  return { merged, added, skipped };
}

/**
 * Fingerprint for saved query deduplication: method + endpoint + body.
 */
function queryFingerprint(q: SavedQuery): string {
  return `${q.method}|${q.endpoint}|${q.body}`;
}

/**
 * Merge imported saved queries with existing ones per-cluster,
 * skipping duplicates based on method + endpoint + body.
 */
export function mergeSavedQueries(
  existing: SavedQuery[],
  incoming: SavedQuery[],
): { merged: SavedQuery[]; added: number; skipped: number } {
  const seen = new Set(existing.map(queryFingerprint));
  const merged = [...existing];
  let added = 0;
  let skipped = 0;

  for (const q of incoming) {
    const fp = queryFingerprint(q);
    if (seen.has(fp)) {
      skipped++;
    } else {
      seen.add(fp);
      merged.push(q);
      added++;
    }
  }

  return { merged, added, skipped };
}
