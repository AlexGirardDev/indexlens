import { useState, useRef } from "react";
import {
  DownloadIcon,
  UploadIcon,
  FileIcon,
  AlertTriangleIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { readCredential } from "@/page/use-lock-session";
import { loadSavedQueries, saveSavedQueries } from "@/lib/rest-query-storage";
import {
  buildExportPayload,
  buildEncryptedExportEnvelope,
  decryptExportEnvelope,
  parseEncryptedExportEnvelope,
  parseIndexLensPayload,
  parseElasticvuePayload,
  mergeClusters,
  mergeSavedQueries,
  type IndexLensEncryptedExportEnvelope,
} from "@/lib/config-transfer";
import { validateConfirmation, validatePassphrase } from "@/page/lock-state";
import type { ClusterConfig } from "@/types/cluster";
import type { SavedQuery } from "@/lib/rest-query-storage";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLUSTERS_CREDENTIAL_ID = "cluster_configs";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface SettingsPageProps {
  clusters: ClusterConfig[];
  onClustersChange: (clusters: ClusterConfig[]) => Promise<void>;
  vimMode: boolean;
  onVimModeChange: (enabled: boolean) => void;
}

export function SettingsPage({ clusters, onClustersChange, vimMode, onVimModeChange }: SettingsPageProps) {
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [exportPassphrase, setExportPassphrase] = useState("");
  const [exportPassphraseConfirm, setExportPassphraseConfirm] = useState("");
  const [importPassphrase, setImportPassphrase] = useState("");
  const [pendingImportEnvelope, setPendingImportEnvelope] = useState<IndexLensEncryptedExportEnvelope | null>(null);
  const indexLensFileRef = useRef<HTMLInputElement>(null);
  const elasticvueFileRef = useRef<HTMLInputElement>(null);

  // -----------------------------------------------------------------------
  // Export IndexLens config (encrypted with transfer passphrase)
  // -----------------------------------------------------------------------

  const resetExportDialog = () => {
    setExportPassphrase("");
    setExportPassphraseConfirm("");
  };

  const closeExportDialog = () => {
    setExportDialogOpen(false);
    resetExportDialog();
  };

  const handleExport = async (passphrase: string) => {
    setExporting(true);
    try {
      // Load all saved queries for each cluster
      const savedQueries: Record<string, SavedQuery[]> = {};
      for (const cluster of clusters) {
        const queries = loadSavedQueries(cluster.id);
        if (queries.length > 0) {
          savedQueries[cluster.id] = queries;
        }
      }

      // Read cluster configs from the encrypted vault (includes auth secrets)
      const credResult = await readCredential(CLUSTERS_CREDENTIAL_ID);
      let vaultClusters: ClusterConfig[] = clusters;
      if (credResult.ok && credResult.data) {
        try {
          vaultClusters = JSON.parse(credResult.data) as ClusterConfig[];
        } catch {
          // fall back to in-memory clusters
        }
      }

      const payload = buildExportPayload(vaultClusters, savedQueries);
      const exportEnvelope = await buildEncryptedExportEnvelope(payload, passphrase);

      const blob = new Blob([JSON.stringify(exportEnvelope, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `indexlens-config-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);

      toast.success(`Exported ${vaultClusters.length} cluster(s)`);
      closeExportDialog();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Export failed");
    } finally {
      setExporting(false);
    }
  };

  // -----------------------------------------------------------------------
  // Import IndexLens config
  // -----------------------------------------------------------------------

  const resetImportDialog = () => {
    setImportPassphrase("");
  };

  const closeImportDialog = () => {
    setImportDialogOpen(false);
    resetImportDialog();
    setPendingImportEnvelope(null);
  };

  const handleIndexLensImport = async (file: File) => {
    setImporting(true);
    try {
      const text = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        toast.error("Invalid JSON file");
        return;
      }

      const envelope = parseEncryptedExportEnvelope(parsed);
      setPendingImportEnvelope(envelope);
      setImportDialogOpen(true);
      toast.info("Enter the export passphrase to import this configuration");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Import failed");
    } finally {
      setImporting(false);
      if (indexLensFileRef.current) indexLensFileRef.current.value = "";
    }
  };

  const finishIndexLensImport = async (passphrase: string) => {
    if (!pendingImportEnvelope) {
      toast.error("No IndexLens import file selected");
      return;
    }

    setImporting(true);
    try {
      const payload = await decryptExportEnvelope(pendingImportEnvelope, passphrase);
      const result = parseIndexLensPayload(payload);

      // Merge clusters
      const { merged: mergedClusters, added: clustersAdded, skipped: clustersSkipped } =
        mergeClusters(clusters, result.clusters);

      // Persist merged clusters
      await onClustersChange(mergedClusters);

      // Merge and persist saved queries per cluster
      let queriesAdded = 0;
      for (const [clusterId, importedQueries] of Object.entries(result.savedQueries)) {
        const existing = loadSavedQueries(clusterId);
        const { merged, added } = mergeSavedQueries(existing, importedQueries);
        saveSavedQueries(clusterId, merged);
        queriesAdded += added;
      }

      // Report results
      const parts: string[] = [];
      if (clustersAdded > 0) parts.push(`${clustersAdded} cluster(s)`);
      if (queriesAdded > 0) parts.push(`${queriesAdded} saved query/queries`);
      if (parts.length > 0) {
        toast.success(`Imported ${parts.join(" and ")}`);
      } else {
        toast.info("No new data to import (all items already exist)");
      }

      if (clustersSkipped > 0) {
        toast.info(`${clustersSkipped} duplicate cluster(s) skipped`);
      }

      for (const w of result.warnings) {
        toast.warning(w);
      }

      closeImportDialog();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Import failed");
    } finally {
      setImporting(false);
    }
  };

  // -----------------------------------------------------------------------
  // Import Elasticvue config
  // -----------------------------------------------------------------------

  const handleElasticvueImport = async (file: File) => {
    setImporting(true);
    try {
      const text = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        toast.error("Invalid JSON file");
        return;
      }

      const result = parseElasticvuePayload(parsed);

      // Merge clusters
      const { merged: mergedClusters, added: clustersAdded, skipped: clustersSkipped } =
        mergeClusters(clusters, result.clusters);

      await onClustersChange(mergedClusters);

      // Merge and persist saved queries per cluster
      let queriesAdded = 0;
      for (const [clusterId, importedQueries] of Object.entries(result.savedQueries)) {
        const existing = loadSavedQueries(clusterId);
        const { merged, added } = mergeSavedQueries(existing, importedQueries);
        saveSavedQueries(clusterId, merged);
        queriesAdded += added;
      }

      // Report results
      const parts: string[] = [];
      if (clustersAdded > 0) parts.push(`${clustersAdded} cluster(s)`);
      if (queriesAdded > 0) parts.push(`${queriesAdded} saved query/queries`);
      if (parts.length > 0) {
        toast.success(`Imported ${parts.join(" and ")} from Elasticvue`);
      } else {
        toast.info("No new data to import from Elasticvue");
      }

      if (clustersSkipped > 0) {
        toast.info(`${clustersSkipped} duplicate cluster(s) skipped`);
      }

      for (const w of result.warnings) {
        toast.warning(w);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Elasticvue import failed");
    } finally {
      setImporting(false);
      if (elasticvueFileRef.current) elasticvueFileRef.current.value = "";
    }
  };

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  const exportValidation = validatePassphrase(exportPassphrase);
  const exportConfirmValidation = validateConfirmation(exportPassphrase, exportPassphraseConfirm);
  const importValidation = validatePassphrase(importPassphrase);

  return (
    <div className="flex-1 p-6 max-w-2xl mx-auto w-full space-y-6">
      <h1 className="text-2xl font-semibold">Settings</h1>

      {/* Editor Preferences */}
      <Card>
        <CardHeader>
          <CardTitle>Editor</CardTitle>
          <CardDescription>
            Global editor preferences. These settings apply across all clusters.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={vimMode}
              onChange={(e) => onVimModeChange(e.target.checked)}
              className="size-4 rounded border-input accent-primary"
            />
            <span className="text-sm">Enable Vim keybindings</span>
          </label>
        </CardContent>
      </Card>

      {/* Export IndexLens Config */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <DownloadIcon className="size-5" />
            Export Configuration
          </CardTitle>
          <CardDescription>
            Download your IndexLens configuration as a JSON file.
            Includes all cluster connections and saved queries, encrypted with an export passphrase.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={() => setExportDialogOpen(true)} disabled={exporting || clusters.length === 0}>
            <DownloadIcon className="size-4" />
            {exporting ? "Exporting..." : "Export Encrypted Config"}
          </Button>
          {clusters.length === 0 && (
            <p className="text-sm text-muted-foreground mt-2">
              No clusters configured yet. Add a cluster first.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Import IndexLens Config */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UploadIcon className="size-5" />
            Import IndexLens Configuration
          </CardTitle>
          <CardDescription>
            Import a previously exported IndexLens configuration file.
            You must provide the passphrase used at export time.
            Duplicate clusters will be skipped automatically.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <input
            ref={indexLensFileRef}
            type="file"
            accept=".json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleIndexLensImport(file);
            }}
          />
          <Button
            variant="outline"
            disabled={importing}
            onClick={() => indexLensFileRef.current?.click()}
          >
            <FileIcon className="size-4" />
            {importing ? "Importing..." : "Choose File"}
          </Button>
        </CardContent>
      </Card>

      {/* Import Elasticvue Config */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UploadIcon className="size-5" />
            Import from Elasticvue
          </CardTitle>
          <CardDescription>
            Migrate from Elasticvue by importing its JSON config export.
            Only cluster connections and saved queries are imported.
            History, tabs, and other data are not transferred.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <input
            ref={elasticvueFileRef}
            type="file"
            accept=".json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleElasticvueImport(file);
            }}
          />
          <Button
            variant="outline"
            disabled={importing}
            onClick={() => elasticvueFileRef.current?.click()}
          >
            <FileIcon className="size-4" />
            {importing ? "Importing..." : "Choose Elasticvue File"}
          </Button>
          <div className="flex items-start gap-2 mt-3 text-sm text-muted-foreground">
            <AlertTriangleIcon className="size-4 shrink-0 mt-0.5" />
            <span>
              To export from Elasticvue, go to Elasticvue Settings &rarr; Backup &amp; Restore &rarr; Create Backup.
            </span>
          </div>
        </CardContent>
      </Card>

      <Dialog open={exportDialogOpen} onOpenChange={(open) => {
        if (!open) closeExportDialog();
        else setExportDialogOpen(true);
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Export Encrypted Configuration</DialogTitle>
            <DialogDescription>
              Enter a passphrase for this export file. You will need this same passphrase to import it later.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void handleExport(exportPassphrase);
            }}
          >
            <div className="space-y-1">
              <label htmlFor="export-passphrase" className="text-sm font-medium">Export Passphrase</label>
              <Input
                id="export-passphrase"
                type="password"
                value={exportPassphrase}
                onChange={(e) => setExportPassphrase(e.target.value)}
                placeholder="Enter export passphrase"
              />
              {!exportValidation.valid && exportValidation.message && (
                <p className="text-xs text-destructive">{exportValidation.message}</p>
              )}
            </div>
            <div className="space-y-1">
              <label htmlFor="export-passphrase-confirm" className="text-sm font-medium">Confirm Passphrase</label>
              <Input
                id="export-passphrase-confirm"
                type="password"
                value={exportPassphraseConfirm}
                onChange={(e) => setExportPassphraseConfirm(e.target.value)}
                placeholder="Re-enter export passphrase"
              />
              {!exportConfirmValidation.valid && exportConfirmValidation.message && (
                <p className="text-xs text-destructive">{exportConfirmValidation.message}</p>
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={closeExportDialog} disabled={exporting}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={exporting || !exportValidation.valid || !exportConfirmValidation.valid}
              >
                {exporting ? "Exporting..." : "Export"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={importDialogOpen} onOpenChange={(open) => {
        if (!open) closeImportDialog();
        else setImportDialogOpen(true);
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Import Encrypted Configuration</DialogTitle>
            <DialogDescription>
              Enter the passphrase that was used to create this IndexLens export.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void finishIndexLensImport(importPassphrase);
            }}
          >
            <div className="space-y-1">
              <label htmlFor="import-passphrase" className="text-sm font-medium">Export Passphrase</label>
              <Input
                id="import-passphrase"
                type="password"
                value={importPassphrase}
                onChange={(e) => setImportPassphrase(e.target.value)}
                placeholder="Enter export passphrase"
              />
              {!importValidation.valid && importValidation.message && (
                <p className="text-xs text-destructive">{importValidation.message}</p>
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={closeImportDialog} disabled={importing}>
                Cancel
              </Button>
              <Button type="submit" disabled={importing || !importValidation.valid}>
                {importing ? "Importing..." : "Import"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
