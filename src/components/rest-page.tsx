import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { EditorView, keymap, lineNumbers, placeholder as cmPlaceholder } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { json, jsonParseLinter } from "@codemirror/lang-json";
import { linter, lintGutter } from "@codemirror/lint";
import { foldGutter } from "@codemirror/language";
import {
  autocompletion,
  acceptCompletion,
  startCompletion,
} from "@codemirror/autocomplete";
import type { CompletionContext, CompletionResult, Completion } from "@codemirror/autocomplete";
import { history, historyKeymap } from "@codemirror/commands";
import {
  PlayIcon,
  CopyIcon,
  CheckIcon,
  ClockIcon,
  BookmarkIcon,
  SaveIcon,
  Trash2Icon,
  PencilIcon,
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
import { esRequest } from "@/lib/es-client";
import { fetchIndexFields } from "@/lib/es-mapping";
import { esDslCompletions } from "@/lib/es-query-completions";
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

/** Extract index name from a path like "/my-index/_search" → "my-index" */
function extractIndexFromPath(path: string): string | null {
  const trimmed = path.replace(/^\/+/, "");
  if (!trimmed) return null;
  const first = trimmed.split("/")[0];
  if (!first || first.startsWith("_")) return null;
  return decodeURIComponent(first);
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

interface RestPageProps {
  cluster: ClusterConfig;
  pendingQuery?: PendingRestQuery | null;
  consumePendingQuery?: () => PendingRestQuery | null;
}

export function RestPage({ cluster, pendingQuery, consumePendingQuery }: RestPageProps) {
  const [method, setMethod] = useState<string>("GET");
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

  // Editor key — bump to force editor remount with new initial values
  const [editorKey, setEditorKey] = useState(0);
  const initialBodyRef = useRef("{\n  \n}");

  const supportsBody = method === "POST" || method === "PUT";
  const bodyRef = useRef("");
  const endpointRef = useRef("");
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

  // Fetch mapping fields when the endpoint targets a specific index
  useEffect(() => {
    const indexName = extractIndexFromPath(debouncedEndpoint);
    if (!indexName) {
      setFields([]);
      return;
    }

    const controller = new AbortController();
    fetchIndexFields(cluster, indexName, controller.signal)
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

  const handleCopy = async () => {
    if (!response) return;
    await navigator.clipboard.writeText(response.body);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // Load a request into the editors
  const applyRequest = useCallback(
    (req: { method: string; endpoint: string; body: string }) => {
      setMethod(req.method);
      setEndpoint(req.endpoint);
      endpointRef.current = req.endpoint;
      bodyRef.current = req.body;
      initialBodyRef.current = req.body || "{\n  \n}";
      setEditorKey((k) => k + 1);
    },
    [],
  );

  // Consume pending query from spotlight selection (one-time)
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
    <div className="flex flex-1 gap-0 h-full">
      {/* Left panel — Request */}
      <div className="flex-1 flex flex-col p-6 gap-3 border-r min-w-0">
        {/* Method + Endpoint + Actions */}
        <div className="flex gap-2 items-center">
          <Select value={method} onValueChange={setMethod}>
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
              key={editorKey}
              indexNames={indexNames}
              initialValue={endpointRef.current}
              onChange={(v) => {
                endpointRef.current = v;
                setEndpoint(v);
              }}
              onExecute={handleSend}
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

        {/* Body editor */}
        <div className="flex-1 overflow-hidden rounded-md border min-h-0 relative">
          {supportsBody ? (
            <BodyEditor
              key={`body-${editorKey}`}
              fields={fields}
              endpoint={debouncedEndpoint}
              initialValue={initialBodyRef.current}
              onSend={handleSend}
              onChange={(v) => { bodyRef.current = v; }}
            />
          ) : (
            <div className="h-full flex items-center justify-center bg-[#282a36]">
              <p className="text-sm text-muted-foreground">
                Body is not supported for {method} requests
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Right panel — Response */}
      <div className="flex-1 flex flex-col p-6 gap-3 min-w-0">
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
        <div className="flex-1 overflow-hidden rounded-md border min-h-0">
          <ResponseViewer value={responseText} />
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
// Endpoint editor (single-line with autocomplete)
// ---------------------------------------------------------------------------

function EndpointEditor({
  indexNames,
  initialValue,
  onChange,
  onExecute,
}: {
  indexNames: string[];
  initialValue?: string;
  onChange: (value: string) => void;
  onExecute: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onExecuteRef = useRef(onExecute);
  onExecuteRef.current = onExecute;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!containerRef.current) return;

    const existingDoc = viewRef.current?.state.doc.toString();

    const state = EditorState.create({
      doc: existingDoc ?? initialValue ?? "",
      extensions: [
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
              startCompletion(view);
              return true;
            },
          },
          {
            key: "Enter",
            run: () => {
              onExecuteRef.current();
              return true;
            },
          },
        ]),
        cmPlaceholder("/my-index/_search"),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());
          }
        }),
        EditorView.lineWrapping,
        EditorState.transactionFilter.of((tr) => {
          if (tr.newDoc.lines > 1) return [];
          return tr;
        }),
      ],
    });

    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [indexNames]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      ref={containerRef}
      className="rounded-md border overflow-hidden [&_.cm-editor]:outline-none"
    />
  );
}

// ---------------------------------------------------------------------------
// Body editor (multi-line JSON with field autocomplete)
// ---------------------------------------------------------------------------

function BodyEditor({
  fields,
  endpoint,
  initialValue,
  onSend,
  onChange,
}: {
  fields: MappingField[];
  endpoint: string;
  initialValue?: string;
  onSend: () => void;
  onChange: (value: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onSendRef = useRef(onSend);
  onSendRef.current = onSend;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!containerRef.current) return;

    const existingDoc = viewRef.current?.state.doc.toString();

    const state = EditorState.create({
      doc: existingDoc ?? initialValue ?? "{\n  \n}",
      extensions: [
        history(),
        keymap.of(historyKeymap),
        json(),
        linter(jsonParseLinter()),
        lintGutter(),
        cmViewerTheme,
        lineNumbers(),
        foldGutter(),
        autocompletion({
          override: [esDslCompletions(fields, endpoint)],
          activateOnTyping: true,
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
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());
          }
        }),
        EditorView.lineWrapping,
      ],
    });

    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [fields, endpoint]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      ref={containerRef}
      className="h-full [&_.cm-editor]:h-full [&_.cm-editor]:outline-none"
    />
  );
}

// ---------------------------------------------------------------------------
// Response viewer (read-only)
// ---------------------------------------------------------------------------

function ResponseViewer({ value }: { value: string }) {
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
        EditorView.lineWrapping,
      ],
    });

    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [value]);

  return (
    <div
      ref={containerRef}
      className="h-full [&_.cm-editor]:h-full [&_.cm-editor]:outline-none"
    />
  );
}
