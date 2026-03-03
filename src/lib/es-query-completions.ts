import {
  startCompletion,
} from "@codemirror/autocomplete";
import type {
  CompletionContext,
  CompletionResult,
  Completion,
} from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";
import type { MappingField } from "@/lib/es-mapping";

function buildFieldCompletions(fields: MappingField[]): Completion[] {
  return fields.map((f) => ({
    label: f.path,
    type: "variable",
    detail: f.type + (f.isSubfield ? " (sub-field)" : ""),
    boost: f.isSubfield ? -1 : 0,
  }));
}

/** Completions for the simple query bar (field: value && other > 10). */
export function fieldCompletions(fields: MappingField[]) {
  const completions = buildFieldCompletions(fields);

  return (context: CompletionContext): CompletionResult | null => {
    const word = context.matchBefore(/[\w.]*/);
    if (!word) return null;
    if (word.from === word.to && !context.explicit) return null;

    return {
      from: word.from,
      options: completions,
      filter: true,
    };
  };
}

// ---------------------------------------------------------------------------
// JSON ancestor parser
// ---------------------------------------------------------------------------

/**
 * Forward-parse JSON text from start to cursorPos, tracking nesting.
 * Returns the list of ancestor property keys leading to the cursor position.
 *
 * For example, with cursor at | in:
 *   { "query": { "bool": { "must": [{ "m|" }] } } }
 * Returns: ["query", "bool", "must"]
 */
function getJsonAncestors(text: string, cursorPos: number): string[] {
  // Stack tracks whether each { or [ pushed a key (string) or not (null)
  const stack: Array<string | null> = [];
  let i = 0;
  let lastKey: string | null = null;

  while (i < cursorPos) {
    // Skip whitespace
    while (i < cursorPos && /[\s\r\n]/.test(text[i])) i++;
    if (i >= cursorPos) break;

    const ch = text[i];

    if (ch === '"') {
      // Parse string
      i++; // skip opening quote
      let str = "";
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\') {
          str += text[i + 1] || "";
          i += 2;
        } else {
          str += text[i];
          i++;
        }
      }
      // If cursor is inside this string, stop — stack is the context
      if (i >= cursorPos) break;
      i++; // skip closing quote

      // Check if followed by : (making this a key)
      let j = i;
      while (j < text.length && /[\s\r\n]/.test(text[j])) j++;
      if (text[j] === ':') {
        lastKey = str;
      }
    } else if (ch === '{' || ch === '[') {
      stack.push(lastKey);
      lastKey = null;
      i++;
    } else if (ch === '}' || ch === ']') {
      stack.pop();
      lastKey = null;
      i++;
    } else if (ch === ':') {
      i++;
    } else if (ch === ',') {
      lastKey = null;
      i++;
    } else {
      // Skip tokens (numbers, true, false, null)
      while (i < cursorPos && !/[\s,}\]:{["]/.test(text[i])) i++;
    }
  }

  return stack.filter((k): k is string => k !== null);
}

// ---------------------------------------------------------------------------
// Quote-inserting apply function
// ---------------------------------------------------------------------------

const OBJECT_DETAILS = new Set([
  "object", "query", "bucket", "metric", "sub-aggs",
]);

function isObjectValue(detail?: string): boolean {
  if (!detail) return false;
  return OBJECT_DETAILS.has(detail);
}

function isArrayValue(detail?: string): boolean {
  if (!detail) return false;
  return detail === "array";
}

/**
 * Shared logic for absorbing surrounding quotes and computing indentation.
 */
function getApplyContext(doc: string, from: number, to: number) {
  const hasQuoteBefore = from > 0 && doc[from - 1] === '"';
  const hasQuoteAfter = to < doc.length && doc[to] === '"';
  const actualFrom = hasQuoteBefore ? from - 1 : from;
  const actualTo = hasQuoteAfter ? to + 1 : to;

  const lineStart = doc.lastIndexOf('\n', actualFrom - 1) + 1;
  const lineText = doc.slice(lineStart, actualFrom);
  const currentIndent = lineText.match(/^\s*/)?.[0] || "";

  return { actualFrom, actualTo, currentIndent };
}

/**
 * Apply function for property keys inside an object.
 * Inserts auto-formatted "key": {} / "key": [] / "key":  with indentation.
 */
