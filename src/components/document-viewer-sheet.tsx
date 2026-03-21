import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { EditorView, lineNumbers } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { json } from "@codemirror/lang-json";
import { foldGutter } from "@codemirror/language";
import { cmViewerTheme } from "@/lib/codemirror-theme";
import { CopyIcon, CheckIcon, ChevronDownIcon, ChevronUpIcon, PencilIcon, SaveIcon, Undo2Icon, Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  createViewerSearchExtensions,
  nextViewerSearchMatch,
  previousViewerSearchMatch,
  readViewerSearchState,
  setViewerSearchQuery,
  type ViewerSearchState,
} from "@/lib/codemirror-viewer-search";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { esRequest } from "@/lib/es-client";
import { toast } from "sonner";
import type { ClusterConfig } from "@/types/cluster";

interface SearchHit {
  _id: string;
  _index: string;
  _version?: number;
  _score: number | null;
  _seq_no?: number;
  _primary_term?: number;
  _source: Record<string, unknown>;
}

interface DocumentViewerSheetProps {
  hit: SearchHit | null;
  onClose: () => void;
  cluster: ClusterConfig;
  onDocumentUpdated?: () => void;
}

function buildMetaObject(hit: SearchHit): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    _index: hit._index,
    _id: hit._id,
  };
  if (hit._version !== undefined) meta._version = hit._version;
  if (hit._score !== undefined) meta._score = hit._score;
  if (hit._seq_no !== undefined) meta._seq_no = hit._seq_no;
  if (hit._primary_term !== undefined) meta._primary_term = hit._primary_term;
  return meta;
}

const DEFAULT_WIDTH = 576; // matches max-w-xl (36rem)
const MIN_WIDTH = 320;
const MAX_WIDTH_RATIO = 0.8; // 80% of viewport
const EMPTY_SEARCH_STATE: ViewerSearchState = {
  activeMatch: 0,
  hasMatches: false,
  query: "",
  totalMatches: 0,
};

