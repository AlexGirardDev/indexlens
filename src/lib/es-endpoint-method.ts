const POST_ACTIONS = new Set([
  "_search",
  "_delete_by_query",
  "_update_by_query",
  "_reindex",
  "_bulk",
  "_aliases",
  "_refresh",
  "_flush",
  "_forcemerge",
]);

const GET_ACTIONS = new Set([
  "_cat/indices",
  "_cat/aliases",
  "_cat/health",
  "_cat/nodes",
  "_cat/shards",
  "_cluster/health",
  "_cluster/stats",
  "_nodes/stats",
]);

type PreferredHttpMethod = "GET" | "POST";

function normalizeEndpoint(endpoint: string): string[] {
  const clean = endpoint.trim().split("?")[0].split("#")[0].replace(/^\/+/, "").toLowerCase();
  if (!clean) return [];
  return clean.split("/").filter(Boolean);
}

function getActionCandidates(segments: string[]): string[] {
  const candidates = new Set<string>();

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (!segment.startsWith("_")) continue;

    candidates.add(segment);
    const next = segments[i + 1];
    if (!next) continue;

    if (segment === "_cat" || segment === "_cluster" || segment === "_nodes") {
      candidates.add(`${segment}/${next}`);
    }
  }

  return Array.from(candidates);
}

export function inferPreferredHttpMethod(endpoint: string): PreferredHttpMethod | null {
  const segments = normalizeEndpoint(endpoint);
  if (segments.length === 0) return null;

  for (const candidate of getActionCandidates(segments)) {
    if (POST_ACTIONS.has(candidate)) return "POST";
    if (GET_ACTIONS.has(candidate)) return "GET";
  }

  return null;
}

export function autoMethodForEndpoint(endpoint: string, defaultMethod: PreferredHttpMethod = "GET"): PreferredHttpMethod {
  return inferPreferredHttpMethod(endpoint) ?? defaultMethod;
}