function makeApply(label: string, detail?: string) {
  return (view: EditorView, _: Completion, from: number, to: number) => {
    const doc = view.state.doc.toString();
    const { actualFrom, actualTo, currentIndent } = getApplyContext(doc, from, to);
    const innerIndent = currentIndent + "  ";

    let insert: string;
    let cursorOffset: number;

    if (isObjectValue(detail)) {
      insert = `"${label}": {\n${innerIndent}\n${currentIndent}}`;
      cursorOffset = `"${label}": {\n${innerIndent}`.length;
    } else if (isArrayValue(detail)) {
      insert = `"${label}": [\n${innerIndent}\n${currentIndent}]`;
      cursorOffset = `"${label}": [\n${innerIndent}`.length;
    } else {
      insert = `"${label}": `;
      cursorOffset = insert.length;
    }

    view.dispatch({
      changes: { from: actualFrom, to: actualTo, insert },
      selection: { anchor: actualFrom + cursorOffset },
    });

    if (isObjectValue(detail) || isArrayValue(detail)) {
      requestAnimationFrame(() => startCompletion(view));
    }
  };
}

/**
 * Apply function for items inside an array (e.g. bool must/should/filter).
 * Wraps the key-value pair inside a JSON object:
 *
 *   {                          for object-valued keys
 *     "match": {
 *       |
 *     }
 *   }
 *
 *   {                          for scalar-valued keys
 *     "exists": {
 *       "field": |
 *     }
 *   }
 */
function makeArrayElementApply(label: string, detail?: string) {
  return (view: EditorView, _: Completion, from: number, to: number) => {
    const doc = view.state.doc.toString();
    const { actualFrom, actualTo, currentIndent } = getApplyContext(doc, from, to);
    const i1 = currentIndent + "  ";
    const i2 = currentIndent + "    ";

    let insert: string;
    let cursorOffset: number;

    if (isObjectValue(detail)) {
      insert = `{\n${i1}"${label}": {\n${i2}\n${i1}}\n${currentIndent}}`;
      cursorOffset = `{\n${i1}"${label}": {\n${i2}`.length;
    } else if (isArrayValue(detail)) {
      insert = `{\n${i1}"${label}": [\n${i2}\n${i1}]\n${currentIndent}}`;
      cursorOffset = `{\n${i1}"${label}": [\n${i2}`.length;
    } else {
      insert = `{\n${i1}"${label}": \n${currentIndent}}`;
      cursorOffset = `{\n${i1}"${label}": `.length;
    }

    view.dispatch({
      changes: { from: actualFrom, to: actualTo, insert },
      selection: { anchor: actualFrom + cursorOffset },
    });

    if (isObjectValue(detail) || isArrayValue(detail)) {
      requestAnimationFrame(() => startCompletion(view));
    }
  };
}

// ---------------------------------------------------------------------------
// Completion sets
// ---------------------------------------------------------------------------

const SEARCH_TOP_LEVEL: Completion[] = [
  { label: "query", type: "keyword", detail: "object", boost: 10 },
  { label: "size", type: "keyword", detail: "number", boost: 9 },
  { label: "from", type: "keyword", detail: "number", boost: 9 },
  { label: "sort", type: "keyword", detail: "array", boost: 8 },
  { label: "_source", type: "keyword", boost: 8 },
  { label: "aggs", type: "keyword", detail: "object", boost: 7 },
  { label: "aggregations", type: "keyword", detail: "object", boost: 6 },
  { label: "highlight", type: "keyword", detail: "object", boost: 6 },
  { label: "post_filter", type: "keyword", detail: "object", boost: 5 },
  { label: "track_total_hits", type: "keyword", boost: 5 },
  { label: "min_score", type: "keyword", detail: "number", boost: 4 },
  { label: "timeout", type: "keyword", detail: "string", boost: 4 },
  { label: "collapse", type: "keyword", detail: "object", boost: 4 },
  { label: "search_after", type: "keyword", detail: "array", boost: 4 },
  { label: "script_fields", type: "keyword", detail: "object", boost: 3 },
  { label: "stored_fields", type: "keyword", detail: "array", boost: 3 },
  { label: "indices_boost", type: "keyword", detail: "array", boost: 2 },
];

