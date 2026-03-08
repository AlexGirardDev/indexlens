import { describe, it, expect } from "vitest";
import { encodeIndexPattern } from "./export-helpers";

// ---------------------------------------------------------------------------
// encodeIndexPattern
// ---------------------------------------------------------------------------

describe("encodeIndexPattern", () => {
  it("returns a simple index name unchanged", () => {
    expect(encodeIndexPattern("my-index")).toBe("my-index");
  });

  it("preserves wildcard characters", () => {
    expect(encodeIndexPattern("logs-*")).toBe("logs-*");
  });

  it("encodes special characters but keeps wildcards", () => {
    expect(encodeIndexPattern("logs <2024>*")).toBe("logs%20%3C2024%3E*");
  });

  it("handles comma-separated patterns", () => {
    expect(encodeIndexPattern("index-a, index-b")).toBe("index-a,index-b");
  });

  it("handles comma-separated patterns with wildcards", () => {
    expect(encodeIndexPattern("logs-*, metrics-*")).toBe("logs-*,metrics-*");
  });

  it("trims whitespace around each segment", () => {
    expect(encodeIndexPattern("  foo ,  bar  ")).toBe("foo,bar");
  });

  it("handles a single wildcard", () => {
    expect(encodeIndexPattern("*")).toBe("*");
  });

  it("handles an empty string", () => {
    expect(encodeIndexPattern("")).toBe("");
  });
});
