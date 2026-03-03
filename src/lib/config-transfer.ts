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
import {
  clearBuffer,
  decodeSalt,
  deriveKey,
  encodeSalt,
  encryptPayload,
  decryptPayload,
  generateSalt,
  type EncryptedPayload,
} from "@/security/crypto";
import {
  CONFIG_TRANSFER_KDF_VERSION,
  CONFIG_TRANSFER_VERSION,
  PBKDF2_ITERATIONS,
} from "@/security/constants";

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

export const INDEXLENS_ENCRYPTED_EXPORT_FORMAT = "indexlens-export-encrypted";

export interface IndexLensEncryptedExportEnvelope {
  format: typeof INDEXLENS_ENCRYPTED_EXPORT_FORMAT;
  version: number;
  exportedAt: string;
  kdf: {
    algorithm: "PBKDF2";
    hash: "SHA-256";
    iterations: number;
    salt: string;
    version: number;
  };
  ciphertext: EncryptedPayload;
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
// Encrypt/decrypt IndexLens transfer envelopes
// ---------------------------------------------------------------------------

function getImportErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Import failed";
}

export function parseEncryptedExportEnvelope(data: unknown): IndexLensEncryptedExportEnvelope {
  if (!isRecord(data)) {
    throw new Error("Invalid IndexLens config: expected an object");
  }

  if (data.format !== INDEXLENS_ENCRYPTED_EXPORT_FORMAT) {
    if (data.format === "indexlens-export") {
      throw new Error("Unencrypted IndexLens exports are no longer supported. Re-export with encryption.");
    }
    throw new Error(`Invalid IndexLens export format: ${String(data.format)}`);
  }

  if (data.version !== CONFIG_TRANSFER_VERSION) {
    throw new Error(
      `Unsupported encrypted IndexLens config version: ${String(data.version)} (expected ${CONFIG_TRANSFER_VERSION})`,
    );
  }

  if (typeof data.exportedAt !== "string") {
    throw new Error("Invalid encrypted IndexLens config: missing exportedAt timestamp");
  }

  const kdf = data.kdf;
  if (!isRecord(kdf)) {
    throw new Error("Invalid encrypted IndexLens config: missing kdf metadata");
  }

  if (kdf.algorithm !== "PBKDF2" || kdf.hash !== "SHA-256") {
    throw new Error("Unsupported encrypted IndexLens config kdf algorithm");
  }

  if (kdf.version !== CONFIG_TRANSFER_KDF_VERSION) {
    throw new Error(
      `Unsupported encrypted IndexLens config kdf version: ${String(kdf.version)} (expected ${CONFIG_TRANSFER_KDF_VERSION})`,
    );
  }

  if (
    typeof kdf.iterations !== "number"
    || !Number.isSafeInteger(kdf.iterations)
    || kdf.iterations <= 0
  ) {
    throw new Error("Invalid encrypted IndexLens config: kdf.iterations must be a positive integer");
  }

  if (typeof kdf.salt !== "string" || kdf.salt.length === 0) {
    throw new Error("Invalid encrypted IndexLens config: kdf.salt must be a non-empty base64 string");
  }

  const ciphertext = data.ciphertext;
  if (!isRecord(ciphertext)) {
    throw new Error("Invalid encrypted IndexLens config: missing ciphertext envelope");
  }

  if (ciphertext.v !== CONFIG_TRANSFER_VERSION) {
    throw new Error(
      `Unsupported encrypted IndexLens ciphertext version: ${String(ciphertext.v)} (expected ${CONFIG_TRANSFER_VERSION})`,
    );
  }

  if (typeof ciphertext.iv !== "string" || ciphertext.iv.length === 0) {
    throw new Error("Invalid encrypted IndexLens config: ciphertext.iv must be a non-empty base64 string");
  }

  if (typeof ciphertext.data !== "string" || ciphertext.data.length === 0) {
    throw new Error("Invalid encrypted IndexLens config: ciphertext.data must be a non-empty base64 string");
  }

  return {
    format: INDEXLENS_ENCRYPTED_EXPORT_FORMAT,
    version: CONFIG_TRANSFER_VERSION,
    exportedAt: data.exportedAt,
    kdf: {
      algorithm: "PBKDF2",
      hash: "SHA-256",
      iterations: kdf.iterations,
      salt: kdf.salt,
      version: CONFIG_TRANSFER_KDF_VERSION,
    },
    ciphertext: {
      v: CONFIG_TRANSFER_VERSION,
      iv: ciphertext.iv,
      data: ciphertext.data,
    },
  };
}

export async function buildEncryptedExportEnvelope(
  payload: IndexLensExportPayload,
  passphrase: string,
): Promise<IndexLensEncryptedExportEnvelope> {
  if (passphrase.length === 0) {
    throw new Error("A passphrase is required to export configuration");
  }

  const salt = generateSalt();
  try {
    const key = await deriveKey(passphrase, salt);
    const ciphertext = await encryptPayload(key, JSON.stringify(payload));

    return {
      format: INDEXLENS_ENCRYPTED_EXPORT_FORMAT,
      version: CONFIG_TRANSFER_VERSION,
      exportedAt: payload.exportedAt,
      kdf: {
        algorithm: "PBKDF2",
        hash: "SHA-256",
        iterations: PBKDF2_ITERATIONS,
        salt: encodeSalt(salt),
        version: CONFIG_TRANSFER_KDF_VERSION,
      },
      ciphertext: {
        v: ciphertext.v,
        iv: ciphertext.iv,
        data: ciphertext.data,
      },
    };
  } finally {
    clearBuffer(salt);
  }
}

export async function decryptExportEnvelope(
  envelope: IndexLensEncryptedExportEnvelope,
  passphrase: string,
): Promise<IndexLensExportPayload> {
  if (passphrase.length === 0) {
    throw new Error("Passphrase is required to import an encrypted IndexLens configuration");
  }

  let salt: Uint8Array<ArrayBuffer> | null = null;
  try {
    salt = decodeSalt(envelope.kdf.salt);
    const key = await deriveKey(passphrase, salt, envelope.kdf.iterations);
    const plaintext = await decryptPayload(key, envelope.ciphertext);

    let parsed: unknown;
    try {
      parsed = JSON.parse(plaintext);
    } catch {
      throw new Error("Invalid encrypted IndexLens config: decrypted payload is not valid JSON");
    }

    const parsedPayload = parseIndexLensPayload(parsed);
    return {
      version: INDEXLENS_EXPORT_VERSION,
      exportedAt:
        isRecord(parsed) && typeof parsed.exportedAt === "string"
          ? parsed.exportedAt
          : new Date().toISOString(),
      clusters: parsedPayload.clusters,
      savedQueries: parsedPayload.savedQueries,
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === "OperationError") {
      throw new Error(
        "Unable to decrypt IndexLens config. The passphrase is incorrect or the file is corrupted.",
      );
    }
    throw new Error(getImportErrorMessage(error));
  } finally {
    if (salt) {
      clearBuffer(salt);
    }
  }
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