const QUERY_TYPES: Completion[] = [
  { label: "match_all", type: "keyword", detail: "query", boost: 10 },
  { label: "match", type: "keyword", detail: "query", boost: 10 },
  { label: "term", type: "keyword", detail: "query", boost: 10 },
  { label: "bool", type: "keyword", detail: "query", boost: 10 },
  { label: "range", type: "keyword", detail: "query", boost: 9 },
  { label: "terms", type: "keyword", detail: "query", boost: 9 },
  { label: "match_phrase", type: "keyword", detail: "query", boost: 9 },
  { label: "multi_match", type: "keyword", detail: "query", boost: 8 },
  { label: "exists", type: "keyword", detail: "query", boost: 8 },
  { label: "wildcard", type: "keyword", detail: "query", boost: 7 },
  { label: "prefix", type: "keyword", detail: "query", boost: 7 },
  { label: "fuzzy", type: "keyword", detail: "query", boost: 6 },
  { label: "regexp", type: "keyword", detail: "query", boost: 6 },
  { label: "nested", type: "keyword", detail: "query", boost: 7 },
  { label: "ids", type: "keyword", detail: "query", boost: 6 },
  { label: "query_string", type: "keyword", detail: "query", boost: 6 },
  { label: "simple_query_string", type: "keyword", detail: "query", boost: 5 },
  { label: "function_score", type: "keyword", detail: "query", boost: 5 },
  { label: "dis_max", type: "keyword", detail: "query", boost: 5 },
  { label: "constant_score", type: "keyword", detail: "query", boost: 5 },
  { label: "boosting", type: "keyword", detail: "query", boost: 4 },
  { label: "match_phrase_prefix", type: "keyword", detail: "query", boost: 4 },
  { label: "match_bool_prefix", type: "keyword", detail: "query", boost: 4 },
  { label: "span_term", type: "keyword", detail: "query", boost: 3 },
  { label: "geo_distance", type: "keyword", detail: "query", boost: 3 },
  { label: "geo_bounding_box", type: "keyword", detail: "query", boost: 3 },
];

const BOOL_CLAUSES: Completion[] = [
  { label: "must", type: "keyword", detail: "array", boost: 10 },
  { label: "should", type: "keyword", detail: "array", boost: 10 },
  { label: "must_not", type: "keyword", detail: "array", boost: 10 },
  { label: "filter", type: "keyword", detail: "array", boost: 10 },
  { label: "minimum_should_match", type: "keyword", detail: "number", boost: 5 },
  { label: "boost", type: "keyword", detail: "number", boost: 4 },
];

const RANGE_PARAMS: Completion[] = [
  { label: "gte", type: "keyword", boost: 10 },
  { label: "gt", type: "keyword", boost: 10 },
  { label: "lte", type: "keyword", boost: 10 },
  { label: "lt", type: "keyword", boost: 10 },
  { label: "format", type: "keyword", boost: 5 },
  { label: "time_zone", type: "keyword", boost: 4 },
  { label: "boost", type: "keyword", boost: 4 },
];

const MATCH_PARAMS: Completion[] = [
  { label: "query", type: "keyword", boost: 10 },
  { label: "operator", type: "keyword", boost: 8 },
  { label: "analyzer", type: "keyword", boost: 6 },
  { label: "boost", type: "keyword", boost: 5 },
  { label: "fuzziness", type: "keyword", boost: 7 },
  { label: "prefix_length", type: "keyword", boost: 4 },
  { label: "max_expansions", type: "keyword", boost: 4 },
  { label: "zero_terms_query", type: "keyword", boost: 3 },
  { label: "lenient", type: "keyword", boost: 3 },
  { label: "auto_generate_synonyms_phrase_query", type: "keyword", boost: 2 },
];

const MULTI_MATCH_PARAMS: Completion[] = [
  { label: "query", type: "keyword", boost: 10 },
  { label: "fields", type: "keyword", detail: "array", boost: 10 },
  { label: "type", type: "keyword", boost: 8 },
  { label: "operator", type: "keyword", boost: 7 },
  { label: "analyzer", type: "keyword", boost: 6 },
  { label: "boost", type: "keyword", boost: 5 },
  { label: "fuzziness", type: "keyword", boost: 5 },
  { label: "tie_breaker", type: "keyword", boost: 4 },
];

