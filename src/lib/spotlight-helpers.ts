/**
 * Pure helper functions for building and resolving Spotlight search items.
 * Extracted so they can be unit-tested without React dependencies.
 */

import type { SavedQuery } from "@/lib/rest-query-storage";
import type { Page } from "@/types/cluster";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SpotlightNavItem {
  type: "nav";
  page: Page;
  label: string;
}

export interface SpotlightIndexItem {
  type: "index";
  name: string;
  aliases: string[];
}

export interface SpotlightSavedQueryItem {
  type: "saved-query";
  query: SavedQuery;
}

export type SpotlightItem = SpotlightNavItem | SpotlightIndexItem | SpotlightSavedQueryItem;

export interface RestPreloadAction {
  method: string;
  endpoint: string;
  body: string;
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const NAV_PAGES: { page: Page; label: string }[] = [
  { page: "dashboard", label: "Dashboard" },
  { page: "indices", label: "Indices" },
  { page: "rest", label: "Rest" },
  { page: "settings", label: "Settings" },
];

export function buildNavItems(): SpotlightNavItem[] {
  return NAV_PAGES.map(({ page, label }) => ({ type: "nav", page, label }));
}

export function buildIndexItems(
  indices: Array<{ name: string; aliases: string[] }>,
): SpotlightIndexItem[] {
  return indices.map(({ name, aliases }) => ({
    type: "index",
    name,
    aliases,
  }));
}

export function buildSavedQueryItems(queries: SavedQuery[]): SpotlightSavedQueryItem[] {
  return queries.map((query) => ({ type: "saved-query", query }));
}

// ---------------------------------------------------------------------------
// Resolvers
// ---------------------------------------------------------------------------

/**
 * Resolve a saved query into a REST preload action shape.
 * This is the deterministic mapping used when a user selects a saved query
 * from the spotlight overlay — the app navigates to REST and preloads these
 * values into the editors.
 */
export function resolveRestPreload(query: SavedQuery): RestPreloadAction {
  return {
    method: query.method,
    endpoint: query.endpoint,
    body: query.body,
  };
}

/**
 * Filter spotlight items against a search term (case-insensitive substring).
 * Returns the subset of items whose labels/names/keywords contain the term.
 */
export function filterSpotlightItems(
  items: SpotlightItem[],
  search: string,
): SpotlightItem[] {
  if (!search) return items;
  const lower = search.toLowerCase();

  return items.filter((item) => {
    switch (item.type) {
      case "nav":
        return item.label.toLowerCase().includes(lower) || item.page.toLowerCase().includes(lower);
      case "index":
        return (
          item.name.toLowerCase().includes(lower) ||
          item.aliases.some((a) => a.toLowerCase().includes(lower))
        );
      case "saved-query":
        return (
          item.query.name.toLowerCase().includes(lower) ||
          item.query.method.toLowerCase().includes(lower) ||
          item.query.endpoint.toLowerCase().includes(lower)
        );
    }
  });
}
