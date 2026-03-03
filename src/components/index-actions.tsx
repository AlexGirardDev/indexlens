import { useState, useEffect } from "react";
import {
  MoreHorizontalIcon,
  TagIcon,
  CopyIcon,
  RefreshCwIcon,
  Trash2Icon,
  FileX2Icon,
  ArrowRightLeftIcon,
  XIcon,
  PlusIcon,
  Loader2Icon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { esRequest } from "@/lib/es-client";
import type { ClusterConfig } from "@/types/cluster";
import { toast } from "sonner";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ActionDialog {
  action: string;
  indexNames: string[];
}

interface CatAliasRecord {
  alias: string;
  index: string;
}

// ---------------------------------------------------------------------------
// Per-row actions dropdown
// ---------------------------------------------------------------------------

interface IndexActionsDropdownProps {
  indexName: string;
  onAction: (action: string, indexNames: string[]) => void;
}

export function IndexActionsDropdown({
  indexName,
  onAction,
}: IndexActionsDropdownProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-8">
          <MoreHorizontalIcon className="size-4" />
          <span className="sr-only">Actions</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => onAction("aliases", [indexName])}>
          <TagIcon />
          Manage Aliases
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onAction("reindex", [indexName])}>
          <ArrowRightLeftIcon />
          Reindex
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onAction("clone", [indexName])}>
          <CopyIcon />
          Clone
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onAction("refresh", [indexName])}>
          <RefreshCwIcon />
          Refresh
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onClick={() => onAction("deleteDocuments", [indexName])}
        >
          <FileX2Icon />
          Delete Documents
        </DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          onClick={() => onAction("deleteIndex", [indexName])}
        >
          <Trash2Icon />
          Delete Index
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---------------------------------------------------------------------------
// Bulk actions bar
// ---------------------------------------------------------------------------

interface BulkActionsBarProps {
  selected: Set<string>;
  onAction: (action: string, indexNames: string[]) => void;
  onClear: () => void;
}