const NESTED_PARAMS: Completion[] = [
  { label: "path", type: "keyword", boost: 10 },
  { label: "query", type: "keyword", detail: "object", boost: 10 },
  { label: "score_mode", type: "keyword", boost: 7 },
  { label: "ignore_unmapped", type: "keyword", boost: 5 },
];

const FUNCTION_SCORE_PARAMS: Completion[] = [
  { label: "query", type: "keyword", detail: "object", boost: 10 },
  { label: "functions", type: "keyword", detail: "array", boost: 10 },
  { label: "score_mode", type: "keyword", boost: 7 },
  { label: "boost_mode", type: "keyword", boost: 7 },
  { label: "max_boost", type: "keyword", boost: 6 },
];

const CONSTANT_SCORE_PARAMS: Completion[] = [
  { label: "filter", type: "keyword", detail: "object", boost: 10 },
  { label: "boost", type: "keyword", boost: 8 },
];

const EXISTS_PARAMS: Completion[] = [
  { label: "field", type: "keyword", boost: 10 },
];

const HIGHLIGHT_PARAMS: Completion[] = [
  { label: "fields", type: "keyword", detail: "object", boost: 10 },
  { label: "pre_tags", type: "keyword", detail: "array", boost: 8 },
  { label: "post_tags", type: "keyword", detail: "array", boost: 8 },
  { label: "fragment_size", type: "keyword", detail: "number", boost: 6 },
  { label: "number_of_fragments", type: "keyword", detail: "number", boost: 6 },
  { label: "type", type: "keyword", boost: 5 },
  { label: "order", type: "keyword", boost: 4 },
  { label: "require_field_match", type: "keyword", boost: 3 },
];

const SORT_FIELD_PARAMS: Completion[] = [
  { label: "order", type: "keyword", boost: 10 },
  { label: "mode", type: "keyword", boost: 8 },
  { label: "missing", type: "keyword", boost: 6 },
  { label: "unmapped_type", type: "keyword", boost: 5 },
  { label: "nested", type: "keyword", detail: "object", boost: 4 },
];

const AGG_TYPES: Completion[] = [
  { label: "terms", type: "keyword", detail: "bucket", boost: 10 },
  { label: "date_histogram", type: "keyword", detail: "bucket", boost: 9 },
  { label: "histogram", type: "keyword", detail: "bucket", boost: 8 },
  { label: "filter", type: "keyword", detail: "bucket", boost: 8 },
  { label: "filters", type: "keyword", detail: "bucket", boost: 7 },
  { label: "range", type: "keyword", detail: "bucket", boost: 7 },
  { label: "date_range", type: "keyword", detail: "bucket", boost: 6 },
  { label: "nested", type: "keyword", detail: "bucket", boost: 6 },
  { label: "sampler", type: "keyword", detail: "bucket", boost: 4 },
  { label: "significant_terms", type: "keyword", detail: "bucket", boost: 5 },
  { label: "composite", type: "keyword", detail: "bucket", boost: 6 },
  { label: "avg", type: "keyword", detail: "metric", boost: 9 },
  { label: "sum", type: "keyword", detail: "metric", boost: 9 },
  { label: "min", type: "keyword", detail: "metric", boost: 9 },
  { label: "max", type: "keyword", detail: "metric", boost: 9 },
  { label: "cardinality", type: "keyword", detail: "metric", boost: 8 },
  { label: "value_count", type: "keyword", detail: "metric", boost: 8 },
  { label: "stats", type: "keyword", detail: "metric", boost: 7 },
  { label: "extended_stats", type: "keyword", detail: "metric", boost: 6 },
  { label: "percentiles", type: "keyword", detail: "metric", boost: 6 },
  { label: "top_hits", type: "keyword", detail: "metric", boost: 7 },
  { label: "aggs", type: "keyword", detail: "sub-aggs", boost: 10 },
  { label: "aggregations", type: "keyword", detail: "sub-aggs", boost: 9 },
];

