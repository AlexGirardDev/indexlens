import { describe, it, expect } from "vitest";
import {
  hitKey,
  buildBulkDeleteBody,
  resolveSortField,
  buildEsSortClause,
  topLevelColumnsFromFields,
  type SortState,
} from "./document-helpers";
import type { MappingField } from "./es-mapping";

// ---------------------------------------------------------------------------
// hitKey
// ---------------------------------------------------------------------------

describe("hitKey", () => {
  it("combines _index and _id with a null separator", () => {
    expect(hitKey({ _index: "my-index", _id: "abc123" })).toBe(
      "my-index\0abc123",
    );
  });

  it("produces distinct keys for same _id in different indices", () => {
    const a = hitKey({ _index: "index-a", _id: "1" });
    const b = hitKey({ _index: "index-b", _id: "1" });
    expect(a).not.toBe(b);
  });

  it("produces distinct keys for different _ids in the same index", () => {
    const a = hitKey({ _index: "idx", _id: "1" });
    const b = hitKey({ _index: "idx", _id: "2" });
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// buildBulkDeleteBody
// ---------------------------------------------------------------------------

describe("buildBulkDeleteBody", () => {
  it("produces valid NDJSON with trailing newline", () => {
    const body = buildBulkDeleteBody([
      { _index: "idx", _id: "1" },
      { _index: "idx", _id: "2" },
    ]);
    expect(body.endsWith("\n")).toBe(true);
    const lines = body.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("includes delete action with _index and _id", () => {
    const body = buildBulkDeleteBody([{ _index: "test", _id: "abc" }]);
    const parsed = JSON.parse(body.trimEnd());
    expect(parsed).toEqual({
      delete: { _index: "test", _id: "abc" },
    });
  });

  it("includes optimistic concurrency fields when present", () => {
    const body = buildBulkDeleteBody([
      { _index: "test", _id: "abc", _seq_no: 5, _primary_term: 1 },
    ]);
    const parsed = JSON.parse(body.trimEnd());
    expect(parsed).toEqual({
      delete: {
        _index: "test",
        _id: "abc",
        if_seq_no: 5,
        if_primary_term: 1,
      },
    });
  });

  it("omits concurrency fields when only _seq_no is present", () => {
    const body = buildBulkDeleteBody([
      { _index: "test", _id: "abc", _seq_no: 5 },
    ]);
    const parsed = JSON.parse(body.trimEnd());
    expect(parsed.delete).not.toHaveProperty("if_seq_no");
    expect(parsed.delete).not.toHaveProperty("if_primary_term");
  });

  it("returns a single trailing newline for empty input", () => {
    const body = buildBulkDeleteBody([]);
    expect(body).toBe("\n");
  });
});

// ---------------------------------------------------------------------------
// topLevelColumnsFromFields
// ---------------------------------------------------------------------------

describe("topLevelColumnsFromFields", () => {
  it("returns sorted top-level field names", () => {
    const fields: MappingField[] = [
      { path: "name", type: "text", isSubfield: false },
      { path: "age", type: "integer", isSubfield: false },
      { path: "created_at", type: "date", isSubfield: false },
    ];
    expect(topLevelColumnsFromFields(fields)).toEqual(["age", "created_at", "name"]);
  });

  it("excludes subfields", () => {
    const fields: MappingField[] = [
      { path: "name", type: "text", isSubfield: false },
      { path: "name.keyword", type: "keyword", isSubfield: true },
    ];
    expect(topLevelColumnsFromFields(fields)).toEqual(["name"]);
  });

  it("deduplicates nested paths to their top-level segment", () => {
    const fields: MappingField[] = [
      { path: "host", type: "object", isSubfield: false },
      { path: "host.name", type: "keyword", isSubfield: false },
      { path: "host.ip", type: "ip", isSubfield: false },
    ];
    expect(topLevelColumnsFromFields(fields)).toEqual(["host"]);
  });

  it("returns an empty array for empty input", () => {
    expect(topLevelColumnsFromFields([])).toEqual([]);
  });

  it("handles a mix of top-level, nested, and subfields", () => {
    const fields: MappingField[] = [
      { path: "name", type: "text", isSubfield: false },
      { path: "name.keyword", type: "keyword", isSubfield: true },
      { path: "host.name", type: "keyword", isSubfield: false },
      { path: "host.ip", type: "ip", isSubfield: false },
      { path: "age", type: "integer", isSubfield: false },
      { path: "tags", type: "text", isSubfield: false },
      { path: "tags.raw", type: "keyword", isSubfield: true },
    ];
    expect(topLevelColumnsFromFields(fields)).toEqual(["age", "host", "name", "tags"]);
  });
});

// ---------------------------------------------------------------------------
// resolveSortField
// ---------------------------------------------------------------------------

describe("resolveSortField", () => {
  const fields: MappingField[] = [
    { path: "name", type: "text", isSubfield: false },
    { path: "name.keyword", type: "keyword", isSubfield: true },
    { path: "age", type: "integer", isSubfield: false },
    { path: "bio", type: "text", isSubfield: false },
    { path: "created_at", type: "date", isSubfield: false },
    { path: "tags", type: "text", isSubfield: false },
    { path: "tags.raw", type: "keyword", isSubfield: true },
  ];

  it("returns '_id' for the _id field", () => {
    expect(resolveSortField("_id", fields)).toBe("_id");
  });

  it("returns the field path directly for non-text types", () => {
    expect(resolveSortField("age", fields)).toBe("age");
    expect(resolveSortField("created_at", fields)).toBe("created_at");
  });

  it("resolves text field to .keyword sub-field when available", () => {
    expect(resolveSortField("name", fields)).toBe("name.keyword");
  });

  it("resolves text field to .raw sub-field when .keyword is absent", () => {
    expect(resolveSortField("tags", fields)).toBe("tags.raw");
  });

  it("returns null for text field with no sortable sub-field", () => {
    expect(resolveSortField("bio", fields)).toBeNull();
  });

  it("returns field as-is when not found in mappings (multi-index fallback)", () => {
    expect(resolveSortField("unknown_field", fields)).toBe("unknown_field");
  });
});

// ---------------------------------------------------------------------------
// buildEsSortClause
// ---------------------------------------------------------------------------

describe("buildEsSortClause", () => {
  const fields: MappingField[] = [
    { path: "name", type: "text", isSubfield: false },
    { path: "name.keyword", type: "keyword", isSubfield: true },
    { path: "age", type: "integer", isSubfield: false },
    { path: "bio", type: "text", isSubfield: false },
  ];

  it("returns undefined when sort is null", () => {
    expect(buildEsSortClause(null, fields)).toBeUndefined();
  });

  it("returns a sort array for _id ascending", () => {
    const sort: SortState = { field: "_id", dir: "asc" };
    expect(buildEsSortClause(sort, fields)).toEqual([
      { _id: { order: "asc" } },
    ]);
  });

  it("returns a sort array for _id descending", () => {
    const sort: SortState = { field: "_id", dir: "desc" };
    expect(buildEsSortClause(sort, fields)).toEqual([
      { _id: { order: "desc" } },
    ]);
  });

  it("builds sort with unmapped_type for a numeric field", () => {
    const sort: SortState = { field: "age", dir: "desc" };
    expect(buildEsSortClause(sort, fields)).toEqual([
      { age: { order: "desc", unmapped_type: "keyword" } },
    ]);
  });

  it("resolves text field to .keyword sub-field in sort clause", () => {
    const sort: SortState = { field: "name", dir: "asc" };
    expect(buildEsSortClause(sort, fields)).toEqual([
      { "name.keyword": { order: "asc", unmapped_type: "keyword" } },
    ]);
  });

  it("returns undefined when text field has no sortable sub-field", () => {
    const sort: SortState = { field: "bio", dir: "asc" };
    expect(buildEsSortClause(sort, fields)).toBeUndefined();
  });

  it("sorts unknown fields with unmapped_type fallback", () => {
    const sort: SortState = { field: "unknown", dir: "asc" };
    expect(buildEsSortClause(sort, fields)).toEqual([
      { unknown: { order: "asc", unmapped_type: "keyword" } },
    ]);
  });
});
