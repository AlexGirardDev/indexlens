import { describe, it, expect } from "vitest";
import { hitKey, buildBulkDeleteBody } from "./document-helpers";

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
