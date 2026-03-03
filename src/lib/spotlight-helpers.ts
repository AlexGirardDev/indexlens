/**
 * Pure helper functions for building and resolving Spotlight search items.
 * Extracted so they can be unit-tested without React dependencies.
 */

import type { SavedQuery } from "@/lib/rest-query-storage";
import type { ClusterConfig, Page } from "@/types/cluster";

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

export interface SpotlightClusterItem {
  type: "cluster";
  cluster: ClusterConfig;
}

export type SpotlightItem = SpotlightNavItem | SpotlightIndexItem | SpotlightSavedQueryItem | SpotlightClusterItem;

// ---------------------------------------------------------------------------
// Command-mode types & constants
// ---------------------------------------------------------------------------

export const COMMAND_PREFIX = ">";

export interface SpotlightCommand {
  id: string;
  label: string;
}

export const SPOTLIGHT_COMMANDS: SpotlightCommand[] = [
  { id: "select-cluster", label: "Select Cluster" },
];

/**
 * Describes the current state of the Spotlight input when parsed for
 * command-mode behaviour.
 *
 * - `mode: "search"` — normal contextual search (no leading `>`).
 * - `mode: "command-list"` — the user typed `>` and is browsing/filtering
 *   the list of available commands.
 * - `mode: "command-active"` — a command has been selected (e.g.
 *   `> Select Cluster`) and the user is now filtering within that command's
 *   results.
 */
export type SpotlightInputState =
  | { mode: "search"; search: string }
  | { mode: "command-list"; filter: string }
  | { mode: "command-active"; command: SpotlightCommand; filter: string };

/**
 * Parse raw input text into a `SpotlightInputState`.
 */
export function parseSpotlightInput(raw: string): SpotlightInputState {
  const trimmed = raw.trimStart();

  if (!trimmed.startsWith(COMMAND_PREFIX)) {
    return { mode: "search", search: raw };
  }

  // Strip the leading '>' and any space after it
  const afterPrefix = trimmed.slice(1).trimStart();

  // Check if any known command matches the beginning of `afterPrefix`
  for (const cmd of SPOTLIGHT_COMMANDS) {
    if (afterPrefix.toLowerCase().startsWith(cmd.label.toLowerCase())) {
      const rest = afterPrefix.slice(cmd.label.length);
      // The command must be followed by nothing or a space (not a partial word)
      if (rest === "" || rest.startsWith(" ")) {
        return {
          mode: "command-active",
          command: cmd,
          filter: rest.trimStart(),
        };
      }
    }
  }

  return { mode: "command-list", filter: afterPrefix };
}

/**
 * Filter the list of available commands by a search term.
 */
export function filterCommands(
  commands: SpotlightCommand[],
  filter: string,
): SpotlightCommand[] {
  if (!filter) return commands;
  const lower = filter.toLowerCase();
  return commands.filter((cmd) => cmd.label.toLowerCase().includes(lower));
}

/**
 * Build the display string for an active command in the input field.
 * e.g. `"> Select Cluster "` — note the trailing space so the user can
 * start typing a filter immediately.
 */
export function buildCommandInputValue(command: SpotlightCommand): string {
  return `${COMMAND_PREFIX} ${command.label} `;
}

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

export function buildClusterItems(clusters: ClusterConfig[], activeClusterId: string | null): SpotlightClusterItem[] {
  return clusters
    .filter((c) => c.id !== activeClusterId)
    .map((cluster) => ({ type: "cluster", cluster }));
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
      case "cluster":
        return (
          item.cluster.name.toLowerCase().includes(lower) ||
          item.cluster.url.toLowerCase().includes(lower)
        );
    }
  });
}
