import { useState, useEffect, useCallback } from "react";
import {
  DatabaseIcon,
  FileTextIcon,
  HardDriveIcon,
  HeartPulseIcon,
  ServerIcon,
  LayersIcon,
  AlertTriangleIcon,
  ClockIcon,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { esRequest } from "@/lib/es-client";
import type { ClusterConfig } from "@/types/cluster";

// ---------------------------------------------------------------------------
// Types — Elasticsearch responses
// ---------------------------------------------------------------------------

interface ClusterHealth {
  cluster_name: string;
  status: "green" | "yellow" | "red";
  timed_out: boolean;
  number_of_nodes: number;
  number_of_data_nodes: number;
  active_primary_shards: number;
  active_shards: number;
  relocating_shards: number;
  initializing_shards: number;
  unassigned_shards: number;
  delayed_unassigned_shards: number;
  number_of_pending_tasks: number;
  number_of_in_flight_fetch: number;
  task_max_waiting_in_queue_millis: number;
  active_shards_percent_as_number: number;
}

interface ClusterStats {
  cluster_name: string;
  cluster_uuid: string;
  status: string;
  indices: {
    count: number;
    shards: {
      total: number;
      primaries: number;
      replication: number;
    };
    docs: {
      count: number;
      deleted: number;
    };
    store: {
      size_in_bytes: number;
    };
  };
  nodes: {
    count: {
      total: number;
      data: number;
      coordinating_only: number;
      master: number;
      ingest: number;
    };
    jvm: {
      mem: {
        heap_used_in_bytes: number;
        heap_max_in_bytes: number;
      };
    };
  };
}

interface DashboardData {
  health: ClusterHealth;
  stats: ClusterStats;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const numFmt = new Intl.NumberFormat();

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(value < 10 ? 2 : value < 100 ? 1 : 0)} ${units[i]}`;
}

function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

const STATUS_COLORS: Record<string, string> = {
  green: "bg-green-500",
  yellow: "bg-yellow-500",
  red: "bg-red-500",
};

const STATUS_BADGE_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  green: "default",
  yellow: "secondary",
  red: "destructive",
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface DashboardPageProps {
  cluster: ClusterConfig;
}

export function DashboardPage({ cluster }: DashboardPageProps) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchDashboard = useCallback(
    async (signal: AbortSignal) => {
      setLoading(true);
      setError(null);

      try {
        const [health, stats] = await Promise.all([
          esRequest<ClusterHealth>(cluster, "/_cluster/health", { signal }),
          esRequest<ClusterStats>(cluster, "/_cluster/stats", { signal }),
        ]);

        if (signal.aborted) return;
        setData({ health, stats });
      } catch (err) {
        if (signal.aborted) return;
        setError(
          err instanceof Error ? err.message : "Failed to fetch cluster data",
        );
        setData(null);
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    [cluster],
  );

  useEffect(() => {
    const controller = new AbortController();
    fetchDashboard(controller.signal);
    return () => controller.abort();
  }, [fetchDashboard]);

  if (loading) {
    return <DashboardSkeleton />;
  }

  if (error) {
    return (
      <div className="flex flex-col gap-4 p-6">
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-6 text-center">
          <AlertTriangleIcon className="mx-auto mb-2 size-8 text-destructive" />
          <p className="text-sm font-medium text-destructive">{error}</p>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const { health, stats } = data;

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* Health status banner */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2.5">
          <span className={`size-3 rounded-full ${STATUS_COLORS[health.status] ?? "bg-muted"}`} />
          <h2 className="text-lg font-semibold">{health.cluster_name}</h2>
        </div>
        <Badge variant={STATUS_BADGE_VARIANT[health.status] ?? "outline"} className="capitalize">
          {health.status}
        </Badge>
        <span className="text-sm text-muted-foreground">
          {formatPercent(health.active_shards_percent_as_number)} active shards
        </span>
      </div>

      {/* Metric cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          title="Nodes"
          value={numFmt.format(health.number_of_nodes)}
          description={`${stats.nodes.count.data} data, ${stats.nodes.count.master} master`}
          icon={<ServerIcon className="size-4 text-muted-foreground" />}
        />
        <MetricCard
          title="Indices"
          value={numFmt.format(stats.indices.count)}
          description={`${numFmt.format(stats.indices.shards.primaries)} primary shards`}
          icon={<DatabaseIcon className="size-4 text-muted-foreground" />}
        />
        <MetricCard
          title="Documents"
          value={numFmt.format(stats.indices.docs.count)}
          description={`${numFmt.format(stats.indices.docs.deleted)} deleted`}
          icon={<FileTextIcon className="size-4 text-muted-foreground" />}
        />
        <MetricCard
          title="Storage"
          value={formatBytes(stats.indices.store.size_in_bytes)}
          description="Total store size"
          icon={<HardDriveIcon className="size-4 text-muted-foreground" />}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          title="Active Shards"
          value={numFmt.format(health.active_shards)}
          description={`${numFmt.format(health.active_primary_shards)} primary`}
          icon={<LayersIcon className="size-4 text-muted-foreground" />}
        />
        <MetricCard
          title="Unassigned Shards"
          value={numFmt.format(health.unassigned_shards)}
          description={`${numFmt.format(health.relocating_shards)} relocating, ${numFmt.format(health.initializing_shards)} initializing`}
          icon={<AlertTriangleIcon className="size-4 text-muted-foreground" />}
        />
        <MetricCard
          title="Pending Tasks"
          value={numFmt.format(health.number_of_pending_tasks)}
          description={health.task_max_waiting_in_queue_millis > 0 ? `Max wait: ${numFmt.format(health.task_max_waiting_in_queue_millis)}ms` : "No tasks queued"}
          icon={<ClockIcon className="size-4 text-muted-foreground" />}
        />
        <MetricCard
          title="JVM Heap"
          value={formatBytes(stats.nodes.jvm.mem.heap_used_in_bytes)}
          description={`of ${formatBytes(stats.nodes.jvm.mem.heap_max_in_bytes)} max`}
          icon={<HeartPulseIcon className="size-4 text-muted-foreground" />}
        />
      </div>

      {/* Node breakdown */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">Node Roles</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-3">
            <RoleBadge label="Total" count={stats.nodes.count.total} />
            <RoleBadge label="Data" count={stats.nodes.count.data} />
            <RoleBadge label="Master" count={stats.nodes.count.master} />
            <RoleBadge label="Ingest" count={stats.nodes.count.ingest} />
            <RoleBadge label="Coordinating Only" count={stats.nodes.count.coordinating_only} />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Metric card
// ---------------------------------------------------------------------------

function MetricCard({
  title,
  value,
  description,
  icon,
}: {
  title: string;
  value: string;
  description: string;
  icon: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {title}
        </CardTitle>
        {icon}
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold tabular-nums">{value}</div>
        <p className="text-xs text-muted-foreground mt-1">{description}</p>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Role badge
// ---------------------------------------------------------------------------

function RoleBadge({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center gap-2 rounded-md border px-3 py-1.5">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-semibold tabular-nums">{count}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skeleton loading state
// ---------------------------------------------------------------------------

function DashboardSkeleton() {
  return (
    <div className="flex flex-col gap-6 p-6">
      {/* Health banner skeleton */}
      <div className="flex items-center gap-4">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-5 w-16 rounded-full" />
      </div>

      {/* Metric cards skeleton */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Card key={i}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="size-4" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-7 w-24 mb-1" />
              <Skeleton className="h-3 w-32" />
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Card key={i}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="size-4" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-7 w-24 mb-1" />
              <Skeleton className="h-3 w-32" />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
