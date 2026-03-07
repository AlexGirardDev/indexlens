import { useState, useEffect, useCallback, useRef } from "react";
import { Navbar } from "@/components/navbar";
import { ClusterDialog } from "@/components/add-cluster-dialog";
import { DashboardPage } from "@/components/dashboard-page";
import { IndicesPage } from "@/components/indices-page";
import { DocumentsPage } from "@/components/documents-page";
import { RestPage } from "@/components/rest-page";
import { SettingsPage } from "@/components/settings-page";
import { ScoutSearch } from "@/components/scout-search";
import type { ScoutIndex } from "@/components/scout-search";
import { useHashRoute } from "@/hooks/use-hash-route";
import {
  saveCredential,
  readCredential,
} from "@/page/use-lock-session";
import { esRequest } from "@/lib/es-client";
import { loadSavedQueries } from "@/lib/rest-query-storage";
import { loadGlobalSettings, setVimMode } from "@/lib/global-settings";
import type { SavedQuery } from "@/lib/rest-query-storage";
import type { ClusterConfig } from "@/types/cluster";

const CLUSTERS_CREDENTIAL_ID = "cluster_configs";
const LAST_CLUSTER_KEY = "indexlens_last_cluster";

/** Shape passed from Scout selection to RestPage for preloading a query. */
export interface PendingRestQuery {
  method: string;
  endpoint: string;
  body: string;
}

interface UnlockedShellProps {
  onLock: () => Promise<void>;
}