export function BulkActionsBar({
  selected,
  onAction,
  onClear,
}: BulkActionsBarProps) {
  if (selected.size === 0) return null;

  const names = Array.from(selected);

  return (
    <div className="sticky bottom-0 flex items-center justify-between gap-4 rounded-lg border bg-popover px-4 py-3">
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium">
          {selected.size} {selected.size === 1 ? "index" : "indices"} selected
        </span>
        <Button variant="link" size="sm" onClick={onClear} className="h-auto p-0 text-xs">
          Clear selection
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => onAction("refresh", names)}
        >
          <RefreshCwIcon className="size-4 mr-1" />
          Refresh
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="text-destructive border-destructive/50 hover:bg-destructive/10"
          onClick={() => onAction("deleteDocuments", names)}
        >
          <FileX2Icon className="size-4 mr-1" />
          Delete Documents
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="text-destructive border-destructive/50 hover:bg-destructive/10"
          onClick={() => onAction("deleteIndex", names)}
        >
          <Trash2Icon className="size-4 mr-1" />
          Delete Index
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dialog orchestrator
// ---------------------------------------------------------------------------

interface ActionDialogsProps {
  actionDialog: ActionDialog | null;
  cluster: ClusterConfig;
  onClose: () => void;
  onSuccess: () => void;
}

export function ActionDialogs({
  actionDialog,
  cluster,
  onClose,
  onSuccess,
}: ActionDialogsProps) {
  if (!actionDialog) return null;

  const { action, indexNames } = actionDialog;

  switch (action) {
    case "aliases":
      return (
        <ManageAliasesDialog
          indexName={indexNames[0]}
          cluster={cluster}
          onClose={onClose}
          onSuccess={onSuccess}
        />
      );
    case "reindex":
      return (
        <ReindexDialog
          indexName={indexNames[0]}
          cluster={cluster}
          onClose={onClose}
          onSuccess={onSuccess}
        />
      );
    case "clone":
      return (
        <CloneDialog
          indexName={indexNames[0]}
          cluster={cluster}
          onClose={onClose}
          onSuccess={onSuccess}
        />
      );
    case "deleteDocuments":
      return (
        <DeleteDocumentsDialog
          indexNames={indexNames}
          cluster={cluster}
          onClose={onClose}
          onSuccess={onSuccess}
        />
      );
    case "deleteIndex":
      return (
        <DeleteIndexDialog
          indexNames={indexNames}
          cluster={cluster}
          onClose={onClose}
          onSuccess={onSuccess}
        />
      );
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Refresh action (no dialog)
// ---------------------------------------------------------------------------

// eslint-disable-next-line react-refresh/only-export-components
export async function executeRefresh(
  cluster: ClusterConfig,
  indexNames: string[],
  onSuccess: () => void,
) {
  try {
    const target = indexNames.join(",");
    await esRequest(cluster, `/${encodeURIComponent(target)}/_refresh`, {
      method: "POST",
    });
    if (indexNames.length === 1) {
      toast.success(`Refreshed "${indexNames[0]}"`);
    } else {
      toast.success(`Refreshed ${indexNames.length} indices`);
    }
    onSuccess();
  } catch (err) {
    toast.error(
      err instanceof Error ? err.message : "Failed to refresh",
    );
  }
}

// ---------------------------------------------------------------------------
// Manage Aliases Dialog
// ---------------------------------------------------------------------------

function ManageAliasesDialog({
  indexName,
  cluster,
  onClose,
  onSuccess,
}: {
  indexName: string;
  cluster: ClusterConfig;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [existingAliases, setExistingAliases] = useState<string[]>([]);
  const [removals, setRemovals] = useState<Set<string>>(new Set());
  const [additions, setAdditions] = useState<string[]>([]);
  const [newAlias, setNewAlias] = useState("");
  const [loadingAliases, setLoadingAliases] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const all = await esRequest<CatAliasRecord[]>(
          cluster,
          `/_cat/aliases?format=json&h=alias,index`,
        );
        if (cancelled) return;
        const aliases = all
          .filter((r) => r.index === indexName)
          .map((r) => r.alias);
        setExistingAliases(aliases);
      } catch {
        if (!cancelled) toast.error("Failed to fetch aliases");
      } finally {
        if (!cancelled) setLoadingAliases(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cluster, indexName]);

  const handleAddAlias = () => {
    const trimmed = newAlias.trim();
    if (!trimmed) return;
    if (
      existingAliases.includes(trimmed) &&
      !removals.has(trimmed)
    ) return;
    if (additions.includes(trimmed)) return;
    // If it was marked for removal, un-remove it
    if (removals.has(trimmed)) {
      setRemovals((prev) => {
        const next = new Set(prev);
        next.delete(trimmed);
        return next;
      });
    } else {
      setAdditions((prev) => [...prev, trimmed]);
    }
    setNewAlias("");
  };

  const handleRemoveExisting = (alias: string) => {
    setRemovals((prev) => new Set(prev).add(alias));
  };

  const handleRemoveAddition = (alias: string) => {
    setAdditions((prev) => prev.filter((a) => a !== alias));
  };

  const hasChanges = removals.size > 0 || additions.length > 0;

  const handleSave = async () => {
    if (!hasChanges) return;
    setSubmitting(true);
    try {
      const actions: Record<string, { index: string; alias: string }>[] = [];
      for (const alias of removals) {
        actions.push({ remove: { index: indexName, alias } });
      }
      for (const alias of additions) {
        actions.push({ add: { index: indexName, alias } });
      }
      await esRequest(cluster, `/_aliases`, {
        method: "POST",
        body: JSON.stringify({ actions }),
      });
      toast.success("Aliases updated");
      onSuccess();
      onClose();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to update aliases",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const visibleExisting = existingAliases.filter((a) => !removals.has(a));

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Manage Aliases</DialogTitle>
          <DialogDescription>
            Add or remove aliases for <span className="font-mono">{indexName}</span>
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {loadingAliases ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2Icon className="size-4 animate-spin" />
              Loading aliases...
            </div>
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                {visibleExisting.map((alias) => (
                  <span
                    key={alias}
                    className="inline-flex items-center gap-1 rounded-md bg-secondary px-2 py-1 text-sm"
                  >
                    {alias}
                    <button
                      onClick={() => handleRemoveExisting(alias)}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <XIcon className="size-3" />
                    </button>
                  </span>
                ))}
                {additions.map((alias) => (
                  <span
                    key={alias}
                    className="inline-flex items-center gap-1 rounded-md bg-primary/10 text-primary px-2 py-1 text-sm"
                  >
                    {alias}
                    <button
                      onClick={() => handleRemoveAddition(alias)}
                      className="text-primary/60 hover:text-destructive"
                    >
                      <XIcon className="size-3" />
                    </button>
                  </span>
                ))}
                {visibleExisting.length === 0 && additions.length === 0 && (
                  <span className="text-sm text-muted-foreground">No aliases</span>
                )}
              </div>
              <div className="flex gap-2">
                <Input
                  placeholder="New alias name"
                  value={newAlias}
                  onChange={(e) => setNewAlias(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleAddAlias()}
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleAddAlias}
                  disabled={!newAlias.trim()}
                >
                  <PlusIcon className="size-4 mr-1" />
                  Add
                </Button>
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={!hasChanges || submitting}
          >
            {submitting && <Loader2Icon className="size-4 mr-1 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Reindex Dialog
// ---------------------------------------------------------------------------

function ReindexDialog({
  indexName,
  cluster,
  onClose,
  onSuccess,
}: {
  indexName: string;
  cluster: ClusterConfig;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [destIndex, setDestIndex] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!destIndex.trim()) return;
    setSubmitting(true);
    try {
      await esRequest(cluster, `/_reindex`, {
        method: "POST",
        body: JSON.stringify({
          source: { index: indexName },
          dest: { index: destIndex.trim() },
        }),
      });
      toast.success(`Reindex from "${indexName}" to "${destIndex.trim()}" started`);
      onSuccess();
      onClose();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to reindex",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reindex</DialogTitle>
          <DialogDescription>
            Copy documents from <span className="font-mono">{indexName}</span> to a
            new index.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div>
            <label className="text-sm font-medium">Source index</label>
            <div className="mt-1 rounded-md border bg-muted px-3 py-2 text-sm font-mono">
              {indexName}
            </div>
          </div>
          <div>
            <label className="text-sm font-medium">Destination index</label>
            <Input
              className="mt-1"
              placeholder="my-new-index"
              value={destIndex}
              onChange={(e) => setDestIndex(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!destIndex.trim() || submitting}
          >
            {submitting && <Loader2Icon className="size-4 mr-1 animate-spin" />}
            Reindex
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Clone Dialog
// ---------------------------------------------------------------------------

function CloneDialog({
  indexName,
  cluster,
  onClose,
  onSuccess,
}: {
  indexName: string;
  cluster: ClusterConfig;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [targetIndex, setTargetIndex] = useState(`${indexName}-clone`);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!targetIndex.trim()) return;
    setSubmitting(true);
    try {
      // Block writes
      await esRequest(
        cluster,
        `/${encodeURIComponent(indexName)}/_settings`,
        {
          method: "PUT",
          body: JSON.stringify({ "index.blocks.write": true }),
        },
      );
      try {
        // Clone
        await esRequest(
          cluster,
          `/${encodeURIComponent(indexName)}/_clone/${encodeURIComponent(targetIndex.trim())}`,
          { method: "POST" },
        );
        toast.success(`Cloned "${indexName}" to "${targetIndex.trim()}"`);
        onSuccess();
        onClose();
      } finally {
        // Unblock writes
        await esRequest(
          cluster,
          `/${encodeURIComponent(indexName)}/_settings`,
          {
            method: "PUT",
            body: JSON.stringify({ "index.blocks.write": null }),
          },
        ).catch(() => {
          // Ignore error on unblock, but warn user
          toast.error(
            `Warning: Failed to remove write block from "${indexName}". You may need to remove it manually.`,
          );
        });
      }
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to clone index",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Clone Index</DialogTitle>
          <DialogDescription>
            Clone <span className="font-mono">{indexName}</span> to a new index.
            The source index will be temporarily set to read-only during the
            clone operation.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div>
            <label className="text-sm font-medium">Source index</label>
            <div className="mt-1 rounded-md border bg-muted px-3 py-2 text-sm font-mono">
              {indexName}
            </div>
          </div>
          <div>
            <label className="text-sm font-medium">Target index</label>
            <Input
              className="mt-1"
              value={targetIndex}
              onChange={(e) => setTargetIndex(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!targetIndex.trim() || submitting}
          >
            {submitting && <Loader2Icon className="size-4 mr-1 animate-spin" />}
            Clone
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Delete Documents Dialog
// ---------------------------------------------------------------------------

function DeleteDocumentsDialog({
  indexNames,
  cluster,
  onClose,
  onSuccess,
}: {
  indexNames: string[];
  cluster: ClusterConfig;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [confirmation, setConfirmation] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const isSingle = indexNames.length === 1;
  const requiredText = isSingle ? indexNames[0] : "delete";
  const confirmed = confirmation === requiredText;

  const handleDelete = async () => {
    if (!confirmed) return;
    setSubmitting(true);
    try {
      const target = indexNames.join(",");
      await esRequest(
        cluster,
        `/${encodeURIComponent(target)}/_delete_by_query`,
        {
          method: "POST",
          body: JSON.stringify({ query: { match_all: {} } }),
        },
      );
      if (isSingle) {
        toast.success(`Deleted all documents from "${indexNames[0]}"`);
      } else {
        toast.success(`Deleted all documents from ${indexNames.length} indices`);
      }
      onSuccess();
      onClose();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to delete documents",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete Documents</DialogTitle>
          <DialogDescription>
            {isSingle ? (
              <>
                This will delete ALL documents from &quot;
                <span className="font-mono">{indexNames[0]}</span>&quot;. This
                action cannot be undone.
              </>
            ) : (
              <>
                This will delete ALL documents from {indexNames.length} indices.
                This action cannot be undone.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {!isSingle && (
          <div className="max-h-32 overflow-y-auto rounded-md border bg-muted px-3 py-2">
            <ul className="text-sm font-mono space-y-0.5">
              {indexNames.map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
          </div>
        )}

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
// Delete Index Dialog
// ---------------------------------------------------------------------------

function DeleteIndexDialog({
  indexNames,
  cluster,
  onClose,
  onSuccess,
}: {
  indexNames: string[];
  cluster: ClusterConfig;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [confirmation, setConfirmation] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const isSingle = indexNames.length === 1;
  const requiredText = isSingle ? indexNames[0] : "delete";
  const confirmed = confirmation === requiredText;

  const handleDelete = async () => {
    if (!confirmed) return;
    setSubmitting(true);
    try {
      const target = indexNames.join(",");
      await esRequest(cluster, `/${encodeURIComponent(target)}`, {
        method: "DELETE",
      });
      if (isSingle) {
        toast.success(`Deleted index "${indexNames[0]}"`);
      } else {
        toast.success(`Deleted ${indexNames.length} indices`);
      }
      onSuccess();
      onClose();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to delete index",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete Index</DialogTitle>
          <DialogDescription>
            {isSingle ? (
              <>
                This will permanently delete the index &quot;
                <span className="font-mono">{indexNames[0]}</span>&quot; and all
                its data. This action cannot be undone.
              </>
            ) : (
              <>
                This will permanently delete {indexNames.length} indices and all
                their data. This action cannot be undone.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {!isSingle && (
          <div className="max-h-32 overflow-y-auto rounded-md border bg-muted px-3 py-2">
            <ul className="text-sm font-mono space-y-0.5">
              {indexNames.map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
          </div>
        )}

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
            Delete Index
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
