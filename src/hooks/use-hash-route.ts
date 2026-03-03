import { useCallback, useSyncExternalStore } from "react";
import type { Page } from "@/types/cluster";

// ---------------------------------------------------------------------------
// Hash format:  #/<clusterId>/<page>
//               #/<clusterId>/indices/<indexName>
// ---------------------------------------------------------------------------

const VALID_PAGES = new Set<string>(["dashboard", "indices", "rest", "settings"]);

function isValidPage(value: string | undefined): value is Page {
  return value !== undefined && VALID_PAGES.has(value);
}

interface HashRoute {
  clusterId: string | null;
  page: Page;
  indexName: string | null;
}

function parseHash(hash: string): HashRoute {
  const stripped = hash.replace(/^#\/?/, "");
  if (!stripped) return { clusterId: null, page: "dashboard", indexName: null };

  const segments = stripped.split("/");
  const clusterId = segments[0] || null;
  const pageStr = segments[1];
  const page = isValidPage(pageStr) ? pageStr : "dashboard";
  const indexName =
    page === "indices" && segments[2]
      ? decodeURIComponent(segments[2])
      : null;

  return { clusterId, page, indexName };
}

function buildHash(
  clusterId: string | null,
  page: Page,
  indexName?: string | null,
): string {
  if (!clusterId) return page === "dashboard" ? "#/" : `#//${page}`;
  if (page === "indices" && indexName) {
    return `#/${clusterId}/indices/${encodeURIComponent(indexName)}`;
  }
  return `#/${clusterId}/${page}`;
}

// ---------------------------------------------------------------------------
// External store for hash changes (avoids stale closures)
// ---------------------------------------------------------------------------

function subscribeToHash(callback: () => void): () => void {
  window.addEventListener("hashchange", callback);
  return () => window.removeEventListener("hashchange", callback);
}

function getHashSnapshot(): string {
  return window.location.hash;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useHashRoute() {
  const hash = useSyncExternalStore(subscribeToHash, getHashSnapshot);
  const route = parseHash(hash);

  const navigate = useCallback(
    (clusterId: string | null, page: Page, indexName?: string | null) => {
      const next = buildHash(clusterId, page, indexName);
      if (window.location.hash !== next) {
        window.location.hash = next;
      }
    },
    [],
  );

  const navigateCluster = useCallback(
    (clusterId: string) => {
      navigate(clusterId, route.page);
    },
    [navigate, route.page],
  );

  const navigatePage = useCallback(
    (page: Page) => {
      navigate(route.clusterId, page);
    },
    [navigate, route.clusterId],
  );

  const navigateIndex = useCallback(
    (indexName: string) => {
      navigate(route.clusterId, "indices", indexName);
    },
    [navigate, route.clusterId],
  );

  return {
    clusterId: route.clusterId,
    page: route.page,
    indexName: route.indexName,
    navigate,
    navigateCluster,
    navigatePage,
    navigateIndex,
  } as const;
}