export function UnlockedShell({ onLock }: UnlockedShellProps) {
  const [clusters, setClusters] = useState<ClusterConfig[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingCluster, setEditingCluster] = useState<ClusterConfig | undefined>(undefined);
  const [loaded, setLoaded] = useState(false);

  // Scout state
  const [scoutOpen, setScoutOpen] = useState(false);
  const [scoutIndices, setScoutIndices] = useState<ScoutIndex[]>([]);
  const [scoutSavedQueries, setScoutSavedQueries] = useState<SavedQuery[]>([]);
  const [scoutLoading, setScoutLoading] = useState(false);

  // Vim mode (global setting)
  const [vimMode, setVimModeState] = useState(() => loadGlobalSettings().vimModeEnabled);
  const handleVimModeChange = useCallback((enabled: boolean) => {
    setVimModeState(enabled);
    setVimMode(enabled);
  }, []);

  // REST query handoff
  const [pendingRestQuery, setPendingRestQuery] = useState<PendingRestQuery | null>(null);
  const pendingRestQueryRef = useRef<PendingRestQuery | null>(null);

  const { clusterId, page, indexName, navigate, navigateCluster, navigatePage, navigateIndex } =
    useHashRoute();

  const activeCluster = clusters.find((c) => c.id === clusterId) ?? null;

  // Update browser tab title based on active cluster
  useEffect(() => {
    document.title = activeCluster ? `IndexLens | ${activeCluster.name}` : "IndexLens";
  }, [activeCluster?.name]);

  // Load clusters from encrypted vault on mount
  useEffect(() => {
    (async () => {
      const res = await readCredential(CLUSTERS_CREDENTIAL_ID);
      if (res.ok && res.data) {
        try {
          const parsed = JSON.parse(res.data) as ClusterConfig[];
          setClusters(parsed);

          // Restore last used cluster if no cluster in the hash
          if (!clusterId) {
            const lastId = localStorage.getItem(LAST_CLUSTER_KEY);
            if (lastId && parsed.some((c) => c.id === lastId)) {
              navigate(lastId, "dashboard");
            }
          }
        } catch {
          // corrupted data — start fresh
        }
      }
      setLoaded(true);
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Remember the active cluster
  useEffect(() => {
    if (clusterId) {
      localStorage.setItem(LAST_CLUSTER_KEY, clusterId);
    }
  }, [clusterId]);

  // Persist clusters to encrypted vault
  const persistClusters = useCallback(async (next: ClusterConfig[]) => {
    await saveCredential(CLUSTERS_CREDENTIAL_ID, JSON.stringify(next));
  }, []);

  // -----------------------------------------------------------------------
  // Global keyboard shortcuts: Ctrl+Space (Scout), Ctrl+L (Lock)
  // -----------------------------------------------------------------------

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.code === "Space") {
        e.preventDefault();
        setScoutOpen((prev) => !prev);
      } else if (e.ctrlKey && e.key === "l") {
        e.preventDefault();
        void onLock();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [onLock]);

  // -----------------------------------------------------------------------
  // Scout: fetch indices + aliases when opened (or cluster changes)
  // -----------------------------------------------------------------------

  useEffect(() => {
    if (!scoutOpen || !activeCluster) {
      return;
    }

    setScoutLoading(true);
    const controller = new AbortController();

    Promise.all([
      esRequest<Array<{ index: string }>>(
        activeCluster,
        "/_cat/indices?format=json&h=index&s=index&expand_wildcards=all",
        { signal: controller.signal },
      ).catch(() => [] as Array<{ index: string }>),
      esRequest<Array<{ alias: string; index: string }>>(
        activeCluster,
        "/_cat/aliases?format=json&h=alias,index",
        { signal: controller.signal },
      ).catch(() => [] as Array<{ alias: string; index: string }>),
    ]).then(([indicesRes, aliasesRes]) => {
      if (controller.signal.aborted) return;

      // Build alias map: indexName → alias[]
      const aliasMap = new Map<string, string[]>();
      for (const { alias, index } of aliasesRes) {
        const list = aliasMap.get(index);
        if (list) list.push(alias);
        else aliasMap.set(index, [alias]);
      }

      const items: ScoutIndex[] = indicesRes
        .filter((r) => !r.index.startsWith("."))
        .map((r) => ({
          name: r.index,
          aliases: aliasMap.get(r.index) ?? [],
        }));

      setScoutIndices(items);
      setScoutLoading(false);
    });

    // Load saved queries synchronously from localStorage
    setScoutSavedQueries(loadSavedQueries(activeCluster.id));

    return () => controller.abort();
  }, [scoutOpen, activeCluster]);

  // -----------------------------------------------------------------------
  // Scout selection handlers
  // -----------------------------------------------------------------------

  const handleScoutNavigate = useCallback(
    (p: import("@/types/cluster").Page) => {
      navigatePage(p);
    },
    [navigatePage],
  );

  const handleScoutSelectIndex = useCallback(
    (indexName: string) => {
      navigateIndex(indexName);
    },
    [navigateIndex],
  );

  const handleScoutSelectCluster = useCallback(
    (cluster: ClusterConfig) => {
      navigate(cluster.id, page === "indices" ? "dashboard" : page);
    },
    [navigate, page],
  );

  const handleScoutSelectSavedQuery = useCallback(
    (query: SavedQuery) => {
      const pending: PendingRestQuery = {
        method: query.method,
        endpoint: query.endpoint,
        body: query.body,
      };
      pendingRestQueryRef.current = pending;
      setPendingRestQuery(pending);
      navigatePage("rest");
    },
    [navigatePage],
  );

  const consumePendingRestQuery = useCallback(() => {
    const q = pendingRestQueryRef.current;
    pendingRestQueryRef.current = null;
    setPendingRestQuery(null);
    return q;
  }, []);

  // -----------------------------------------------------------------------
  // Cluster dialog handlers
  // -----------------------------------------------------------------------

  const handleAddCluster = () => {
    setEditingCluster(undefined);
    setDialogOpen(true);
  };

  const handleEditCluster = (cluster: ClusterConfig) => {
    setEditingCluster(cluster);
    setDialogOpen(true);
  };

  const handleDialogSubmit = async (cluster: ClusterConfig) => {
    let next: ClusterConfig[];
    if (editingCluster) {
      // Replace existing cluster in-place (preserve ordering)
      next = clusters.map((c) => (c.id === cluster.id ? cluster : c));
    } else {
      next = [...clusters, cluster];
      navigate(cluster.id, "dashboard");
    }
    setClusters(next);
    await persistClusters(next);
  };

  const handleImportClusters = useCallback(async (imported: ClusterConfig[]) => {
    const next = [...clusters];
    for (const c of imported) {
      if (!next.some((existing) => existing.id === c.id)) {
        next.push(c);
      }
    }
    setClusters(next);
    await persistClusters(next);
  }, [clusters, persistClusters]);

  const handleDialogOpenChange = (open: boolean) => {
    setDialogOpen(open);
    if (!open) {
      setEditingCluster(undefined);
    }
  };

  if (!loaded) {
    return (
      <div className="flex flex-col w-full min-h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-muted border-t-primary" />
      </div>
    );
  }

  return (
    <div className="flex h-screen w-full flex-col overflow-hidden">
      <Navbar
        clusters={clusters}
        activeCluster={activeCluster}
        activePage={page}
        onSelectCluster={(c) => navigateCluster(c.id)}
        onAddCluster={handleAddCluster}
        onEditCluster={handleEditCluster}
        onNavigate={navigatePage}
        onLock={onLock}
      />

      <main className="flex min-h-0 flex-1 flex-col">
        {page === "settings" ? (
          <SettingsPage
            clusters={clusters}
            onClustersChange={handleImportClusters}
            vimMode={vimMode}
            onVimModeChange={handleVimModeChange}
          />
        ) : !activeCluster ? (
          <div className="flex-1 flex items-center justify-center p-6">
            <p className="text-muted-foreground">
              No cluster selected. Add one to get started.
            </p>
          </div>
        ) : page === "indices" && indexName ? (
          <DocumentsPage
            key={indexName}
            cluster={activeCluster}
            indexName={indexName}
            vimMode={vimMode}
            onVimModeChange={handleVimModeChange}
          />
        ) : page === "indices" ? (
          <IndicesPage cluster={activeCluster} onNavigateIndex={navigateIndex} />
        ) : page === "rest" ? (
          <RestPage
            cluster={activeCluster}
            pendingQuery={pendingRestQuery}
            consumePendingQuery={consumePendingRestQuery}
            vimMode={vimMode}
            onVimModeChange={handleVimModeChange}
          />
        ) : (
          <DashboardPage cluster={activeCluster} />
        )}
      </main>

      <ClusterDialog
        open={dialogOpen}
        onOpenChange={handleDialogOpenChange}
        onSubmit={handleDialogSubmit}
        initial={editingCluster}
      />

      <ScoutSearch
        open={scoutOpen}
        onOpenChange={setScoutOpen}
        onNavigate={handleScoutNavigate}
        onSelectIndex={handleScoutSelectIndex}
        onSelectSavedQuery={handleScoutSelectSavedQuery}
        indices={scoutIndices}
        savedQueries={scoutSavedQueries}
        clusters={clusters.filter((c) => c.id !== activeCluster?.id)}
        onSelectCluster={handleScoutSelectCluster}
        loading={scoutLoading}
      />
    </div>
  );
}