const AGG_FIELD_PARAMS: Completion[] = [
  { label: "field", type: "keyword", boost: 10 },
  { label: "size", type: "keyword", boost: 8 },
  { label: "order", type: "keyword", detail: "object", boost: 7 },
  { label: "min_doc_count", type: "keyword", boost: 6 },
  { label: "missing", type: "keyword", boost: 5 },
  { label: "interval", type: "keyword", boost: 7 },
  { label: "calendar_interval", type: "keyword", boost: 7 },
  { label: "fixed_interval", type: "keyword", boost: 7 },
  { label: "format", type: "keyword", boost: 6 },
  { label: "script", type: "keyword", detail: "object", boost: 4 },
  { label: "include", type: "keyword", boost: 4 },
  { label: "exclude", type: "keyword", boost: 4 },
  { label: "shard_size", type: "keyword", boost: 3 },
];

const COUNT_TOP_LEVEL: Completion[] = [
  { label: "query", type: "keyword", detail: "object", boost: 10 },
];

const DELETE_BY_QUERY_TOP_LEVEL: Completion[] = [
  { label: "query", type: "keyword", detail: "object", boost: 10 },
  { label: "max_docs", type: "keyword", detail: "number", boost: 5 },
  { label: "slice", type: "keyword", detail: "object", boost: 4 },
];

const UPDATE_BY_QUERY_TOP_LEVEL: Completion[] = [
  { label: "query", type: "keyword", detail: "object", boost: 10 },
  { label: "script", type: "keyword", detail: "object", boost: 9 },
  { label: "max_docs", type: "keyword", detail: "number", boost: 5 },
  { label: "slice", type: "keyword", detail: "object", boost: 4 },
];

const MAPPING_TOP_LEVEL: Completion[] = [
  { label: "properties", type: "keyword", detail: "object", boost: 10 },
  { label: "dynamic", type: "keyword", boost: 8 },
  { label: "_source", type: "keyword", detail: "object", boost: 6 },
  { label: "_routing", type: "keyword", detail: "object", boost: 5 },
];

const MAPPING_FIELD: Completion[] = [
  { label: "type", type: "keyword", boost: 10 },
  { label: "index", type: "keyword", boost: 8 },
  { label: "analyzer", type: "keyword", boost: 7 },
  { label: "search_analyzer", type: "keyword", boost: 6 },
  { label: "fields", type: "keyword", detail: "object", boost: 7 },
  { label: "properties", type: "keyword", detail: "object", boost: 7 },
  { label: "format", type: "keyword", boost: 5 },
  { label: "null_value", type: "keyword", boost: 4 },
  { label: "copy_to", type: "keyword", boost: 4 },
  { label: "doc_values", type: "keyword", boost: 4 },
  { label: "store", type: "keyword", boost: 3 },
  { label: "enabled", type: "keyword", boost: 3 },
  { label: "ignore_above", type: "keyword", boost: 3 },
];

const SETTINGS_TOP_LEVEL: Completion[] = [
  { label: "index", type: "keyword", detail: "object", boost: 10 },
  { label: "number_of_shards", type: "keyword", detail: "number", boost: 9 },
  { label: "number_of_replicas", type: "keyword", detail: "number", boost: 9 },
  { label: "refresh_interval", type: "keyword", detail: "string", boost: 8 },
  { label: "analysis", type: "keyword", detail: "object", boost: 7 },
  { label: "max_result_window", type: "keyword", detail: "number", boost: 6 },
];

// Query types where the next level key should be a field name
const FIELD_EXPECTING_QUERIES = new Set([
  "match", "match_phrase", "match_phrase_prefix", "match_bool_prefix",
  "term", "wildcard", "prefix", "fuzzy", "regexp", "range",
]);

// Agg types that accept field-level params
const AGG_METRIC_TYPES = new Set([
  "terms", "avg", "sum", "min", "max", "cardinality", "value_count",
  "stats", "extended_stats", "percentiles", "date_histogram", "histogram",
  "date_range", "significant_terms", "top_hits", "composite",
]);

// ---------------------------------------------------------------------------
// Endpoint-aware context resolver
// ---------------------------------------------------------------------------

type EndpointOp =
  | "_search" | "_count" | "_delete_by_query" | "_update_by_query"
  | "_mapping" | "_settings" | "_doc" | "_bulk" | "generic";

