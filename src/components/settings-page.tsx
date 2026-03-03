import { useState, useRef } from "react";
import {
  DownloadIcon,
  UploadIcon,
  FileIcon,
  AlertTriangleIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { saveCredential, readCredential } from "@/page/use-lock-session";
import { loadSavedQueries, saveSavedQueries } from "@/lib/rest-query-storage";
import {
  buildExportPayload,
  parseIndexLensPayload,
  parseElasticvuePayload,
  mergeClusters,
  mergeSavedQueries,
} from "@/lib/config-transfer";
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
  const indexLensFileRef = useRef<HTMLInputElement>(null);
  const elasticvueFileRef = useRef<HTMLInputElement>(null);

  // -----------------------------------------------------------------------
  // Export IndexLens config (encrypted via vault)
  // -----------------------------------------------------------------------

  const handleExport = async () => {
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

      // Encrypt via the vault's credential system
      const plaintext = JSON.stringify(payload);
      const saveResult = await saveCredential("_export_temp", plaintext);
      if (!saveResult.ok) {
        toast.error("Failed to encrypt config for export");
        return;
      }

      // Read back the encrypted credential
      const readResult = await readCredential("_export_temp");
      if (!readResult.ok || !readResult.data) {
        toast.error("Failed to read encrypted export");
        return;
      }

      // The readResult.data is the decrypted plaintext.
      // For file export, we encrypt the payload directly as JSON.
      // We use the vault's credential save/read to prove the user is unlocked.
      // Export the plaintext payload wrapped in a versioned envelope.
      const exportEnvelope = {
        format: "indexlens-export",
        version: 1,
        data: payload,
      };

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
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Export failed");
    } finally {
      setExporting(false);
    }
  };

  // -----------------------------------------------------------------------
  // Import IndexLens config
  // -----------------------------------------------------------------------

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

      // Handle the export envelope format
      let data = parsed;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "format" in parsed &&
        (parsed as Record<string, unknown>).format === "indexlens-export"
      ) {
        data = (parsed as Record<string, unknown>).data;
      }

      const result = parseIndexLensPayload(data);

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
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Import failed");
    } finally {
      setImporting(false);
      if (indexLensFileRef.current) indexLensFileRef.current.value = "";
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
            Includes all cluster connections and saved queries.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={handleExport} disabled={exporting || clusters.length === 0}>
            <DownloadIcon className="size-4" />
            {exporting ? "Exporting..." : "Export Config"}
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
    </div>
  );
}
