import { useState, useEffect, useCallback } from "react";
import { Navbar } from "@/components/navbar";
import { ClusterDialog } from "@/components/add-cluster-dialog";
import { DashboardPage } from "@/components/dashboard-page";
import { IndicesPage } from "@/components/indices-page";
import { DocumentsPage } from "@/components/documents-page";
import { RestPage } from "@/components/rest-page";
import { useHashRoute } from "@/hooks/use-hash-route";
import {
  saveCredential,
  readCredential,
} from "@/page/use-lock-session";
import type { ClusterConfig } from "@/types/cluster";

const CLUSTERS_CREDENTIAL_ID = "cluster_configs";
const LAST_CLUSTER_KEY = "indexlens_last_cluster";

interface UnlockedShellProps {
  onLock: () => Promise<void>;
}

export function UnlockedShell({ onLock }: UnlockedShellProps) {
  const [clusters, setClusters] = useState<ClusterConfig[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingCluster, setEditingCluster] = useState<ClusterConfig | undefined>(undefined);
  const [loaded, setLoaded] = useState(false);

  const { clusterId, page, indexName, navigate, navigateCluster, navigatePage, navigateIndex } =
    useHashRoute();

  const activeCluster = clusters.find((c) => c.id === clusterId) ?? null;

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
    <div className="flex flex-col w-full min-h-screen">
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

      <main className="flex-1 flex flex-col">
        {!activeCluster ? (
          <div className="flex-1 flex items-center justify-center p-6">
            <p className="text-muted-foreground">
              No cluster selected. Add one to get started.
            </p>
          </div>
        ) : page === "indices" && indexName ? (
          <DocumentsPage
            cluster={activeCluster}
            indexName={indexName}
          />
        ) : page === "indices" ? (
          <IndicesPage cluster={activeCluster} onNavigateIndex={navigateIndex} />
        ) : page === "rest" ? (
          <RestPage cluster={activeCluster} />
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
    </div>
  );
}
