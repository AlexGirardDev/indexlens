import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  SearchIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ArrowUpIcon,
  ArrowDownIcon,
  ArrowUpDownIcon,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { useDebounce } from "@/hooks/use-debounce";
import { esRequest, EsRequestError } from "@/lib/es-client";
import type { ClusterConfig } from "@/types/cluster";
import {
  IndexActionsDropdown,
  BulkActionsBar,
  ActionDialogs,
  executeRefresh,
  type ActionDialog,
} from "@/components/index-actions";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CatIndexRecord {
  index: string;
  pri: string;
  rep: string;
  "docs.count": string | null;
  "store.size": string | null;
  "creation.date.string": string;
}

interface CatAliasRecord {
  alias: string;
  index: string;
}

interface IndexRow {
  name: string;
  aliases: string[];
  primaryShards: number;
  replicaShards: number;
  docsCount: number;
  storeSize: string;
  storeSizeBytes: number;
  createdAt: string;
  createdAtMs: number;
}

type SortKey = "name" | "primaryShards" | "docsCount" | "storeSizeBytes" | "createdAtMs";
type SortDir = "asc" | "desc";

interface SortState {
  key: SortKey;
  dir: SortDir;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_PAGE_SIZE = 20;
const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];
const DEBOUNCE_MS = 300;
const COL_SPAN = 8;

const CAT_INDICES_COLS = "index,pri,rep,docs.count,store.size,creation.date.string";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SIZE_MULTIPLIERS: Record<string, number> = {
  b: 1,
  kb: 1024,
  mb: 1024 ** 2,
  gb: 1024 ** 3,
  tb: 1024 ** 4,
  pb: 1024 ** 5,
};

function parseSizeToBytes(size: string): number {
  if (!size || size === "-") return 0;
  const match = size.match(/^([\d.]+)\s*([a-z]+)$/i);
  if (!match) return 0;
  return parseFloat(match[1]) * (SIZE_MULTIPLIERS[match[2].toLowerCase()] ?? 1);
}

const SIZE_UNIT_DISPLAY: Record<string, string> = {
  b: "B",
  kb: "KB",
  mb: "MB",
  gb: "GB",
  tb: "TB",
  pb: "PB",
};

function formatSize(size: string): string {
  if (!size || size === "-") return "-";
  const match = size.match(/^([\d.]+)\s*([a-z]+)$/i);
  if (!match) return size;
  const unit = match[2].toLowerCase();
  return `${match[1]} ${SIZE_UNIT_DISPLAY[unit] ?? match[2].toUpperCase()}`;
}

function buildAliasMap(aliases: CatAliasRecord[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const { index, alias } of aliases) {
    const list = map.get(index);
    if (list) {
      list.push(alias);
    } else {
      map.set(index, [alias]);
    }
  }
  return map;
}

function joinRows(
  indices: CatIndexRecord[],
  aliasMap: Map<string, string[]>,
): IndexRow[] {
  return indices.map((idx) => {
    const storeSize = idx["store.size"] ?? "-";
    const createdAt = idx["creation.date.string"] ?? "";
    return {
      name: idx.index,
      aliases: aliasMap.get(idx.index) ?? [],
      primaryShards: Number(idx.pri) || 0,
      replicaShards: Number(idx.rep) || 0,
      docsCount: Number(idx["docs.count"]) || 0,
      storeSize,
      storeSizeBytes: parseSizeToBytes(storeSize),
      createdAt,
      createdAtMs: createdAt ? new Date(createdAt).getTime() || 0 : 0,
    };
  });
}

function compareRows(a: IndexRow, b: IndexRow, sort: SortState): number {
  const { key, dir } = sort;
  let cmp: number;

  if (key === "name") {
    cmp = a.name.localeCompare(b.name);
  } else {
    cmp = (a[key] as number) - (b[key] as number);
  }

  return dir === "asc" ? cmp : -cmp;
}

