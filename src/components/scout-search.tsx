import { useState, useMemo, useCallback, useEffect } from "react";
import {
  LayoutDashboardIcon,
  ListIcon,
  TerminalIcon,
  SettingsIcon,
  DatabaseIcon,
  BookmarkIcon,
  ChevronRightIcon,
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
import {
  parseScoutInput,
  filterCommands,
  buildCommandInputValue,
  SCOUT_COMMANDS,
  type ScoutCommand,
} from "@/lib/scout-helpers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScoutIndex {
  name: string;
  aliases: string[];
}

export interface ScoutProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigate: (page: Page) => void;
  onSelectIndex: (indexName: string) => void;
  onSelectSavedQuery: (query: SavedQuery) => void;
  indices: ScoutIndex[];
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

export function ScoutSearch({
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
}: ScoutProps) {
  const [inputValue, setInputValue] = useState("");

  // Reset input when dialog closes
  useEffect(() => {
    if (!open) {
      setInputValue("");
    }
  }, [open]);

  const inputState = useMemo(() => parseScoutInput(inputValue), [inputValue]);

  const isCommandMode = inputState.mode !== "search";

  const handleSelectAndClose = useCallback(
    (callback: () => void) => {
      callback();
      onOpenChange(false);
    },
    [onOpenChange],
  );

  const handleSelectCommand = useCallback(
    (command: ScoutCommand) => {
      setInputValue(buildCommandInputValue(command));
    },
    [],
  );

  // Filter clusters when in command-active mode (Select Cluster)
  const filteredClusters = useMemo(() => {
    if (inputState.mode !== "command-active" || inputState.command.id !== "select-cluster") {
      return [];
    }
    const filter = inputState.filter.toLowerCase();
    if (!filter) return clusters;
    return clusters.filter(
      (c) =>
        c.name.toLowerCase().includes(filter) ||
        c.url.toLowerCase().includes(filter),
    );
  }, [inputState, clusters]);

  // Filter commands when in command-list mode
  const filteredCommandList = useMemo(() => {
    if (inputState.mode !== "command-list") return [];
    return filterCommands(SCOUT_COMMANDS, inputState.filter);
  }, [inputState]);

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Scout Search"
      description="Search for pages, indices, saved queries, and commands"
      showCloseButton={false}
      shouldFilter={!isCommandMode}
    >
      <CommandInput
        placeholder="Search pages, indices, saved queries... (> for commands)"
        value={inputValue}
        onValueChange={setInputValue}
      />
      <CommandList>
        <CommandEmpty>
          {loading ? "Loading..." : "No results found."}
        </CommandEmpty>

        {/* --- Command-list mode: show available commands --- */}
        {inputState.mode === "command-list" && (
          <CommandGroup heading="Commands">
            {filteredCommandList.map((cmd) => (
              <CommandItem
                key={cmd.id}
                value={cmd.id}
                onSelect={() => handleSelectCommand(cmd)}
              >
                <ChevronRightIcon className="size-4" />
                <span>{cmd.label}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {/* --- Command-active mode: Select Cluster --- */}
        {inputState.mode === "command-active" &&
          inputState.command.id === "select-cluster" && (
            <CommandGroup heading="Select Cluster">
              {filteredClusters.map((cluster) => (
                <CommandItem
                  key={cluster.id}
                  value={`cluster-${cluster.id}`}
                  onSelect={() =>
                    handleSelectAndClose(() => onSelectCluster(cluster))
                  }
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

        {/* --- Normal search mode --- */}
        {inputState.mode === "search" && (
          <>
            {/* Navigation */}
            <CommandGroup heading="Navigation">
              {NAV_ITEMS.map(({ page, label, icon, shortcut }) => (
                <CommandItem
                  key={page}
                  value={`nav-${page}`}
                  keywords={[label, page]}
                  onSelect={() =>
                    handleSelectAndClose(() => onNavigate(page))
                  }
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
                    onSelect={() =>
                      handleSelectAndClose(() => onSelectIndex(name))
                    }
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
                    onSelect={() =>
                      handleSelectAndClose(() => onSelectSavedQuery(query))
                    }
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
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
