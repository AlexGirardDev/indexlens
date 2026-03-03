import {
  LayoutDashboardIcon,
  ListIcon,
  TerminalIcon,
  SettingsIcon,
  DatabaseIcon,
  BookmarkIcon,
} from "lucide-react";
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
} from "@/components/ui/command";
import type { ClusterConfig, Page } from "@/types/cluster";
import type { SavedQuery } from "@/lib/rest-query-storage";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SpotlightIndex {
  name: string;
  aliases: string[];
}

export interface SpotlightProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigate: (page: Page) => void;
  onSelectIndex: (indexName: string) => void;
  onSelectSavedQuery: (query: SavedQuery) => void;
  indices: SpotlightIndex[];
  savedQueries: SavedQuery[];
  clusters: ClusterConfig[];
  onSelectCluster: (cluster: ClusterConfig) => void;
  loading?: boolean;
}

// ---------------------------------------------------------------------------
// Nav item metadata (kept in sync with navbar.tsx icons)
// ---------------------------------------------------------------------------

const NAV_ITEMS: { page: Page; label: string; icon: React.ReactNode; shortcut?: string }[] = [
  { page: "dashboard", label: "Dashboard", icon: <LayoutDashboardIcon className="size-4" />, shortcut: "D" },
  { page: "indices", label: "Indices", icon: <ListIcon className="size-4" />, shortcut: "I" },
  { page: "rest", label: "Rest", icon: <TerminalIcon className="size-4" />, shortcut: "R" },
  { page: "settings", label: "Settings", icon: <SettingsIcon className="size-4" />, shortcut: "S" },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SpotlightSearch({
  open,
  onOpenChange,
  onNavigate,
  onSelectIndex,
  onSelectSavedQuery,
  indices,
  savedQueries,
  clusters,
  onSelectCluster,
  loading,
}: SpotlightProps) {
  const handleSelect = (callback: () => void) => {
    callback();
    onOpenChange(false);
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Spotlight Search"
      description="Search for pages, indices, and saved queries"
      showCloseButton={false}
    >
      <CommandInput placeholder="Search pages, indices, saved queries..." />
      <CommandList>
        <CommandEmpty>
          {loading ? "Loading..." : "No results found."}
        </CommandEmpty>

        {/* Clusters */}
        {clusters.length > 0 && (
          <CommandGroup heading="Clusters">
            {clusters.map((cluster) => (
              <CommandItem
                key={cluster.id}
                value={`cluster-${cluster.id}`}
                keywords={[cluster.name, cluster.url]}
                onSelect={() => handleSelect(() => onSelectCluster(cluster))}
              >
                <span
                  className="size-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: cluster.color }}
                />
                <span>{cluster.name}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {/* Navigation */}
        <CommandGroup heading="Navigation">
          {NAV_ITEMS.map(({ page, label, icon, shortcut }) => (
            <CommandItem
              key={page}
              value={`nav-${page}`}
              keywords={[label, page]}
              onSelect={() => handleSelect(() => onNavigate(page))}
            >
              {icon}
              <span>{label}</span>
              {shortcut && <CommandShortcut>{shortcut}</CommandShortcut>}
            </CommandItem>
          ))}
        </CommandGroup>

        {/* Indices */}
        {indices.length > 0 && (
          <CommandGroup heading="Indices">
            {indices.map(({ name, aliases }) => (
              <CommandItem
                key={name}
                value={`index-${name}`}
                keywords={[name, ...aliases]}
                onSelect={() => handleSelect(() => onSelectIndex(name))}
              >
                <DatabaseIcon className="size-4" />
                <span className="font-mono text-sm truncate">{name}</span>
                {aliases.length > 0 && (
                  <CommandShortcut>
                    {aliases.slice(0, 2).join(", ")}
                    {aliases.length > 2 && ` +${aliases.length - 2}`}
                  </CommandShortcut>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {/* Saved Queries */}
        {savedQueries.length > 0 && (
          <CommandGroup heading="Saved Queries">
            {savedQueries.map((query) => (
              <CommandItem
                key={query.id}
                value={`query-${query.id}-${query.name}`}
                keywords={[query.name, query.method, query.endpoint]}
                onSelect={() => handleSelect(() => onSelectSavedQuery(query))}
              >
                <BookmarkIcon className="size-4" />
                <span className="truncate">{query.name}</span>
                <CommandShortcut>
                  <span className="font-mono">
                    {query.method} {query.endpoint}
                  </span>
                </CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