const numFmt = new Intl.NumberFormat();
const dateFmt = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function formatDate(iso: string): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return dateFmt.format(d);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface IndicesPageProps {
  cluster: ClusterConfig;
  onNavigateIndex: (indexName: string) => void;
  filter: string;
  onFilterChange: (value: string) => void;
}

export function IndicesPage({ cluster, onNavigateIndex, filter, onFilterChange }: IndicesPageProps) {
  const debouncedFilter = useDebounce(filter, DEBOUNCE_MS);

  const [rows, setRows] = useState<IndexRow[]>([]);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showSystem, setShowSystem] = useState(false);
  const [sort, setSort] = useState<SortState>({ key: "name", dir: "asc" });
  const [refreshKey, setRefreshKey] = useState(0);

  // Selection state
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Action dialog state
  const [actionDialog, setActionDialog] = useState<ActionDialog | null>(null);

  // Reset page when filter or page size changes
  useEffect(() => {
    setPage(0);
  }, [debouncedFilter, pageSize, showSystem]);

  // Clear selection when data, page, filter, sort changes
  useEffect(() => {
    setSelected(new Set());
  }, [rows, page, debouncedFilter, sort, showSystem]);

  // Fetch indices + aliases
  const fetchIndices = useCallback(
    async (signal: AbortSignal) => {
      setLoading(true);
      setError(null);

      try {
        const pattern = debouncedFilter
          ? `/*${encodeURIComponent(debouncedFilter)}*`
          : "";

        const fetchOpts = { signal };
        const [catIndices, catAliases] = await Promise.all([
          esRequest<CatIndexRecord[]>(
            cluster,
            `/_cat/indices${pattern}?format=json&h=${CAT_INDICES_COLS}&s=index&expand_wildcards=all`,
            fetchOpts,
          ).catch((err) => {
            if (err instanceof EsRequestError && err.status === 404) return [];
            throw err;
          }),
          esRequest<CatAliasRecord[]>(
            cluster,
            `/_cat/aliases?format=json&h=alias,index`,
            fetchOpts,
          ).catch(() => [] as CatAliasRecord[]),
        ]);

        if (signal.aborted) return;

        const aliasMap = buildAliasMap(catAliases);
        setRows(joinRows(catIndices, aliasMap));
      } catch (err) {
        if (signal.aborted) return;
        setError(
          err instanceof Error ? err.message : "Failed to fetch indices",
        );
        setRows([]);
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    [cluster, debouncedFilter, refreshKey],
  );

  useEffect(() => {
    const controller = new AbortController();
    fetchIndices(controller.signal);
    return () => controller.abort();
  }, [fetchIndices]);

  // Filter → sort → paginate
  const filtered = useMemo(
    () => (showSystem ? rows : rows.filter((r) => !r.name.startsWith("."))),
    [rows, showSystem],
  );

  const sorted = useMemo(
    () => [...filtered].sort((a, b) => compareRows(a, b, sort)),
    [filtered, sort],
  );

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const pageRows = sorted.slice(safePage * pageSize, (safePage + 1) * pageSize);
  const rangeStart = sorted.length === 0 ? 0 : safePage * pageSize + 1;
  const rangeEnd = Math.min((safePage + 1) * pageSize, sorted.length);

  // Sort handler
  const handleSort = (key: SortKey) => {
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: "asc" },
    );
    setPage(0);
  };

  // Selection helpers
  const allPageSelected = pageRows.length > 0 && pageRows.every((r) => selected.has(r.name));
  const somePageSelected = pageRows.some((r) => selected.has(r.name));

  const handleSelectAll = () => {
    if (allPageSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(pageRows.map((r) => r.name)));
    }
  };

  const handleSelectRow = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  };

  // Action handler
  const handleAction = (action: string, indexNames: string[]) => {
    if (action === "refresh") {
      executeRefresh(cluster, indexNames, () => {
        setRefreshKey((k) => k + 1);
        if (indexNames.length > 1) setSelected(new Set());
      });
      return;
    }
    setActionDialog({ action, indexNames });
  };

  const handleActionSuccess = () => {
    setRefreshKey((k) => k + 1);
    if (actionDialog && actionDialog.indexNames.length > 1) {
      setSelected(new Set());
    }
  };

  return (
    <div className="flex flex-col gap-4 p-6 h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-4 flex-wrap">
        <div className="relative max-w-sm">
          <SearchIcon className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input
            placeholder="Filter indices..."
            value={filter}
            onChange={(e) => onFilterChange(e.target.value)}
            className="pl-9"
          />
        </div>

        <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showSystem}
            onChange={(e) => setShowSystem(e.target.checked)}
            className="size-4 rounded border-input accent-primary"
          />
          Show system indices
        </label>
      </div>

      {/* Table */}
      <div className="rounded-md border flex-1 overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[40px]">
                <IndeterminateCheckbox
                  checked={allPageSelected}
                  indeterminate={somePageSelected && !allPageSelected}
                  onChange={handleSelectAll}
                  disabled={pageRows.length === 0}
                />
              </TableHead>
              <SortableHead
                sortKey="name"
                current={sort}
                onSort={handleSort}
                className="min-w-[200px]"
              >
                Index Name
              </SortableHead>
              <TableHead className="min-w-[140px]">Aliases</TableHead>
              <SortableHead
                sortKey="primaryShards"
                current={sort}
                onSort={handleSort}
                className="w-[120px]"
              >
                Shards
              </SortableHead>
              <SortableHead
                sortKey="docsCount"
                current={sort}
                onSort={handleSort}
                className="w-[100px] text-right"
                alignRight
              >
                Docs
              </SortableHead>
              <SortableHead
                sortKey="storeSizeBytes"
                current={sort}
                onSort={handleSort}
                className="w-[100px] text-right"
                alignRight
              >
                Storage Size
              </SortableHead>
              <SortableHead
                sortKey="createdAtMs"
                current={sort}
                onSort={handleSort}
                className="w-[180px]"
              >
                Date Created
              </SortableHead>
              <TableHead className="w-[70px]">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <SkeletonRows />
            ) : error ? (
              <TableRow>
                <TableCell
                  colSpan={COL_SPAN}
                  className="h-24 text-center text-destructive"
                >
                  {error}
                </TableCell>
              </TableRow>
            ) : sorted.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={COL_SPAN}
                  className="h-24 text-center text-muted-foreground"
                >
                  {debouncedFilter
                    ? `No indices matching "${debouncedFilter}"`
                    : "No indices found"}
                </TableCell>
              </TableRow>
            ) : (
              pageRows.map((row) => (
                <TableRow key={row.name} data-state={selected.has(row.name) ? "selected" : undefined}>
                  <TableCell>
                    <input
                      type="checkbox"
                      checked={selected.has(row.name)}
                      onChange={() => handleSelectRow(row.name)}
                      className="size-4 rounded border-input accent-primary"
                    />
                  </TableCell>
                  <TableCell className="font-mono text-sm">
                    <button
                      className="text-primary hover:underline cursor-pointer text-left"
                      onClick={() => onNavigateIndex(row.name)}
                    >
                      {row.name}
                    </button>
                  </TableCell>
                  <TableCell>
                    {row.aliases.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {row.aliases.map((alias) => (
                          <Badge key={alias} variant="secondary" className="text-xs">
                            {alias}
                          </Badge>
                        ))}
                      </div>
                    ) : (
                      <span className="text-muted-foreground text-sm">-</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1.5">
                      <Badge variant="default" className="text-xs tabular-nums">
                        {row.primaryShards}P
                      </Badge>
                      <Badge variant="outline" className="text-xs tabular-nums">
                        {row.replicaShards}R
                      </Badge>
                    </div>
                  </TableCell>
                  <TableCell className="text-right text-sm tabular-nums">
                    {numFmt.format(row.docsCount)}
                  </TableCell>
                  <TableCell className="text-right text-sm tabular-nums">
                    {formatSize(row.storeSize)}
                  </TableCell>
                  <TableCell className="text-sm">
                    {formatDate(row.createdAt)}
                  </TableCell>
                  <TableCell>
                    <IndexActionsDropdown
                      indexName={row.name}
                      onAction={handleAction}
                    />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Bulk actions bar */}
      <BulkActionsBar
        selected={selected}
        onAction={handleAction}
        onClear={() => setSelected(new Set())}
      />

      {/* Pagination */}
      {!loading && sorted.length > 0 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground tabular-nums">
            {rangeStart}&ndash;{rangeEnd} of {numFmt.format(sorted.length)} indices
          </span>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground whitespace-nowrap">Rows</span>
              <Select
                value={String(pageSize)}
                onValueChange={(v) => setPageSize(Number(v))}
              >
                <SelectTrigger size="sm" className="w-[70px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  {PAGE_SIZE_OPTIONS.map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                disabled={safePage === 0}
                onClick={() => setPage((p) => p - 1)}
              >
                <ChevronLeftIcon className="size-4" />
                Previous
              </Button>
              <span className="px-2 text-muted-foreground tabular-nums">
                {safePage + 1} / {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={safePage >= totalPages - 1}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
                <ChevronRightIcon className="size-4" />
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Action dialogs */}
      <ActionDialogs
        actionDialog={actionDialog}
        cluster={cluster}
        onClose={() => setActionDialog(null)}
        onSuccess={handleActionSuccess}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Indeterminate checkbox
// ---------------------------------------------------------------------------

function IndeterminateCheckbox({
  checked,
  indeterminate,
  onChange,
  disabled,
}: {
  checked: boolean;
  indeterminate: boolean;
  onChange: () => void;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (ref.current) {
      ref.current.indeterminate = indeterminate;
    }
  }, [indeterminate]);

  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={onChange}
      disabled={disabled}
      className="size-4 rounded border-input accent-primary"
    />
  );
}

// ---------------------------------------------------------------------------
// Sortable table header
// ---------------------------------------------------------------------------

function SortableHead({
  children,
  sortKey,
  current,
  onSort,
  className,
  alignRight,
}: {
  children: React.ReactNode;
  sortKey: SortKey;
  current: SortState;
  onSort: (key: SortKey) => void;
  className?: string;
  alignRight?: boolean;
}) {
  const active = current.key === sortKey;

  const icon = active ? (
    current.dir === "asc" ? (
      <ArrowUpIcon className="size-3.5" />
    ) : (
      <ArrowDownIcon className="size-3.5" />
    )
  ) : (
    <ArrowUpDownIcon className="size-3.5 opacity-30" />
  );

  return (
    <TableHead
      className={cn("cursor-pointer select-none hover:text-foreground", className)}
      onClick={() => onSort(sortKey)}
    >
      <div className={cn("flex items-center gap-1", alignRight && "justify-end")}>
        {children}
        {icon}
      </div>
    </TableHead>
  );
}

// ---------------------------------------------------------------------------
// Skeleton loading rows
// ---------------------------------------------------------------------------

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 8 }, (_, i) => (
        <TableRow key={i}>
          <TableCell><Skeleton className="h-4 w-4" /></TableCell>
          <TableCell><Skeleton className="h-4 w-40" /></TableCell>
          <TableCell><Skeleton className="h-4 w-24" /></TableCell>
          <TableCell><Skeleton className="h-4 w-16" /></TableCell>
          <TableCell className="text-right"><Skeleton className="h-4 w-14 ml-auto" /></TableCell>
          <TableCell className="text-right"><Skeleton className="h-4 w-14 ml-auto" /></TableCell>
          <TableCell><Skeleton className="h-4 w-28" /></TableCell>
          <TableCell><Skeleton className="h-4 w-8" /></TableCell>
        </TableRow>
      ))}
    </>
  );
}
