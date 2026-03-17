import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { EditorView, keymap, lineNumbers, placeholder as cmPlaceholder, ViewPlugin } from "@codemirror/view";
import { EditorState, Annotation, Transaction } from "@codemirror/state";
import { vim, getCM } from "@replit/codemirror-vim";
import { json, jsonParseLinter } from "@codemirror/lang-json";
import { linter, lintGutter } from "@codemirror/lint";
import { foldGutter, indentOnInput, bracketMatching, indentService, getIndentUnit } from "@codemirror/language";
import {
  autocompletion,
  acceptCompletion,
  startCompletion,
  closeBrackets,
  closeBracketsKeymap,
} from "@codemirror/autocomplete";
import type { CompletionContext, CompletionResult, Completion } from "@codemirror/autocomplete";
import { history, historyKeymap, defaultKeymap, indentWithTab } from "@codemirror/commands";
import {
  PlayIcon,
  CopyIcon,
  CheckIcon,
  ClockIcon,
  BookmarkIcon,
  SaveIcon,
  Trash2Icon,
  PencilIcon,
  ChevronUpIcon,
  ChevronDownIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cmTheme, cmViewerTheme } from "@/lib/codemirror-theme";
import {
  createViewerSearchExtensions,
  nextViewerSearchMatch,
  previousViewerSearchMatch,
  readViewerSearchState,
  setViewerSearchQuery,
  type ViewerSearchState,
} from "@/lib/codemirror-viewer-search";
import { esRequest } from "@/lib/es-client";
import { fetchIndexFields } from "@/lib/es-mapping";
import { esDslCompletions } from "@/lib/es-query-completions";
import { autoMethodForEndpoint, isTerminalEndpointAction } from "@/lib/es-endpoint-method";
import { useDebounce } from "@/hooks/use-debounce";
import {
  loadHistory,
  saveHistory,
  addHistoryEntry,
  loadSavedQueries,
  saveSavedQueries,
  addSavedQuery,
  deleteSavedQuery,
  renameSavedQuery,
} from "@/lib/rest-query-storage";
import type { RestHistoryEntry, SavedQuery } from "@/lib/rest-query-storage";
import type { MappingField } from "@/lib/es-mapping";
import type { ClusterConfig } from "@/types/cluster";
import type { PendingRestQuery } from "@/page/unlocked-shell";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HTTP_METHODS = ["GET", "POST", "PUT", "DELETE", "HEAD"] as const;
const DEFAULT_HTTP_METHOD = "GET";

