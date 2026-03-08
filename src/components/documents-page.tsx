import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  Columns3Icon,
  DownloadIcon,
  Trash2Icon,
  Loader2Icon,
  ArrowUpIcon,
  ArrowDownIcon,
  ArrowUpDownIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { esRequest, EsRequestError } from "@/lib/es-client";
import { fetchIndexFields } from "@/lib/es-mapping";
import { useDebounce } from "@/hooks/use-debounce";
import { compileToEsQuery, ParseError } from "@/lib/query-parser";
import { QueryEditor } from "@/components/query-editor";
import { IndexPatternEditor } from "@/components/index-pattern-editor";
import type { IndexTarget } from "@/components/index-pattern-editor";
import { DocumentViewerSheet } from "@/components/document-viewer-sheet";
import type { MappingField } from "@/lib/es-mapping";
import type { ClusterConfig } from "@/types/cluster";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  hitKey,
  buildBulkDeleteBody,
  buildEsSortClause,
  resolveSortField,
  topLevelColumnsFromFields,
  type SortState,
  type SortDir,
} from "@/lib/document-helpers";
import {
  exportDocuments,
  encodeIndexPattern,
  type ExportFormat,
  type ExportProgress,
} from "@/lib/export-helpers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SearchHit {
  _id: string;
  _index: string;
  _version?: number;
  _score: number | null;
  _seq_no?: number;
  _primary_term?: number;
  _source: Record<string, unknown>;
}

