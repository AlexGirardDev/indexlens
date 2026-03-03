import {
  ChevronDownIcon,
  DatabaseIcon,
  LayoutDashboardIcon,
  ListIcon,
  LockIcon,
  PencilIcon,
  PlusIcon,
  SettingsIcon,
  TerminalIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { ClusterConfig, Page } from "@/types/cluster";

interface NavbarProps {
  clusters: ClusterConfig[];
  activeCluster: ClusterConfig | null;
  activePage: Page;
  onSelectCluster: (cluster: ClusterConfig) => void;
  onAddCluster: () => void;
  onEditCluster: (cluster: ClusterConfig) => void;
  onNavigate: (page: Page) => void;
  onLock: () => void;
}

// eslint-disable-next-line react-refresh/only-export-components
export const NAV_ITEMS: { page: Page; label: string; icon: React.ReactNode }[] = [
  { page: "dashboard", label: "Dashboard", icon: <LayoutDashboardIcon className="size-4" /> },
  { page: "indices", label: "Indices", icon: <ListIcon className="size-4" /> },
  { page: "rest", label: "Rest", icon: <TerminalIcon className="size-4" /> },
  { page: "settings", label: "Settings", icon: <SettingsIcon className="size-4" /> },
];

export function Navbar({
  clusters,
  activeCluster,
  activePage,
  onSelectCluster,
  onAddCluster,
  onEditCluster,
  onNavigate,
  onLock,
}: NavbarProps) {
  return (
    <header className="flex items-center border-b px-4 h-12 gap-1 shrink-0">
      {/* Cluster selector */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="gap-2 font-semibold">
            {activeCluster ? (
              <>
                <span
                  className="size-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: activeCluster.color }}
                />
                {activeCluster.name}
              </>
            ) : (
              <>
                <DatabaseIcon className="size-4" />
                Clusters
              </>
            )}
            <ChevronDownIcon className="size-3.5 opacity-50" />
          </Button>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="start" className="w-56">
          {clusters.length > 0 && (
            <>
              <DropdownMenuLabel>Clusters</DropdownMenuLabel>
              {clusters.map((cluster) => (
                <DropdownMenuItem
                  key={cluster.id}
                  onClick={() => onSelectCluster(cluster)}
                  className="gap-2"
                >
                  <span
                    className="size-2.5 rounded-full shrink-0"
                    style={{ backgroundColor: cluster.color }}
                  />
                  <span className="truncate">{cluster.name}</span>
                  {activeCluster?.id === cluster.id && (
                    <span className="ml-auto text-xs text-muted-foreground">active</span>
                  )}
                  <button
                    type="button"
                    className="ml-auto p-0.5 rounded hover:bg-accent"
                    aria-label={`Edit ${cluster.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onEditCluster(cluster);
                    }}
                  >
                    <PencilIcon className="size-3" />
                  </button>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem onClick={onAddCluster} className="gap-2">
            <PlusIcon className="size-4" />
            Add cluster
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Separator */}
      <div className="mx-1 h-5 w-px bg-border" />

      {/* Page nav */}
      <nav className="flex items-center gap-0.5">
        {NAV_ITEMS.map(({ page, label, icon }) => (
          <Button
            key={page}
            variant="ghost"
            size="sm"
            className={cn(
              "gap-1.5 text-muted-foreground",
              activePage === page && "text-foreground bg-accent",
            )}
            onClick={() => onNavigate(page)}
          >
            {icon}
            {label}
          </Button>
        ))}
      </nav>

      {/* Right side */}
      <div className="ml-auto">
        <Button variant="ghost" size="sm" onClick={onLock} className="gap-1.5 text-muted-foreground">
          <LockIcon className="size-3.5" />
          Lock
        </Button>
      </div>
    </header>
  );
}