function detectEndpointOp(endpoint: string): EndpointOp {
  const lower = endpoint.toLowerCase();
  if (lower.includes("_search")) return "_search";
  if (lower.includes("_count")) return "_count";
  if (lower.includes("_delete_by_query")) return "_delete_by_query";
  if (lower.includes("_update_by_query")) return "_update_by_query";
  if (lower.includes("_mapping")) return "_mapping";
  if (lower.includes("_settings")) return "_settings";
  if (lower.includes("_doc")) return "_doc";
  if (lower.includes("_bulk")) return "_bulk";
  return "generic";
}

function getTopLevelForOp(op: EndpointOp): Completion[] {
  switch (op) {
    case "_search": return SEARCH_TOP_LEVEL;
    case "_count": return COUNT_TOP_LEVEL;
    case "_delete_by_query": return DELETE_BY_QUERY_TOP_LEVEL;
    case "_update_by_query": return UPDATE_BY_QUERY_TOP_LEVEL;
    case "_mapping": return MAPPING_TOP_LEVEL;
    case "_settings": return SETTINGS_TOP_LEVEL;
    case "_doc": return []; // user supplies the document source directly
    case "_bulk": return [];
    case "generic": return SEARCH_TOP_LEVEL; // reasonable default
  }
}

interface ContextResult {
  options: Completion[];
  /** True when completions are array elements that need wrapping in {} */
  arrayElement: boolean;
}

function result(options: Completion[], arrayElement = false): ContextResult {
  return { options, arrayElement };
}

function getSuggestionsForContext(
  ancestors: string[],
  fieldOptions: Completion[],
  op: EndpointOp,
): ContextResult {
  const depth = ancestors.length;

  // Root level — endpoint-specific top-level keys
  if (depth === 0) {
    if (op === "_doc") return result(fieldOptions);
    return result(getTopLevelForOp(op));
  }

  const last = ancestors[depth - 1];

  // --- Query context ---
  if (last === "query" || last === "post_filter") return result(QUERY_TYPES);
  if (last === "bool") return result(BOOL_CLAUSES);
  if (last === "must" || last === "should" || last === "must_not" || last === "filter") {
    if (depth >= 2 && ancestors[depth - 2] === "bool") return result(QUERY_TYPES, true);
    return result(QUERY_TYPES, true);
  }

  // Inside a field-expecting query type → suggest field names
  if (FIELD_EXPECTING_QUERIES.has(last)) {
    return result(fieldOptions.length > 0 ? fieldOptions : []);
  }

  // Inside range > fieldName → range params
  if (depth >= 2 && ancestors[depth - 2] === "range") return result(RANGE_PARAMS);

  // Inside match/term/etc > fieldName → match params
  if (depth >= 2 && FIELD_EXPECTING_QUERIES.has(ancestors[depth - 2])) return result(MATCH_PARAMS);

  // --- Special query types with their own params ---
  if (last === "match_all") return result([{ label: "boost", type: "keyword", boost: 10 }]);
  if (last === "multi_match") return result(MULTI_MATCH_PARAMS);
  if (last === "nested") return result(NESTED_PARAMS);
  if (last === "function_score") return result(FUNCTION_SCORE_PARAMS);
  if (last === "constant_score") return result(CONSTANT_SCORE_PARAMS);
  if (last === "exists") return result(EXISTS_PARAMS);
  if (last === "dis_max") {
    return result([
      { label: "queries", type: "keyword", detail: "array", boost: 10 },
      { label: "tie_breaker", type: "keyword", boost: 8 },
      { label: "boost", type: "keyword", boost: 5 },
    ]);
  }
  if (last === "boosting") {
    return result([
      { label: "positive", type: "keyword", detail: "object", boost: 10 },
      { label: "negative", type: "keyword", detail: "object", boost: 10 },
      { label: "negative_boost", type: "keyword", boost: 9 },
    ]);
  }
  // "queries" inside dis_max → query types as array elements
  if (last === "queries") return result(QUERY_TYPES, true);
  // "positive"/"negative" inside boosting → query types
  if (last === "positive" || last === "negative") return result(QUERY_TYPES);

  // --- Aggregation context ---
  if (last === "aggs" || last === "aggregations") return result([]);
  if (depth >= 2 && (ancestors[depth - 2] === "aggs" || ancestors[depth - 2] === "aggregations")) {
    return result(AGG_TYPES);
  }
  if (AGG_METRIC_TYPES.has(last)) {
    return result([...AGG_FIELD_PARAMS, ...fieldOptions]);
  }

  // --- Sort context ---
  if (last === "sort") {
    return result([
      ...fieldOptions,
      { label: "_score", type: "keyword", boost: 10 },
      { label: "_doc", type: "keyword", boost: 5 },
    ], true);
  }
  if (depth >= 2 && ancestors[depth - 2] === "sort") return result(SORT_FIELD_PARAMS);

  // --- Highlight context ---
  if (last === "highlight") return result(HIGHLIGHT_PARAMS);
  if (last === "fields" && depth >= 2 && ancestors[depth - 2] === "highlight") {
    return result(fieldOptions);
  }

  // --- Mapping context ---
  if (last === "properties") return result(fieldOptions.length > 0 ? fieldOptions : []);
  if (depth >= 2 && ancestors[depth - 2] === "properties") return result(MAPPING_FIELD);

  // --- Script context ---
  if (last === "script") {
    return result([
      { label: "source", type: "keyword", boost: 10 },
      { label: "lang", type: "keyword", boost: 8 },
      { label: "params", type: "keyword", detail: "object", boost: 7 },
    ]);
  }

  // --- Collapse context ---
  if (last === "collapse") {
    return result([
      { label: "field", type: "keyword", boost: 10 },
      { label: "inner_hits", type: "keyword", detail: "object", boost: 8 },
      { label: "max_concurrent_group_searches", type: "keyword", boost: 5 },
    ]);
  }

  // Fallback — top-level + query types + fields
  return result([...getTopLevelForOp(op), ...QUERY_TYPES, ...fieldOptions]);
}