interface SearchResponse {
  hits: {
    total: { value: number; relation: string };
    hits: SearchHit[];
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_PAGE_SIZE = 20;
const PAGE_SIZE_OPTIONS = [10, 20, 50];
const numFmt = new Intl.NumberFormat();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderCellValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface DocumentsPageProps {
  cluster: ClusterConfig;
  indexName: string;
  vimMode?: boolean;
  onVimModeChange?: (enabled: boolean) => void;
}

export function DocumentsPage({
  cluster,
  indexName,
  vimMode,
  onVimModeChange,
}: DocumentsPageProps) {
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [total, setTotal] = useState(0);
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(new Set());
  const [fields, setFields] = useState<MappingField[]>([]);
  const columns = useMemo(
    () => topLevelColumnsFromFields(fields),
    [fields],
  );
  const [activeQuery, setActiveQuery] = useState<object>({ match_all: {} });
  const [queryError, setQueryError] = useState<string | null>(null);
  const [selectedHit, setSelectedHit] = useState<SearchHit | null>(null);
  const [indexPattern, setIndexPattern] = useState(indexName);
  const [activeTarget, setActiveTarget] = useState(indexName);
  const [patternMatchCount, setPatternMatchCount] = useState<number | null>(null);
  const debouncedPattern = useDebounce(indexPattern, 300);
  const [indexTargets, setIndexTargets] = useState<IndexTarget[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const queryTextRef = useRef("");
  const [sort, setSort] = useState<SortState | null>(null);

  // Selection state – keys are hitKey(hit) = `_index\0_id`
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);

  // Clear selection when data, page, query, or target changes
  useEffect(() => {
    setSelected(new Set());
  }, [hits, page, activeQuery, activeTarget]);

  // Reset sort when the index target changes
  useEffect(() => {
    setSort(null);
  }, [activeTarget]);

  // Close document preview when navigating to a different index
  useEffect(() => {
    setSelectedHit(null);
  }, [indexName]);

  // Fetch mapping fields for autocomplete + query compilation
  useEffect(() => {
    const controller = new AbortController();
    fetchIndexFields(cluster, indexName, controller.signal)
      .then(setFields)
      .catch(() => {});
    return () => controller.abort();
  }, [cluster, indexName]);

  // Fetch all index names + aliases for autocomplete
  useEffect(() => {
    const controller = new AbortController();
    const opts = { signal: controller.signal };
    Promise.all([
      esRequest<Array<{ index: string }>>(
        cluster,
        "/_cat/indices?format=json&h=index&s=index&expand_wildcards=all",
        opts,
      ).catch(() => [] as Array<{ index: string }>),
      esRequest<Array<{ alias: string }>>(
        cluster,
        "/_cat/aliases?format=json&h=alias",
        opts,
      ).catch(() => [] as Array<{ alias: string }>),
    ]).then(([indices, aliases]) => {
      const indexNames = new Set(indices.map((r) => r.index));
      const targets: IndexTarget[] = indices.map((r) => ({
        name: r.index,
        kind: "index",
      }));
      const seen = new Set<string>();
      for (const a of aliases) {
        if (!indexNames.has(a.alias) && !seen.has(a.alias)) {
          seen.add(a.alias);
          targets.push({ name: a.alias, kind: "alias" });
        }
      }
      targets.sort((a, b) => a.name.localeCompare(b.name));
      setIndexTargets(targets);
    });
    return () => controller.abort();
  }, [cluster]);

  // Count indices matching the pattern (debounced)
  useEffect(() => {
    const trimmed = debouncedPattern.trim();
    if (!trimmed) {
      setPatternMatchCount(null);
      return;
    }
    // If pattern is exactly the indexName, skip the count
    if (trimmed === indexName) {
      setPatternMatchCount(null);
      return;
    }
    const controller = new AbortController();
    esRequest<Array<{ index: string }>>(
      cluster,
      `/_cat/indices/${encodeIndexPattern(trimmed)}?format=json&h=index&expand_wildcards=all`,
      { signal: controller.signal },
    )
      .then((result) => setPatternMatchCount(result.length))
      .catch((err) => {
        if (controller.signal.aborted) return;
        if (err instanceof EsRequestError && err.status === 404) {
          setPatternMatchCount(0);
        } else {
          setPatternMatchCount(null);
        }
      });
    return () => controller.abort();
  }, [cluster, debouncedPattern, indexName]);

  const handleExecuteQuery = useCallback(
    (text: string) => {
      try {
        const query = compileToEsQuery(text, fields);
        setActiveQuery(query);
        setQueryError(null);
        setPage(0);
      } catch (e) {
        if (e instanceof ParseError) {
          setQueryError(e.message);
        } else {
          setQueryError("Invalid query");
        }
        return;
      }
      setActiveTarget(indexPattern.trim() || indexName);
    },
    [fields, indexPattern, indexName],
  );

  const handleSort = useCallback(
    (field: string) => {
      // Check if this field is sortable
      const resolved = resolveSortField(field, fields);
      if (resolved === null) return;

      setSort((prev) => {
        if (prev && prev.field === field) {
          // Toggle direction, or clear on third click
          if (prev.dir === "asc") return { field, dir: "desc" as SortDir };
          return null; // clear sort
        }
        return { field, dir: "asc" };
      });
      setPage(0);
    },
    [fields],
  );

  const fetchDocuments = useCallback(
    async (signal: AbortSignal) => {
      setLoading(true);
      setError(null);

      try {
        const from = page * pageSize;
        const sortClause = buildEsSortClause(sort, fields);
        const body: Record<string, unknown> = {
          from,
          size: pageSize,
          query: activeQuery,
          version: true,
          seq_no_primary_term: true,
        };
        if (sortClause) {
          body.sort = sortClause;
        }
        const result = await esRequest<SearchResponse>(
          cluster,
          `/${encodeIndexPattern(activeTarget)}/_search`,
          {
            method: "POST",
            body: JSON.stringify(body),
            signal,
          },
        );

        if (signal.aborted) return;

        setHits(result.hits.hits);
        setTotal(result.hits.total.value);
      } catch (err) {
        if (signal.aborted) return;
        setError(
          err instanceof Error ? err.message : "Failed to fetch documents",
        );
        setHits([]);
        setTotal(0);
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    [cluster, activeTarget, page, pageSize, activeQuery, sort, fields, refreshKey],
  );

  useEffect(() => {
    const controller = new AbortController();
    fetchDocuments(controller.signal);
    return () => controller.abort();
  }, [fetchDocuments]);

  const visibleColumns = useMemo(
    () => columns.filter((c) => !hiddenColumns.has(c)),
    [columns, hiddenColumns],
  );

  const toggleColumn = useCallback((col: string) => {
    setHiddenColumns((prev) => {
      const next = new Set(prev);
      if (next.has(col)) {
        next.delete(col);
      } else {
        next.add(col);
      }
      return next;
    });
  }, []);

  const selectAllColumns = useCallback(() => {
    setHiddenColumns(new Set());
  }, []);

  const deselectAllColumns = useCallback(() => {
    setHiddenColumns(new Set(columns));
  }, [columns]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const rangeStart = total === 0 ? 0 : safePage * pageSize + 1;
  const rangeEnd = Math.min((safePage + 1) * pageSize, total);
  const colCount = visibleColumns.length + 2; // +1 for _id, +1 for checkbox

  // Selection helpers
  const allPageSelected = hits.length > 0 && hits.every((h) => selected.has(hitKey(h)));
  const somePageSelected = hits.some((h) => selected.has(hitKey(h)));

  const handleSelectAll = () => {
    if (allPageSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(hits.map((h) => hitKey(h))));
    }
  };

  const handleSelectRow = (hit: SearchHit) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const key = hitKey(hit);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  // Build a map from hitKey -> hit for quick lookup during delete
  const hitsByKey = useMemo(() => {
    const map = new Map<string, SearchHit>();
    for (const hit of hits) {
      map.set(hitKey(hit), hit);
    }
    return map;
  }, [hits]);

  const selectedHits = useMemo(
    () => Array.from(selected).map((k) => hitsByKey.get(k)).filter(Boolean) as SearchHit[],
    [selected, hitsByKey],
  );

  return (
    <div className="flex flex-col gap-4 p-6 h-full">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold font-mono">{indexName}</h2>
          {!loading && !error && (
            <p className="text-sm text-muted-foreground">
              {numFmt.format(total)} documents
            </p>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setExportDialogOpen(true)}>
            <DownloadIcon className="size-4" />
            Export
          </Button>
          {columns.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  <Columns3Icon className="size-4" />
                  Columns
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
                <DropdownMenuLabel>Toggle columns</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={(e) => e.preventDefault()} onClick={selectAllColumns}>Select all</DropdownMenuItem>
                <DropdownMenuItem onSelect={(e) => e.preventDefault()} onClick={deselectAllColumns}>Deselect all</DropdownMenuItem>
                <DropdownMenuSeparator />
                {columns.map((col) => (
                  <DropdownMenuCheckboxItem
                    key={col}
                    checked={!hiddenColumns.has(col)}
                    onCheckedChange={() => toggleColumn(col)}
                    onSelect={(e) => e.preventDefault()}
                  >
                    {col}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {/* Query + Index Pattern */}
      <div className="flex gap-3 mb-1">
        <div className="flex flex-col gap-1 w-3/5">
          <label className="text-xs text-muted-foreground">Query</label>
          <QueryEditor
            fields={fields}
            onExecute={handleExecuteQuery}
            onChange={(v) => { queryTextRef.current = v; }}
            vimMode={vimMode}
            cluster={cluster}
            indexName={indexName}
            autoFocus
          />
          <p className="text-xs text-destructive h-4">
            {queryError ?? "\u00A0"}
          </p>
        </div>
        <div className="flex flex-col gap-1 w-2/5">
          <label className="text-xs text-muted-foreground">Index pattern</label>
          <IndexPatternEditor
            targets={indexTargets}
            defaultValue={indexName}
            placeholder={`${indexName}, ${indexName}-*`}
            onExecute={() => handleExecuteQuery(queryTextRef.current)}
            onChange={setIndexPattern}
            vimMode={vimMode}
          />
          <div className="flex items-center justify-between h-4">
            <p className="text-xs text-muted-foreground">
              {patternMatchCount !== null
                ? patternMatchCount === 0
                  ? "No matching indices"
                  : `${patternMatchCount} matching ${patternMatchCount === 1 ? "index" : "indices"}`
                : "\u00A0"}
            </p>
            {onVimModeChange && (
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={vimMode ?? false}
                  onChange={(e) => onVimModeChange(e.target.checked)}
                  className="size-3.5 rounded border-input accent-primary"
                />
                <span className="text-xs text-muted-foreground">Vim mode</span>
              </label>
            )}
          </div>
        </div>
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
                  disabled={hits.length === 0}
                />
              </TableHead>
              <SortableDocHead
                field="_id"
                sort={sort}
                fields={fields}
                onSort={handleSort}
                className="min-w-[200px]"
              >
                _id
              </SortableDocHead>
              {visibleColumns.map((col) => (
                <SortableDocHead
                  key={col}
                  field={col}
                  sort={sort}
                  fields={fields}
                  onSort={handleSort}
                  className="min-w-[150px]"
                >
                  {col}
                </SortableDocHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <SkeletonRows cols={colCount > 1 ? colCount : 6} rows={pageSize} />
            ) : error ? (
              <TableRow>
                <TableCell
                  colSpan={colCount}
                  className="h-24 text-center text-destructive"
                >
                  {error}
                </TableCell>
              </TableRow>
            ) : hits.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={colCount}
                  className="h-24 text-center text-muted-foreground"
                >
                  No documents found
                </TableCell>
              </TableRow>
            ) : (
              hits.map((hit) => (
                <TableRow
                  key={hitKey(hit)}
                  className="cursor-pointer"
                  data-state={selected.has(hitKey(hit)) ? "selected" : undefined}
                  onClick={() => setSelectedHit(hit)}
                >
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selected.has(hitKey(hit))}
                      onChange={() => handleSelectRow(hit)}
                      className="size-4 rounded border-input accent-primary"
                    />
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {hit._id}
                  </TableCell>
                  {visibleColumns.map((col) => (
                    <TableCell
                      key={col}
                      className="text-sm max-w-[300px] truncate"
                    >
                      {renderCellValue(hit._source?.[col])}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      {total > 0 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground tabular-nums">
            {rangeStart}&ndash;{rangeEnd} of {numFmt.format(total)} documents
          </span>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground whitespace-nowrap">
                Rows
              </span>
              <Select
                value={String(pageSize)}
                onValueChange={(v) => {
                  setPageSize(Number(v));
                  setPage(0);
                }}
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
              <div className="flex items-center gap-1 px-1">
                <input
                  type="text"
                  inputMode="numeric"
                  className="w-10 text-center text-sm tabular-nums bg-transparent border rounded px-1 py-0.5 border-input focus:outline-none focus:border-ring"
                  value={safePage + 1}
                  onChange={(e) => {
                    const n = parseInt(e.target.value, 10);
                    if (!isNaN(n)) setPage(Math.max(0, Math.min(n - 1, totalPages - 1)));
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                  }}
                />
                <span className="text-muted-foreground tabular-nums">/ {totalPages}</span>
              </div>
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

      {/* Bulk actions bar */}
      {selected.size > 0 && (
        <div className="sticky bottom-0 flex items-center justify-between gap-4 rounded-lg border bg-popover px-4 py-3">
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium">
              {selected.size} {selected.size === 1 ? "document" : "documents"} selected
            </span>
            <Button variant="link" size="sm" onClick={() => setSelected(new Set())} className="h-auto p-0 text-xs">
              Clear selection
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="text-destructive border-destructive/50 hover:bg-destructive/10"
              onClick={() => setDeleteDialogOpen(true)}
            >
              <Trash2Icon className="size-4 mr-1" />
              Delete Documents
            </Button>
          </div>
        </div>
      )}

      {/* Bulk delete confirmation dialog */}
      <BulkDeleteDocumentsDialog
        open={deleteDialogOpen}
        hits={selectedHits}
        cluster={cluster}
        onClose={() => setDeleteDialogOpen(false)}
        onSuccess={() => {
          setDeleteDialogOpen(false);
          setSelected(new Set());
          setRefreshKey((k) => k + 1);
        }}
      />

      <ExportDocumentsDialog
        open={exportDialogOpen}
        cluster={cluster}
        indexPattern={activeTarget}
        query={activeQuery}
        sort={sort}
        fields={fields}
        onClose={() => setExportDialogOpen(false)}
      />

      <DocumentViewerSheet
        hit={selectedHit}
        onClose={() => setSelectedHit(null)}
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
// Bulk delete documents dialog
// ---------------------------------------------------------------------------

function BulkDeleteDocumentsDialog({
  open,
  hits,
  cluster,
  onClose,
  onSuccess,
}: {
  open: boolean;
  hits: SearchHit[];
  cluster: ClusterConfig;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [confirmation, setConfirmation] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const requiredText = "delete";
  const confirmed = confirmation === requiredText;

  // Reset confirmation when dialog opens/closes
  useEffect(() => {
    if (open) setConfirmation("");
  }, [open]);

  const handleDelete = async () => {
    if (!confirmed || hits.length === 0) return;
    setSubmitting(true);
    try {
      const body = buildBulkDeleteBody(hits);

      const result = await esRequest<{ errors: boolean; items: Array<{ delete: { _id: string; status: number; error?: unknown } }> }>(
        cluster,
        "/_bulk",
        {
          method: "POST",
          body,
        },
      );

      if (result.errors) {
        const failedCount = result.items.filter((item) => item.delete.status >= 400).length;
        toast.error(`${failedCount} of ${hits.length} documents failed to delete`);
      } else {
        toast.success(
          hits.length === 1
            ? "Deleted 1 document"
            : `Deleted ${hits.length} documents`,
        );
      }
      onSuccess();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to delete documents",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete Documents</DialogTitle>
          <DialogDescription>
            This will delete {hits.length}{" "}
            {hits.length === 1 ? "document" : "documents"}. This action cannot
            be undone.
          </DialogDescription>
        </DialogHeader>

        <div>
          <label className="text-sm font-medium">
            Type{" "}
            <span className="font-mono text-destructive">{requiredText}</span>{" "}
            to confirm
          </label>
          <Input
            className="mt-1"
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
            placeholder={requiredText}
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={!confirmed || submitting}
          >
            {submitting && <Loader2Icon className="size-4 mr-1 animate-spin" />}
            Delete Documents
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Export documents dialog
// ---------------------------------------------------------------------------

function ExportDocumentsDialog({
  open,
  cluster,
  indexPattern,
  query,
  sort,
  fields,
  onClose,
}: {
  open: boolean;
  cluster: ClusterConfig;
  indexPattern: string;
  query: object;
  sort: SortState | null;
  fields: MappingField[];
  onClose: () => void;
}) {
  const [format, setFormat] = useState<ExportFormat>("jsonl");
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState<ExportProgress>({ exported: 0, total: 0 });
  const abortRef = useRef<AbortController | null>(null);
  const exportedRef = useRef(0);

  const handleExport = async () => {
    setExporting(true);
    setProgress({ exported: 0, total: 0 });
    exportedRef.current = 0;
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const sortClause = buildEsSortClause(sort, fields);
      await exportDocuments({
        cluster,
        indexPattern,
        query,
        sort: sortClause,
        format,
        onProgress: (p) => { setProgress(p); exportedRef.current = p.exported; },
        signal: controller.signal,
      });
      toast.success(`Exported ${numFmt.format(exportedRef.current)} documents`);
      onClose();
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        // user cancelled — silently close
      } else {
        toast.error(err instanceof Error ? err.message : "Export failed");
      }
    } finally {
      setExporting(false);
      abortRef.current = null;
    }
  };

  const handleCancel = () => {
    if (exporting) {
      abortRef.current?.abort();
    } else {
      onClose();
    }
  };

  const pct = progress.total > 0 ? Math.round((progress.exported / progress.total) * 100) : 0;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !exporting) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Export Documents</DialogTitle>
          <DialogDescription>
            Export all documents matching the current query.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium">Format</label>
            <div className="flex gap-2">
              <Button
                variant={format === "jsonl" ? "default" : "outline"}
                size="sm"
                onClick={() => !exporting && setFormat("jsonl")}
                disabled={exporting}
              >
                JSONL
              </Button>
              <Button
                variant={format === "json-array" ? "default" : "outline"}
                size="sm"
                onClick={() => !exporting && setFormat("json-array")}
                disabled={exporting}
              >
                JSON Array
              </Button>
            </div>
          </div>

          {exporting && (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-muted-foreground">
                Exporting... {numFmt.format(progress.exported)} / {numFmt.format(progress.total)} documents
              </p>
              <div className="h-2 rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: pct + "%" }}
                />
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleCancel}>
            {exporting ? "Cancel" : "Close"}
          </Button>
          {!exporting && (
            <Button onClick={handleExport}>
              <DownloadIcon className="size-4 mr-1" />
              Export
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Sortable document table header
// ---------------------------------------------------------------------------

function SortableDocHead({
  children,
  field,
  sort,
  fields,
  onSort,
  className,
}: {
  children: React.ReactNode;
  field: string;
  sort: SortState | null;
  fields: MappingField[];
  onSort: (field: string) => void;
  className?: string;
}) {
  const sortable = resolveSortField(field, fields) !== null;
  const active = sort?.field === field;

  const icon = !sortable ? null : active ? (
    sort.dir === "asc" ? (
      <ArrowUpIcon className="size-3.5" />
    ) : (
      <ArrowDownIcon className="size-3.5" />
    )
  ) : (
    <ArrowUpDownIcon className="size-3.5 opacity-30" />
  );

  return (
    <TableHead
      className={cn(
        sortable && "cursor-pointer select-none hover:text-foreground",
        className,
      )}
      onClick={sortable ? () => onSort(field) : undefined}
    >
      <div className="flex items-center gap-1">
        {children}
        {icon}
      </div>
    </TableHead>
  );
}

// ---------------------------------------------------------------------------
// Skeleton loading rows
// ---------------------------------------------------------------------------

function SkeletonRows({ cols, rows = 8 }: { cols: number; rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, i) => (
        <TableRow key={i}>
          {Array.from({ length: cols }, (_, j) => (
            <TableCell key={j}>
              <Skeleton className="h-4 w-24" />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  );
}