export function DocumentViewerSheet({ hit, onClose, cluster, onDocumentUpdated }: DocumentViewerSheetProps) {
  const [showMeta, setShowMeta] = useState(false);
  const [copied, setCopied] = useState(false);
  const [sheetWidth, setSheetWidth] = useState(DEFAULT_WIDTH);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchState, setSearchState] = useState<ViewerSearchState>(EMPTY_SEARCH_STATE);
  const sourceViewRef = useRef<EditorView | null>(null);
  const isDragging = useRef(false);
  const [editing, setEditing] = useState(false);
  const [editedSource, setEditedSource] = useState("");
  const [saving, setSaving] = useState(false);

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMouseMove = (ev: MouseEvent) => {
      const newWidth = window.innerWidth - ev.clientX;
      const maxWidth = window.innerWidth * MAX_WIDTH_RATIO;
      setSheetWidth(Math.min(maxWidth, Math.max(MIN_WIDTH, newWidth)));
    };

    const onMouseUp = () => {
      isDragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, []);

  const sourceFormatted = useMemo(
    () => (hit ? JSON.stringify(hit._source, null, 2) : ""),
    [hit],
  );

  const isDirty = editing && editedSource !== sourceFormatted;

  // Reset edit state when hit changes
  useEffect(() => {
    setEditing(false);
    setEditedSource("");
  }, [hit]);

  const handleSave = async () => {
    if (!hit || !isDirty) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(editedSource);
    } catch {
      toast.error("Invalid JSON");
      return;
    }
    setSaving(true);
    try {
      let path = `/${encodeURIComponent(hit._index)}/_doc/${encodeURIComponent(hit._id)}`;
      if (hit._seq_no !== undefined && hit._primary_term !== undefined) {
        path += `?if_seq_no=${hit._seq_no}&if_primary_term=${hit._primary_term}`;
      }
      await esRequest(cluster, path, {
        method: "PUT",
        body: JSON.stringify(parsed),
      });
      toast.success("Document saved");
      setEditing(false);
      onDocumentUpdated?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save document");
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = () => {
    setEditing(false);
    setEditedSource(sourceFormatted);
  };

  const handleStartEditing = () => {
    setEditing(true);
    setEditedSource(sourceFormatted);
  };

  const metaFormatted = useMemo(
    () => (hit ? JSON.stringify(buildMetaObject(hit), null, 2) : ""),
    [hit],
  );

  const copyText = showMeta
    ? JSON.stringify({ ...buildMetaObject(hit!), _source: hit?._source }, null, 2)
    : sourceFormatted;

  const handleCopy = async () => {
    await navigator.clipboard.writeText(copyText);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleSourceViewReady = useCallback((view: EditorView | null) => {
    sourceViewRef.current = view;
    if (!view) {
      setSearchState(EMPTY_SEARCH_STATE);
      return;
    }
    setSearchState(setViewerSearchQuery(view, searchQuery));
  }, [searchQuery]);

  const handleSearchChange = useCallback((query: string) => {
    setSearchQuery(query);
    const view = sourceViewRef.current;
    if (!view) {
      setSearchState({
        ...EMPTY_SEARCH_STATE,
        query,
      });
      return;
    }
    setSearchState(setViewerSearchQuery(view, query, { scrollToFirst: Boolean(query) }));
  }, []);

  const handleSearchNext = useCallback(() => {
    const view = sourceViewRef.current;
    if (!view) return;
    setSearchState(nextViewerSearchMatch(view));
  }, []);

  const handleSearchPrevious = useCallback(() => {
    const view = sourceViewRef.current;
    if (!view) return;
    setSearchState(previousViewerSearchMatch(view));
  }, []);

  return (
    <Sheet open={hit !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent
        side="right"
        className="w-full flex flex-col p-6"
        style={{ width: sheetWidth, maxWidth: sheetWidth }}
      >
        {/* Drag handle on the left edge */}
        <div
          onMouseDown={handleDragStart}
          className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-primary/10 transition-colors z-10"
        />
        <SheetHeader className="p-0">
          <SheetTitle className="font-mono text-sm truncate">
            {hit?._id}
          </SheetTitle>
          <SheetDescription>Document source</SheetDescription>
        </SheetHeader>
        <div className="flex items-center justify-between">
          <label className="flex items-center gap-2 text-sm text-muted-foreground select-none cursor-pointer">
            <input
              type="checkbox"
              checked={showMeta}
              onChange={(e) => setShowMeta(e.target.checked)}
              className="accent-primary size-3.5"
            />
            Show metadata
          </label>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={handleCopy}>
              {copied ? (
                <CheckIcon className="size-4 text-green-500" />
              ) : (
                <CopyIcon className="size-4" />
              )}
              {copied ? "Copied" : "Copy"}
            </Button>
            <Button
              variant={editing ? "default" : "ghost"}
              size="sm"
              onClick={handleStartEditing}
            >
              <PencilIcon className="size-4" />
              Edit
            </Button>
            {editing && isDirty && (
              <Button variant="ghost" size="sm" onClick={handleSave} disabled={saving}>
                {saving ? (
                  <Loader2Icon className="size-4 animate-spin" />
                ) : (
                  <SaveIcon className="size-4" />
                )}
                Save
              </Button>
            )}
            {editing && (
              <Button variant="ghost" size="sm" onClick={handleDiscard}>
                <Undo2Icon className="size-4" />
                Discard
              </Button>
            )}
          </div>
        </div>
        {showMeta && hit && (
          <div className="rounded-md border overflow-hidden max-h-40">
            <JsonViewer value={metaFormatted} />
          </div>
        )}
        <div className="flex items-center gap-2 flex-wrap" data-testid="document-preview-search-toolbar">
          <Input
            data-testid="document-preview-search-input"
            className="h-8 min-w-0 flex-1"
            placeholder="Search preview text"
            value={searchQuery}
            onChange={(e) => handleSearchChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              if (!searchQuery || !searchState.hasMatches) return;
              e.preventDefault();
              handleSearchNext();
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="document-preview-search-prev"
            onClick={handleSearchPrevious}
            disabled={!searchQuery || !searchState.hasMatches}
          >
            <ChevronUpIcon className="size-4" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="document-preview-search-next"
            onClick={handleSearchNext}
            disabled={!searchQuery || !searchState.hasMatches}
          >
            <ChevronDownIcon className="size-4" />
          </Button>
          <span
            data-testid="document-preview-search-count"
            className="text-xs text-muted-foreground tabular-nums min-w-16 text-right"
          >
            {searchQuery ? `${searchState.activeMatch}/${searchState.totalMatches}` : "0/0"}
          </span>
        </div>
        <div className="flex-1 overflow-hidden rounded-md border" data-testid="document-preview-viewer">
          {hit && (
            <JsonViewer
              value={editing ? editedSource : sourceFormatted}
              editable={editing}
              onChange={setEditedSource}
              onViewReady={handleSourceViewReady}
              onSearchStateChange={setSearchState}
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function JsonViewer({
  value,
  editable,
  onChange,
  onViewReady,
  onSearchStateChange,
}: {
  value: string;
  editable?: boolean;
  onChange?: (value: string) => void;
  onViewReady?: (view: EditorView | null) => void;
  onSearchStateChange?: (searchState: ViewerSearchState) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const internalChangeRef = useRef(false);
  const onChangeRef = useRef(onChange);
  const onSearchStateChangeRef = useRef(onSearchStateChange);

  // Keep callback refs up to date without triggering editor recreation
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    onSearchStateChangeRef.current = onSearchStateChange;
  }, [onSearchStateChange]);

  // Create/recreate the editor when editable mode changes
  useEffect(() => {
    if (!containerRef.current) return;

    const extensions = [
      json(),
      cmViewerTheme,
      lineNumbers(),
      foldGutter(),
      ...createViewerSearchExtensions((view) => {
        onSearchStateChangeRef.current?.(readViewerSearchState(view));
      }),
      EditorView.lineWrapping,
    ];

    if (!editable) {
      extensions.unshift(EditorState.readOnly.of(true));
    }

    if (editable) {
      extensions.push(
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            internalChangeRef.current = true;
            onChangeRef.current?.(update.state.doc.toString());
          }
        }),
      );
    }

    const state = EditorState.create({
      doc: value,
      extensions,
    });

    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;
    onViewReady?.(view);
    onSearchStateChangeRef.current?.(readViewerSearchState(view));

    return () => {
      view.destroy();
      viewRef.current = null;
      onViewReady?.(null);
    };
    // Only recreate editor when editable mode changes – value updates are handled below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editable, onViewReady]);

  // Update editor content when value changes externally (new document, discard, etc.)
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    // Skip if this value change originated from user typing inside the editor
    if (internalChangeRef.current) {
      internalChangeRef.current = false;
      return;
    }

    const currentDoc = view.state.doc.toString();
    if (currentDoc !== value) {
      view.dispatch({
        changes: { from: 0, to: currentDoc.length, insert: value },
      });
    }
  }, [value]);

  return <div ref={containerRef} className="h-full [&_.cm-editor]:h-full [&_.cm-editor]:outline-none" />;
}
