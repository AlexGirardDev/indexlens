// ---------------------------------------------------------------------------
// Shared helpers for document operations
// ---------------------------------------------------------------------------

import type { MappingField } from "@/lib/es-mapping";

// ---------------------------------------------------------------------------
// Sort types & helpers
// ---------------------------------------------------------------------------

export type SortDir = "asc" | "desc";

export interface SortState {
  field: string;
  dir: SortDir;
}

/** Non-sortable ES field types where no keyword sub-field can help. */
const NON_SORTABLE_TYPES = new Set(["text", "annotated_text", "search_as_you_type"]);

/**
 * Resolve a user-facing field name to the actual ES field path to sort on.
 *
 * - For `_id`, returns `"_id"` directly (always sortable).
 * - For `text` fields, looks for a `.keyword` (or `.raw`) sub-field.
 * - Returns `null` if the field cannot be sorted.
 */
export function resolveSortField(
  field: string,
  mappingFields: MappingField[],
): string | null {
  if (field === "_id") return "_id";

  const primary = mappingFields.find((f) => f.path === field && !f.isSubfield);

  // Field not in mapping – allow sort anyway (ES will error if truly invalid,
  // but for multi-index patterns the field may exist in some indices).
  if (!primary) return field;

  if (!NON_SORTABLE_TYPES.has(primary.type)) return field;

  // Look for a sortable sub-field (prefer .keyword, fall back to .raw)
  const keywordSub = mappingFields.find(
    (f) => f.path === `${field}.keyword` && f.isSubfield,
  );
  if (keywordSub) return keywordSub.path;

  const rawSub = mappingFields.find(
    (f) => f.path === `${field}.raw` && f.isSubfield,
  );
  if (rawSub) return rawSub.path;

  // No sortable variant available
  return null;
}

/**
 * Build an ES-compatible `sort` array from the current sort state.
 *
 * Returns `undefined` when there is no active sort (so the key can be
 * omitted from the request body).
 *
 * Includes `unmapped_type: "keyword"` to avoid failures when querying
 * index patterns where the field doesn't exist in every index.
 */
export function buildEsSortClause(
  sort: SortState | null,
  mappingFields: MappingField[],
): Array<Record<string, unknown>> | undefined {
  if (!sort) return undefined;

  const resolved = resolveSortField(sort.field, mappingFields);
  if (resolved === null) return undefined;

  if (resolved === "_id") {
    return [{ _id: { order: sort.dir } }];
  }

  return [
    {
      [resolved]: {
        order: sort.dir,
        unmapped_type: "keyword",
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Bulk-delete types & helpers
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
/**
 * Extract stable top-level column names from index mapping fields.
 *
 * Takes the first path segment of each non-subfield mapping field,
 * deduplicates, and sorts alphabetically. This mirrors the top-level
 * keys that `Object.keys(hit._source)` would return.
 */
export function topLevelColumnsFromFields(mappingFields: MappingField[]): string[] {
  const seen = new Set<string>();
  for (const f of mappingFields) {
    if (f.isSubfield) continue;
    const topLevel = f.path.split(".")[0];
    seen.add(topLevel);
  }
  return Array.from(seen).sort();
}

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
