// ---------------------------------------------------------------------------
// Export helpers – PIT-based pagination + streaming to file
// ---------------------------------------------------------------------------

import { esRequest } from "@/lib/es-client";
import type { ClusterConfig } from "@/types/cluster";

// ---------------------------------------------------------------------------
// Minimal type declarations for the File System Access API
// ---------------------------------------------------------------------------

interface FilePickerAcceptType {
  description: string;
  accept: Record<string, string[]>;
}

interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: FilePickerAcceptType[];
}

interface FileSystemWritableFileStream extends WritableStream {
  write(data: string | BufferSource | Blob): Promise<void>;
  close(): Promise<void>;
}

interface FileSystemFileHandle {
  createWritable(): Promise<FileSystemWritableFileStream>;
}

declare function showSaveFilePicker(
  options?: SaveFilePickerOptions,
): Promise<FileSystemFileHandle>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExportFormat = "jsonl" | "json-array";

export interface ExportProgress {
  exported: number;
  total: number;
}

export interface ExportOptions {
  cluster: ClusterConfig;
  indexPattern: string;
  query: object;
  sort?: Array<Record<string, unknown>>;
  format: ExportFormat;
  onProgress: (progress: ExportProgress) => void;
  signal: AbortSignal;
}

// ---------------------------------------------------------------------------
// Index pattern encoding (shared with documents-page)
// ---------------------------------------------------------------------------

/**
 * URL-encode an index pattern while preserving wildcards and commas.
 */
export function encodeIndexPattern(pattern: string): string {
  return pattern
    .split(",")
    .map((p) => encodeURIComponent(p.trim()).replace(/%2A/g, "*"))
    .join(",");
}

// ---------------------------------------------------------------------------
// PIT lifecycle
// ---------------------------------------------------------------------------

interface PitOpenResponse {
  id: string;
}

export async function openPit(
  cluster: ClusterConfig,
  indexPattern: string,
  keepAlive: string,
  signal?: AbortSignal,
): Promise<string> {
  const res = await esRequest<PitOpenResponse>(
    cluster,
    `/${encodeIndexPattern(indexPattern)}/_pit?keep_alive=${keepAlive}`,
    { method: "POST", signal },
  );
  return res.id;
}

export async function closePit(
  cluster: ClusterConfig,
  pitId: string,
): Promise<void> {
  try {
    await esRequest(cluster, "/_pit", {
      method: "DELETE",
      body: JSON.stringify({ id: pitId }),
    });
  } catch {
    // best-effort cleanup — swallow errors
  }
}

// ---------------------------------------------------------------------------
// Main export function
// ---------------------------------------------------------------------------

interface SearchHit {
  _source: Record<string, unknown>;
  sort?: unknown[];
}

interface PitSearchResponse {
  hits: {
    total: { value: number };
    hits: SearchHit[];
  };
  pit_id?: string;
}

const PAGE_SIZE = 1000;

export async function exportDocuments(options: ExportOptions): Promise<void> {
  const { cluster, indexPattern, query, sort, format, onProgress, signal } =
    options;

  // 1. Let the user pick a file location
  let fileHandle: FileSystemFileHandle;
  try {
    fileHandle = await showSaveFilePicker({
      suggestedName: format === "jsonl" ? "export.jsonl" : "export.json",
      types:
        format === "jsonl"
          ? [{ description: "JSONL", accept: { "application/jsonl": [".jsonl"] } }]
          : [{ description: "JSON", accept: { "application/json": [".json"] } }],
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") return;
    throw err;
  }

  const writable = await fileHandle.createWritable();
  let pitId: string | undefined;

  // Build sort with tiebreaker
  const sortClause: Array<Record<string, unknown>> = [
    ...(sort ?? []),
    { _shard_doc: "asc" },
  ];

  try {
    // 2. Open PIT
    pitId = await openPit(cluster, indexPattern, "1m", signal);

    // 3. Get total count
    const countRes = await esRequest<PitSearchResponse>(cluster, "/_search", {
      method: "POST",
      body: JSON.stringify({
        size: 0,
        query,
        pit: { id: pitId, keep_alive: "1m" },
      }),
      signal,
    });
    if (countRes.pit_id) pitId = countRes.pit_id;

    const total = countRes.hits.total.value;
    onProgress({ exported: 0, total });

    // 4. Paginate with search_after
    let exported = 0;
    let searchAfter: unknown[] | undefined;
    let firstDoc = true;

    if (format === "json-array") {
      await writable.write("[\n");
    }

    while (true) {
      if (signal.aborted) {
        throw new DOMException("Export aborted", "AbortError");
      }

      const body: Record<string, unknown> = {
        size: PAGE_SIZE,
        query,
        sort: sortClause,
        pit: { id: pitId, keep_alive: "1m" },
      };
      if (searchAfter) {
        body.search_after = searchAfter;
      }

      const pageRes = await esRequest<PitSearchResponse>(cluster, "/_search", {
        method: "POST",
        body: JSON.stringify(body),
        signal,
      });
      if (pageRes.pit_id) pitId = pageRes.pit_id;

      const hits = pageRes.hits.hits;
      if (hits.length === 0) break;

      // Write documents to file
      for (const hit of hits) {
        const line = JSON.stringify(hit._source);
        if (format === "jsonl") {
          await writable.write(line + "\n");
        } else {
          // JSON array format
          if (!firstDoc) {
            await writable.write(",\n");
          }
          await writable.write(line);
          firstDoc = false;
        }
      }

      exported += hits.length;
      onProgress({ exported, total });

      // Prepare next page
      const lastHit = hits[hits.length - 1];
      searchAfter = lastHit.sort;

      if (hits.length < PAGE_SIZE) break;
    }

    if (format === "json-array") {
      await writable.write("\n]\n");
    }

    await writable.close();
  } catch (err) {
    // Close writable on error (best-effort)
    try {
      await writable.close();
    } catch {
      // ignore close errors
    }
    throw err;
  } finally {
    if (pitId) {
      await closePit(cluster, pitId);
    }
  }
}