const ES_OPERATIONS: Completion[] = [
  "_search",
  "_count",
  "_mapping",
  "_settings",
  "_doc",
  "_bulk",
  "_delete_by_query",
  "_update_by_query",
  "_analyze",
  "_refresh",
  "_flush",
  "_forcemerge",
  "_reindex",
  "_aliases",
  "_cat/indices",
  "_cat/aliases",
  "_cat/health",
  "_cat/nodes",
  "_cat/shards",
  "_cluster/health",
  "_cluster/stats",
  "_nodes/stats",
].map((op) => ({
  label: op,
  type: "keyword",
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract a mapping target from a REST endpoint path like "/my-alias/_search" -> "my-alias". */
function extractMappingTarget(path: string): string | null {
  // Strip query string and fragment
  const cleaned = path.split("?")[0].split("#")[0];
  const trimmed = cleaned.replace(/^\/+/, "");
  if (!trimmed) return null;

  const firstSegment = trimmed.split("/")[0];
  if (!firstSegment) return null;

  // Reject if every comma-separated target starts with "_" (system endpoint)
  const targets = firstSegment.split(",");
  const hasUserTarget = targets.some((t) => !t.trim().startsWith("_"));
  if (!hasUserTarget) return null;

  return firstSegment;
}

function buildEndpointCompletions(indexNames: string[]) {
  const indexOptions: Completion[] = indexNames.map((name) => ({
    label: name,
    type: "variable",
  }));

  return (context: CompletionContext): CompletionResult | null => {
    const doc = context.state.doc.toString();

    // Find the current segment: text after the last /
    const lastSlash = doc.lastIndexOf("/", context.pos - 1);
    const segmentStart = lastSlash + 1;
    const segment = doc.slice(segmentStart, context.pos);

    if (segment.length === 0 && !context.explicit) return null;

    // If we're at the first segment (no slash or only leading slash), suggest indices
    // If we're after an index name, suggest operations
    const beforeSlash = doc.slice(0, Math.max(0, lastSlash)).replace(/^\/+/, "");
    const isFirstSegment = !beforeSlash;

    const options = isFirstSegment
      ? [...indexOptions, ...ES_OPERATIONS]
      : ES_OPERATIONS;

    return {
      from: segmentStart,
      options,
      filter: true,
    };
  };
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const isToday =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (isToday) {
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Annotation to mark auto-format transactions so they don't re-trigger. */
const autoFormatAnnotation = Annotation.define<boolean>();
const EMPTY_VIEWER_SEARCH_STATE: ViewerSearchState = {
  activeMatch: 0,
  hasMatches: false,
  query: "",
  totalMatches: 0,
};

/**
 * Map cursor position from unformatted to formatted text by counting
 * non-whitespace characters before the cursor.
 */
function mapCursorToFormatted(oldText: string, newText: string, oldPos: number): number {
  let nonWsCount = 0;
  for (let i = 0; i < oldPos && i < oldText.length; i++) {
    if (!/\s/.test(oldText[i])) nonWsCount++;
  }
  let count = 0;
  for (let i = 0; i < newText.length; i++) {
    if (!/\s/.test(newText[i])) {
      count++;
      if (count === nonWsCount) return i + 1;
    }
  }
  return newText.length;
}

/**
 * Compute JSON indentation by counting unmatched brackets before the
 * given position, skipping brackets inside strings. Works reliably
 * even when the document contains invalid / in-progress JSON.
 */
function jsonBracketIndent(_context: { state: EditorState }, pos: number): number {
  const state = (_context as { state: EditorState }).state;
  const doc = state.doc;
  const line = doc.lineAt(pos);
  const textBefore = doc.sliceString(0, line.from);

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < textBefore.length; i++) {
    const ch = textBefore[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
  }

  const lineText = line.text.trimStart();
  if (lineText.startsWith('}') || lineText.startsWith(']')) {
    depth = Math.max(0, depth - 1);
  }

  const unit = getIndentUnit(state);
  return Math.max(0, depth) * unit;
}

// ---------------------------------------------------------------------------
// Raw ES fetch (returns status + body text instead of throwing)
// ---------------------------------------------------------------------------

interface RawEsResponse {
  status: number;
  statusText: string;
  body: string;
  elapsed: number;
}

async function rawEsRequest(
  cluster: ClusterConfig,
  method: string,
  path: string,
  body: string | undefined,
  signal?: AbortSignal,
): Promise<RawEsResponse> {
  const url = `${cluster.url}${path.startsWith("/") ? path : `/${path}`}`;
  const headers: Record<string, string> = {
    Accept: "application/json",
  };

  // Build auth headers inline (same logic as esRequest)
  const auth = cluster.auth;
  if (auth.type === "basic") {
    headers.Authorization = `Basic ${btoa(`${auth.username}:${auth.password}`)}`;
  } else if (auth.type === "apikey") {
    headers.Authorization = `ApiKey ${auth.apiKey}`;
  } else if (auth.type === "bearer") {
    headers.Authorization = `Bearer ${auth.token}`;
  }

  if (body) {
    headers["Content-Type"] = "application/json";
  }

  const t0 = performance.now();
  const res = await fetch(url, {
    method,
    headers,
    body: body || undefined,
    signal,
  });
  const elapsed = performance.now() - t0;
  const text = await res.text();

  return {
    status: res.status,
    statusText: res.statusText,
    body: text,
    elapsed,
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface VimStatus {
  mode: string;
  command: string;
}

interface RestPageProps {
  cluster: ClusterConfig;
  pendingQuery?: PendingRestQuery | null;
  consumePendingQuery?: () => PendingRestQuery | null;
  vimMode?: boolean;
  onVimModeChange?: (enabled: boolean) => void;
}

export function RestPage({ cluster, pendingQuery, consumePendingQuery, vimMode, onVimModeChange }: RestPageProps) {
  const [method, setMethod] = useState<string>(DEFAULT_HTTP_METHOD);
  const [endpoint, setEndpoint] = useState("");
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<RawEsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [indexNames, setIndexNames] = useState<string[]>([]);
  const [fields, setFields] = useState<MappingField[]>([]);
  const [copied, setCopied] = useState(false);

  // History & saved queries
  const [historyEntries, setHistoryEntries] = useState<RestHistoryEntry[]>([]);
  const [savedQueries, setSavedQueries] = useState<SavedQuery[]>([]);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [renameTarget, setRenameTarget] = useState<SavedQuery | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [responseSearchQuery, setResponseSearchQuery] = useState("");
  const [responseSearchState, setResponseSearchState] = useState<ViewerSearchState>(EMPTY_VIEWER_SEARCH_STATE);

  // Vim status (reported by whichever editor was last active)
  const [vimStatus, setVimStatus] = useState<VimStatus>({ mode: "NORMAL", command: "" });

  // Editor key — bump to force editor remount with new initial values
  const [editorKey, setEditorKey] = useState(0);

  const supportsBody = method === "POST" || method === "PUT";
  const bodyRef = useRef("");
  const endpointRef = useRef("");
  const endpointEditorViewRef = useRef<EditorView | null>(null);
  const bodyEditorViewRef = useRef<EditorView | null>(null);
  const responseViewRef = useRef<EditorView | null>(null);
  const debouncedEndpoint = useDebounce(endpoint, 400);

  // Load history + saved queries when cluster changes
  useEffect(() => {
    setHistoryEntries(loadHistory(cluster.id));
    setSavedQueries(loadSavedQueries(cluster.id));
  }, [cluster.id]);

  // Fetch index names + aliases for endpoint autocomplete
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      esRequest<Array<{ index: string }>>(
        cluster,
        "/_cat/indices?format=json&h=index&s=index&expand_wildcards=all",
        { signal: controller.signal },
      ).catch(() => [] as Array<{ index: string }>),
      esRequest<Array<{ alias: string }>>(
        cluster,
        "/_cat/aliases?format=json&h=alias",
        { signal: controller.signal },
      ).catch(() => [] as Array<{ alias: string }>),
    ]).then(([indices, aliases]) => {
      const names = new Set(indices.map((r) => r.index));
      for (const a of aliases) names.add(a.alias);
      setIndexNames(Array.from(names).sort());
    });
    return () => controller.abort();
  }, [cluster]);

  // Fetch mapping fields when the endpoint targets a specific index/alias/pattern
  useEffect(() => {
    const target = extractMappingTarget(debouncedEndpoint);
    if (!target) {
      setFields([]);
      return;
    }

    const controller = new AbortController();
    fetchIndexFields(cluster, target, controller.signal)
      .then(setFields)
      .catch(() => setFields([]));
    return () => controller.abort();
  }, [cluster, debouncedEndpoint]);

  const handleSend = useCallback(async () => {
    const path = endpointRef.current.trim();
    if (!path) return;

    setLoading(true);
    setError(null);

    const sentMethod = method;
    const sentBody =
      sentMethod === "POST" || sentMethod === "PUT"
        ? bodyRef.current.trim() || ""
        : "";

    try {
      const result = await rawEsRequest(
        cluster,
        sentMethod,
        path,
        sentBody || undefined,
      );

      // Try to pretty-print JSON response
      try {
        const parsed = JSON.parse(result.body);
        result.body = JSON.stringify(parsed, null, 2);
      } catch {
        // Not JSON — keep raw text
      }

      setResponse(result);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "Request failed");
      setResponse(null);
    } finally {
      setLoading(false);
    }

    // Record in history
    const updated = addHistoryEntry(historyEntries, {
      method: sentMethod,
      endpoint: path,
      body: sentBody,
    });
    setHistoryEntries(updated);
    saveHistory(cluster.id, updated);
  }, [cluster, method, historyEntries]);

  const focusBodyEditor = useCallback(() => {
    if (!supportsBody) return false;
    const bodyView = bodyEditorViewRef.current;
    if (!bodyView) return false;
    bodyView.focus();
    return true;
  }, [supportsBody]);

  const handleEndpointViewReady = useCallback((view: EditorView | null) => {
    endpointEditorViewRef.current = view;
  }, []);

  const handleBodyViewReady = useCallback((view: EditorView | null) => {
    bodyEditorViewRef.current = view;
  }, []);

  const handleCopy = async () => {
    if (!response) return;
    await navigator.clipboard.writeText(response.body);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleResponseViewReady = useCallback((view: EditorView | null) => {
    responseViewRef.current = view;
    if (!view) {
      setResponseSearchState(EMPTY_VIEWER_SEARCH_STATE);
      return;
    }
    setResponseSearchState(setViewerSearchQuery(view, responseSearchQuery));
  }, [responseSearchQuery]);

  const handleResponseSearchChange = useCallback((query: string) => {
    setResponseSearchQuery(query);
    const view = responseViewRef.current;
    if (!view) {
      setResponseSearchState({
        ...EMPTY_VIEWER_SEARCH_STATE,
        query,
      });
      return;
    }
    setResponseSearchState(setViewerSearchQuery(view, query, { scrollToFirst: Boolean(query) }));
  }, []);

  const handleResponseSearchNext = useCallback(() => {
    const view = responseViewRef.current;
    if (!view) return;
    setResponseSearchState(nextViewerSearchMatch(view));
  }, []);

  const handleResponseSearchPrevious = useCallback(() => {
    const view = responseViewRef.current;
    if (!view) return;
    setResponseSearchState(previousViewerSearchMatch(view));
  }, []);

  // Load a request into the editors
  const applyRequest = useCallback(
    (req: { method: string; endpoint: string; body: string }) => {
      setMethod(req.method);

      // Update endpoint editor in-place if possible
      const epView = endpointEditorViewRef.current;
      if (epView) {
        epView.dispatch({
          changes: { from: 0, to: epView.state.doc.length, insert: req.endpoint },
        });
        endpointRef.current = req.endpoint;
        setEndpoint(req.endpoint);
      } else {
        endpointRef.current = req.endpoint;
        setEndpoint(req.endpoint);
      }

      // Update body editor in-place if possible
      const newSupportsBody = req.method === "POST" || req.method === "PUT";
      const bView = bodyEditorViewRef.current;
      if (bView && newSupportsBody) {
        const insertBody = req.body || "{\n  \n}";
        bView.dispatch({
          changes: { from: 0, to: bView.state.doc.length, insert: insertBody },
        });
        bodyRef.current = insertBody;
      } else if (!epView || (newSupportsBody && !bView)) {
        // Fallback: remount editors
        bodyRef.current = req.body || "{\n  \n}";
        setEditorKey((k) => k + 1);
      } else {
        bodyRef.current = req.body || "{\n  \n}";
      }
    },
    [],
  );

  // Consume pending query from Scout selection (one-time)
  useEffect(() => {
    if (pendingQuery && consumePendingQuery) {
      const q = consumePendingQuery();
      if (q) {
        applyRequest(q);
      }
    }
  }, [pendingQuery, consumePendingQuery, applyRequest]);

  // Save current request as a named query
  const handleSaveQuery = useCallback(() => {
    const name = saveName.trim();
    if (!name) return;
    const updated = addSavedQuery(savedQueries, {
      name,
      method,
      endpoint: endpointRef.current.trim(),
      body: bodyRef.current.trim(),
    });
    setSavedQueries(updated);
    saveSavedQueries(cluster.id, updated);
    setSaveDialogOpen(false);
    setSaveName("");
  }, [cluster.id, method, savedQueries, saveName]);

  const handleDeleteSaved = useCallback(
    (id: string) => {
      const updated = deleteSavedQuery(savedQueries, id);
      setSavedQueries(updated);
      saveSavedQueries(cluster.id, updated);
    },
    [cluster.id, savedQueries],
  );

  const handleRename = useCallback(() => {
    if (!renameTarget || !renameValue.trim()) return;
    const updated = renameSavedQuery(savedQueries, renameTarget.id, renameValue.trim());
    setSavedQueries(updated);
    saveSavedQueries(cluster.id, updated);
    setRenameTarget(null);
    setRenameValue("");
  }, [cluster.id, savedQueries, renameTarget, renameValue]);

  const responseText = useMemo(() => {
    if (loading) return "Loading...";
    if (error) return error;
    if (response) return response.body;
    return "";
  }, [loading, error, response]);

  return (
    <div className="flex h-full min-h-0 flex-1 gap-0 overflow-hidden">
      {/* Left panel — Request */}
      <div
        data-testid="rest-request-panel"
        className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-hidden border-r p-6"
      >
        {/* Method + Endpoint + Actions */}
        <div className="flex gap-2 items-center">
          <Select value={method} onValueChange={(nextMethod) => setMethod(nextMethod)}>
            <SelectTrigger className="w-[110px] font-mono">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {HTTP_METHODS.map((m) => (
                <SelectItem key={m} value={m} className="font-mono">
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex-1">
            <EndpointEditor
              key={`ep-${editorKey}-${vimMode}`}
              indexNames={indexNames}
              initialValue={endpointRef.current}
              autoFocus
              onViewReady={handleEndpointViewReady}
              onChange={(v) => {
                const previousEndpoint = endpointRef.current;
                const previousAutoMethod = autoMethodForEndpoint(previousEndpoint);
                const wasAutoMethod = method === previousAutoMethod;

                endpointRef.current = v;
                setEndpoint(v);

                if (wasAutoMethod) {
                  const nextAutoMethod = autoMethodForEndpoint(v);
                  if (nextAutoMethod !== method) {
                    setMethod(nextAutoMethod);
                  }
                }
              }}
              onExecute={handleSend}
              onFocusBodyEditor={focusBodyEditor}
              vimMode={vimMode}
              onVimStatus={setVimStatus}
            />
          </div>
          <Button onClick={handleSend} disabled={loading} size="sm">
            <PlayIcon className="size-4" />
            Send
          </Button>
          {/* History dropdown */}
          <HistoryDropdown
            entries={historyEntries}
            onSelect={applyRequest}
          />
          {/* Saved queries dropdown */}
          <SavedQueriesDropdown
            queries={savedQueries}
            onSelect={applyRequest}
            onDelete={handleDeleteSaved}
            onRename={(q) => {
              setRenameTarget(q);
              setRenameValue(q.name);
            }}
          />
          {/* Save button */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setSaveName("");
              setSaveDialogOpen(true);
            }}
            title="Save query"
          >
            <SaveIcon className="size-4" />
          </Button>
        </div>

        {onVimModeChange && (
          <div className="flex justify-end">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={vimMode ?? false}
                onChange={(e) => onVimModeChange(e.target.checked)}
                className="size-3.5 rounded border-input accent-primary"
              />
              <span className="text-xs text-muted-foreground">Vim mode</span>
            </label>
          </div>
        )}

        {/* Body editor */}
        <div className="flex-1 overflow-hidden rounded-md border min-h-0 relative">
          {supportsBody ? (
            <BodyEditor
              key={`body-${editorKey}-${vimMode}`}
              fields={fields}
              endpoint={debouncedEndpoint}
              cluster={cluster}
              initialValue={bodyRef.current || "{\n  \n}"}
              onSend={handleSend}
              onChange={(v) => { bodyRef.current = v; }}
              onViewReady={handleBodyViewReady}
              vimMode={vimMode}
              onVimStatus={setVimStatus}
            />
          ) : (
            <div className="h-full flex items-center justify-center bg-[#282a36]">
              <p className="text-sm text-muted-foreground">
                Body is not supported for {method} requests
              </p>
            </div>
          )}
        </div>

        {/* Vim status bar */}
        {vimMode && <VimStatusBar status={vimStatus} />}
      </div>

      {/* Right panel — Response */}
      <div
        data-testid="rest-response-panel"
        className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-hidden p-6"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 text-sm">
            <span className="text-muted-foreground">Response</span>
            {response && (
              <>
                <StatusBadge status={response.status} text={response.statusText} />
                <span className="text-muted-foreground tabular-nums">
                  {Math.round(response.elapsed)}ms
                </span>
              </>
            )}
          </div>
          {response && (
            <Button variant="ghost" size="sm" onClick={handleCopy}>
              {copied ? (
                <CheckIcon className="size-4 text-green-500" />
              ) : (
                <CopyIcon className="size-4" />
              )}
              {copied ? "Copied" : "Copy"}
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap" data-testid="rest-response-search-toolbar">
          <Input
            data-testid="rest-response-search-input"
            className="h-8 min-w-0 flex-1"
            placeholder="Search response text"
            value={responseSearchQuery}
            onChange={(e) => handleResponseSearchChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              if (!responseSearchQuery || !responseSearchState.hasMatches) return;
              e.preventDefault();
              handleResponseSearchNext();
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="rest-response-search-prev"
            onClick={handleResponseSearchPrevious}
            disabled={!responseSearchQuery || !responseSearchState.hasMatches}
          >
            <ChevronUpIcon className="size-4" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="rest-response-search-next"
            onClick={handleResponseSearchNext}
            disabled={!responseSearchQuery || !responseSearchState.hasMatches}
          >
            <ChevronDownIcon className="size-4" />
          </Button>
          <span
            data-testid="rest-response-search-count"
            className="text-xs text-muted-foreground tabular-nums min-w-16 text-right"
          >
            {responseSearchQuery
              ? `${responseSearchState.activeMatch}/${responseSearchState.totalMatches}`
              : "0/0"}
          </span>
        </div>
        <div className="flex min-h-0 flex-1 overflow-hidden rounded-md border">
          <ResponseViewer
            value={responseText}
            onViewReady={handleResponseViewReady}
            onSearchStateChange={setResponseSearchState}
          />
        </div>
      </div>

      {/* Save query dialog */}
      <Dialog open={saveDialogOpen} onOpenChange={setSaveDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save Query</DialogTitle>
            <DialogDescription>
              Give this query a name so you can reuse it later.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSaveQuery();
            }}
          >
            <Input
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              placeholder="Query name"
              autoFocus
            />
            <DialogFooter className="mt-4">
              <Button type="submit" disabled={!saveName.trim()}>
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Rename saved query dialog */}
      <Dialog open={renameTarget !== null} onOpenChange={(open) => { if (!open) setRenameTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename Query</DialogTitle>
            <DialogDescription>
              Enter a new name for this saved query.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleRename();
            }}
          >
            <Input
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              placeholder="Query name"
              autoFocus
            />
            <DialogFooter className="mt-4">
              <Button type="submit" disabled={!renameValue.trim()}>
                Rename
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// History dropdown
// ---------------------------------------------------------------------------

function HistoryDropdown({
  entries,
  onSelect,
}: {
  entries: RestHistoryEntry[];
  onSelect: (req: { method: string; endpoint: string; body: string }) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" title="History">
          <ClockIcon className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel>Recent Requests</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {entries.length === 0 ? (
          <div className="px-2 py-4 text-center text-sm text-muted-foreground">
            No history yet
          </div>
        ) : (
          <ScrollArea className="max-h-72">
            <DropdownMenuGroup>
              {entries.map((entry) => (
                <DropdownMenuItem
                  key={entry.id}
                  onSelect={() => onSelect(entry)}
                  className="flex items-center gap-2"
                >
                  <span className="font-mono text-xs font-semibold w-12 shrink-0">
                    {entry.method}
                  </span>
                  <span className="font-mono text-xs truncate flex-1">
                    {entry.endpoint}
                  </span>
                  <span className="text-xs text-muted-foreground shrink-0">
                    {formatTimestamp(entry.timestamp)}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </ScrollArea>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---------------------------------------------------------------------------
// Saved queries dropdown
// ---------------------------------------------------------------------------

function SavedQueriesDropdown({
  queries,
  onSelect,
  onDelete,
  onRename,
}: {
  queries: SavedQuery[];
  onSelect: (req: { method: string; endpoint: string; body: string }) => void;
  onDelete: (id: string) => void;
  onRename: (q: SavedQuery) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" title="Saved queries">
          <BookmarkIcon className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel>Saved Queries</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {queries.length === 0 ? (
          <div className="px-2 py-4 text-center text-sm text-muted-foreground">
            No saved queries
          </div>
        ) : (
          <ScrollArea className="max-h-72">
            <DropdownMenuGroup>
              {queries.map((q) => (
                <DropdownMenuItem
                  key={q.id}
                  onSelect={() => onSelect(q)}
                  className="flex items-center gap-2"
                >
                  <span className="font-mono text-xs font-semibold w-12 shrink-0">
                    {q.method}
                  </span>
                  <span className="text-sm truncate flex-1">{q.name}</span>
                  <span className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      className="p-0.5 rounded hover:bg-accent"
                      onClick={(e) => {
                        e.stopPropagation();
                        onRename(q);
                      }}
                      title="Rename"
                    >
                      <PencilIcon className="size-3.5 text-muted-foreground" />
                    </button>
                    <button
                      type="button"
                      className="p-0.5 rounded hover:bg-destructive/10"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(q.id);
                      }}
                      title="Delete"
                    >
                      <Trash2Icon className="size-3.5 text-destructive" />
                    </button>
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </ScrollArea>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

function StatusBadge({ status, text }: { status: number; text: string }) {
  const color =
    status < 300
      ? "text-green-500"
      : status < 400
        ? "text-yellow-500"
        : "text-red-500";

  return (
    <span className={`font-mono font-semibold tabular-nums ${color}`}>
      {status} {text}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Vim status helpers
// ---------------------------------------------------------------------------

function readVimStatus(view: EditorView): VimStatus {
  const cm = getCM(view);
  if (!cm) return { mode: "NORMAL", command: "" };
  const vs = cm.state.vim;
  if (!vs) return { mode: "NORMAL", command: "" };

  let mode = "NORMAL";
  if (vs.insertMode) mode = "INSERT";
  else if (vs.visualMode) {
    if (vs.visualLine) mode = "V-LINE";
    else if (vs.visualBlock) mode = "V-BLOCK";
    else mode = "VISUAL";
  }

  const command = vs.inputState?.keyBuffer?.join("") ?? "";

  return { mode, command };
}

function vimStatusPlugin(
  onStatusRef: React.RefObject<((s: VimStatus) => void) | undefined>,
) {
  return ViewPlugin.define(() => ({}), {
    eventHandlers: {
      focus(_, view) {
        onStatusRef.current?.(readVimStatus(view));
      },
    },
    provide: () =>
      EditorView.updateListener.of((update) => {
        if (update.view.hasFocus) {
          onStatusRef.current?.(readVimStatus(update.view));
        }
      }),
  });
}

// ---------------------------------------------------------------------------
// Vim status bar component
// ---------------------------------------------------------------------------

function VimStatusBar({ status }: { status: VimStatus }) {
  const modeColors: Record<string, string> = {
    NORMAL: "bg-[#bd93f9] text-[#282a36]",
    INSERT: "bg-[#50fa7b] text-[#282a36]",
    VISUAL: "bg-[#ff79c6] text-[#282a36]",
    "V-LINE": "bg-[#ff79c6] text-[#282a36]",
    "V-BLOCK": "bg-[#ff79c6] text-[#282a36]",
  };

  return (
    <div className="flex items-center gap-2 h-7 px-2 bg-[#282a36] rounded-md border text-xs font-mono select-none">
      <span
        className={`px-2 py-0.5 rounded font-bold text-[11px] ${modeColors[status.mode] ?? "bg-muted text-foreground"}`}
      >
        {status.mode}
      </span>
      {status.command && (
        <span className="text-[#f8f8f2] tracking-wider">{status.command}</span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Endpoint editor (single-line with autocomplete)
// ---------------------------------------------------------------------------

function EndpointEditor({
  indexNames,
  initialValue,
  onChange,
  onExecute,
  onFocusBodyEditor,
  onViewReady,
  vimMode,
  onVimStatus,
  autoFocus,
}: {
  indexNames: string[];
  initialValue?: string;
  onChange: (value: string) => void;
  onExecute: () => void;
  onFocusBodyEditor?: () => boolean;
  onViewReady?: (view: EditorView | null) => void;
  vimMode?: boolean;
  onVimStatus?: (status: VimStatus) => void;
  autoFocus?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onExecuteRef = useRef(onExecute);
  onExecuteRef.current = onExecute;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onFocusBodyEditorRef = useRef(onFocusBodyEditor);
  onFocusBodyEditorRef.current = onFocusBodyEditor;
  const onVimStatusRef = useRef(onVimStatus);
  onVimStatusRef.current = onVimStatus;
  const docRef = useRef(initialValue ?? "");

  useEffect(() => {
    if (!containerRef.current) return;

    const extensions = [
      ...(vimMode ? [vim()] : []),
      history(),
      keymap.of(historyKeymap),
      cmTheme,
      autocompletion({
        override: [buildEndpointCompletions(indexNames)],
        activateOnTyping: true,
      }),
      keymap.of([
        {
          key: "Tab",
          run: (view) => {
            if (acceptCompletion(view)) return true;

            const endpoint = view.state.doc.toString();
            if (isTerminalEndpointAction(endpoint) && onFocusBodyEditorRef.current?.()) {
              return true;
            }

            startCompletion(view);
            return true;
          },
        },
        ...(vimMode ? [] : [{
          key: "Enter" as const,
          run: () => {
            onExecuteRef.current();
            return true;
          },
        }]),
      ]),
      ...(vimMode ? [keymap.of([{
        key: "Ctrl-Enter",
        run: () => { onExecuteRef.current(); return true; },
      }, {
        key: "Mod-Enter",
        run: () => { onExecuteRef.current(); return true; },
      }])] : []),
      cmPlaceholder("/my-index/_search"),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          const text = update.state.doc.toString();
          docRef.current = text;
          onChangeRef.current(text);
        }
      }),
      ...(vimMode ? [vimStatusPlugin(onVimStatusRef)] : []),
      EditorView.lineWrapping,
      EditorState.transactionFilter.of((tr) => {
        if (tr.newDoc.lines > 1) return [];
        return tr;
      }),
    ];

    const state = EditorState.create({
      doc: docRef.current,
      extensions,
    });

    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;
    onViewReady?.(view);
    if (autoFocus) { view.focus(); }

    return () => {
      view.destroy();
      viewRef.current = null;
      onViewReady?.(null);
    };
  }, [indexNames, vimMode]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      ref={containerRef}
      className="rounded-md border overflow-hidden [&_.cm-editor]:outline-none [&_.cm-panels]:hidden"
    />
  );
}

// ---------------------------------------------------------------------------
// Body editor (multi-line JSON with field autocomplete)
// ---------------------------------------------------------------------------

function BodyEditor({
  fields,
  endpoint,
  cluster,
  initialValue,
  onSend,
  onChange,
  onViewReady,
  vimMode,
  onVimStatus,
}: {
  fields: MappingField[];
  endpoint: string;
  cluster: ClusterConfig;
  initialValue?: string;
  onSend: () => void;
  onChange: (value: string) => void;
  onViewReady?: (view: EditorView | null) => void;
  vimMode?: boolean;
  onVimStatus?: (status: VimStatus) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onSendRef = useRef(onSend);
  onSendRef.current = onSend;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onVimStatusRef = useRef(onVimStatus);
  onVimStatusRef.current = onVimStatus;
  const docRef = useRef(initialValue ?? "{\n  \n}");

  useEffect(() => {
    if (!containerRef.current) return;

    let formatTimer: ReturnType<typeof setTimeout> | null = null;

    const state = EditorState.create({
      doc: docRef.current,
      extensions: [
        ...(vimMode ? [vim()] : []),
        history(),
        keymap.of(historyKeymap),
        json(),
        indentService.of(jsonBracketIndent),
        linter(jsonParseLinter()),
        lintGutter(),
        cmViewerTheme,
        lineNumbers(),
        foldGutter(),
        autocompletion({
          override: [esDslCompletions(fields, endpoint, cluster)],
          activateOnTyping: true,
          selectOnOpen: false,
        }),
        keymap.of([
          {
            key: "Tab",
            run: (view) => {
              if (acceptCompletion(view)) return true;
              startCompletion(view);
              return true;
            },
          },
          {
            key: "Ctrl-Enter",
            run: () => {
              onSendRef.current();
              return true;
            },
          },
          {
            key: "Mod-Enter",
            run: () => {
              onSendRef.current();
              return true;
            },
          },
          {
            key: "Shift-Alt-f",
            run: (view) => {
              try {
                const text = view.state.doc.toString();
                const formatted = JSON.stringify(JSON.parse(text), null, 2);
                if (formatted !== text) {
                  view.dispatch({
                    changes: { from: 0, to: text.length, insert: formatted },
                  });
                }
              } catch {
                // JSON is invalid, skip formatting
              }
              return true;
            },
          },
        ]),
        bracketMatching(),
        closeBrackets(),
        indentOnInput(),
        keymap.of([...closeBracketsKeymap, ...defaultKeymap, indentWithTab]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const text = update.state.doc.toString();
            docRef.current = text;
            onChangeRef.current(text);
          }
        }),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          // Don't re-trigger on our own format transactions
          if (update.transactions.some(tr => tr.annotation(autoFormatAnnotation))) return;

          if (formatTimer) clearTimeout(formatTimer);
          formatTimer = setTimeout(() => {
            const view = update.view;
            const text = view.state.doc.toString();

            // Don't format if cursor is on a blank line — user likely just
            // pressed Enter inside braces and is about to type.
            const cursor = view.state.selection.main.head;
            const cursorLine = view.state.doc.lineAt(cursor);
            if (cursorLine.text.trim() === '') return;

            try {
              const parsed = JSON.parse(text);
              const formatted = JSON.stringify(parsed, null, 2);
              if (formatted === text) return;

              const newCursor = mapCursorToFormatted(text, formatted, cursor);

              view.dispatch({
                changes: { from: 0, to: text.length, insert: formatted },
                selection: { anchor: Math.min(newCursor, formatted.length) },
                annotations: [autoFormatAnnotation.of(true), Transaction.addToHistory.of(false)],
              });
            } catch {
              // Invalid JSON, don't format
            }
          }, 400);
        }),
        ...(vimMode ? [vimStatusPlugin(onVimStatusRef)] : []),
        EditorView.lineWrapping,
      ],
    });

    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;
    // Expose view on DOM for scripting/testing
    (containerRef.current as unknown as Record<string, unknown>).__cmView = view;
    onViewReady?.(view);

    return () => {
      if (formatTimer) clearTimeout(formatTimer);
      view.destroy();
      viewRef.current = null;
      onViewReady?.(null);
    };
  }, [fields, endpoint, cluster, onViewReady, vimMode]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      ref={containerRef}
      className="h-full [&_.cm-editor]:h-full [&_.cm-editor]:outline-none [&_.cm-panels]:hidden"
    />
  );
}

// ---------------------------------------------------------------------------
// Response viewer (read-only)
// ---------------------------------------------------------------------------

function ResponseViewer({
  value,
  onViewReady,
  onSearchStateChange,
}: {
  value: string;
  onViewReady?: (view: EditorView | null) => void;
  onSearchStateChange?: (searchState: ViewerSearchState) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const state = EditorState.create({
      doc: value,
      extensions: [
        EditorState.readOnly.of(true),
        json(),
        cmViewerTheme,
        lineNumbers(),
        foldGutter(),
        ...createViewerSearchExtensions((view) => {
          onSearchStateChange?.(readViewerSearchState(view));
        }),
        EditorView.lineWrapping,
      ],
    });

    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;
    onViewReady?.(view);
    onSearchStateChange?.(readViewerSearchState(view));

    return () => {
      view.destroy();
      viewRef.current = null;
      onViewReady?.(null);
    };
  }, [value, onViewReady, onSearchStateChange]);

  return (
    <div
      ref={containerRef}
      data-testid="rest-response-viewer"
      className="h-full min-h-0 w-full overflow-hidden [&_.cm-editor]:h-full [&_.cm-editor]:min-h-0 [&_.cm-editor]:outline-none [&_.cm-scroller]:h-full [&_.cm-scroller]:overflow-auto"
    />
  );
}
