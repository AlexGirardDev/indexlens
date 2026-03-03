// ---------------------------------------------------------------------------
// Shared helpers for document operations
// ---------------------------------------------------------------------------

export interface BulkDeleteTarget {
  _index: string;
  _id: string;
  _seq_no?: number;
  _primary_term?: number;
}

/**
 * Stable composite key for a search hit that avoids collisions when documents
 * from different indices share the same `_id`.
 */
export function hitKey(hit: { _index: string; _id: string }): string {
  return `${hit._index}\0${hit._id}`;
}

/**
 * Build an NDJSON body for the Elasticsearch `_bulk` API to delete the
 * given documents. Includes optimistic concurrency fields when available.
 */
export function buildBulkDeleteBody(targets: BulkDeleteTarget[]): string {
  const lines: string[] = [];
  for (const t of targets) {
    const action: Record<string, unknown> = {
      _index: t._index,
      _id: t._id,
    };
    if (t._seq_no !== undefined && t._primary_term !== undefined) {
      action.if_seq_no = t._seq_no;
      action.if_primary_term = t._primary_term;
    }
    lines.push(JSON.stringify({ delete: action }));
  }
  return lines.join("\n") + "\n";
}