// ---------------------------------------------------------------------------
// Exported DSL completion provider
// ---------------------------------------------------------------------------

/**
 * Context-aware completions for the REST console body editor.
 *
 * - Parses JSON structure to determine DSL context
 * - Adapts to endpoint operation (_search, _mapping, etc.)
 * - Auto-quotes property names and inserts ": " / ": {}" / ": []"
 * - Shows suggestions immediately after { and , (key positions)
 * - Cascades: inserting an object/array value auto-opens next completions
 */
export function esDslCompletions(fields: MappingField[], endpoint: string) {
  const fieldOptions = buildFieldCompletions(fields);
  const op = detectEndpointOp(endpoint);

  return (context: CompletionContext): CompletionResult | null => {
    const doc = context.state.doc.toString();
    const word = context.matchBefore(/[\w.]*/);
    if (!word) return null;

    const isEmpty = word.from === word.to;
    if (isEmpty && !context.explicit) {
      // Auto-show at key positions: after { , or [ (with optional whitespace)
      const before = doc.slice(Math.max(0, word.from - 200), word.from);
      const trimmed = before.trimEnd();
      const lastCh = trimmed[trimmed.length - 1];
      if (lastCh !== '{' && lastCh !== ',' && lastCh !== '[') {
        // Also trigger when the user types " to start a key after { , or [
        // e.g.  [ "  or  { "  — still a key position, show completions
        if (lastCh === '"') {
          const beforeQuote = trimmed.slice(0, -1).trimEnd();
          const chBefore = beforeQuote[beforeQuote.length - 1];
          if (chBefore !== '{' && chBefore !== ',' && chBefore !== '[') return null;
        } else {
          return null;
        }
      }
    }

    const ancestors = getJsonAncestors(doc, word.from);
    const { options: rawOptions, arrayElement } = getSuggestionsForContext(ancestors, fieldOptions, op);
    if (rawOptions.length === 0) return null;

    // Wrap every option with the appropriate apply function:
    // - arrayElement: wraps in { "key": value } for valid array items
    // - otherwise: plain "key": value
    const applyFn = arrayElement ? makeArrayElementApply : makeApply;
    const options = rawOptions.map((opt) => ({
      ...opt,
      apply: applyFn(opt.label, opt.detail),
    }));

    return {
      from: word.from,
      options,
      filter: true,
    };
  };
}
