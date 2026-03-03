import { useState, useEffect, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AUTH_TYPE_LABELS,
  CLUSTER_COLORS,
  type AuthConfig,
  type AuthType,
  type ClusterConfig,
} from "@/types/cluster";

export interface ClusterDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (cluster: ClusterConfig) => void;
  /** When set, the dialog operates in edit mode with pre-filled values. */
  initial?: ClusterConfig;
}

/** Kept for backwards compatibility. */
export type AddClusterDialogProps = ClusterDialogProps;

interface FormState {
  name: string;
  url: string;
  authType: AuthType;
  username: string;
  password: string;
  apiKey: string;
  token: string;
  color: string;
}

/** Auth field keys we track for "touched" detection. */
type AuthFieldKey = "username" | "password" | "apiKey" | "token";

const INITIAL_FORM: FormState = {
  name: "",
  url: "",
  authType: "none",
  username: "",
  password: "",
  apiKey: "",
  token: "",
  color: CLUSTER_COLORS[0],
};

function formFromCluster(cluster: ClusterConfig): FormState {
  const base: FormState = {
    ...INITIAL_FORM,
    name: cluster.name,
    url: cluster.url,
    color: cluster.color,
    authType: cluster.auth.type,
  };
  switch (cluster.auth.type) {
    case "basic":
      base.username = cluster.auth.username;
      base.password = cluster.auth.password;
      break;
    case "apikey":
      base.apiKey = cluster.auth.apiKey;
      break;
    case "bearer":
      base.token = cluster.auth.token;
      break;
  }
  return base;
}

function buildAuth(
  form: FormState,
  touched: Set<AuthFieldKey>,
  originalAuth: AuthConfig | undefined,
): AuthConfig {
  // If editing and auth type hasn't changed, merge untouched fields from original
  const sameType = originalAuth && originalAuth.type === form.authType;

  switch (form.authType) {
    case "basic": {
      const origBasic = sameType && originalAuth.type === "basic" ? originalAuth : undefined;
      return {
        type: "basic",
        username: touched.has("username") ? form.username : (origBasic?.username ?? form.username),
        password: touched.has("password") ? form.password : (origBasic?.password ?? form.password),
      };
    }
    case "apikey": {
      const origKey = sameType && originalAuth.type === "apikey" ? originalAuth : undefined;
      return {
        type: "apikey",
        apiKey: touched.has("apiKey") ? form.apiKey : (origKey?.apiKey ?? form.apiKey),
      };
    }
    case "bearer": {
      const origBearer = sameType && originalAuth.type === "bearer" ? originalAuth : undefined;
      return {
        type: "bearer",
        token: touched.has("token") ? form.token : (origBearer?.token ?? form.token),
      };
    }
    default:
      return { type: "none" };
  }
}

export function ClusterDialog({
  open,
  onOpenChange,
  onSubmit,
  initial,
}: ClusterDialogProps) {
  const isEdit = !!initial;
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [touchedAuth, setTouchedAuth] = useState<Set<AuthFieldKey>>(new Set());
  const prevOpenRef = useRef(false);

  // Reset form when dialog opens (or when initial changes while open)
  useEffect(() => {
    if (open && !prevOpenRef.current) {
      setForm(initial ? formFromCluster(initial) : INITIAL_FORM);
      setTouchedAuth(new Set());
    }
    prevOpenRef.current = open;
  }, [open, initial]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    // Track auth field touches
    if (["username", "password", "apiKey", "token"].includes(key as string)) {
      setTouchedAuth((prev) => new Set(prev).add(key as AuthFieldKey));
    }
  };

  const canSubmit = form.name.trim() !== "" && form.url.trim() !== "";

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;

    const cluster: ClusterConfig = {
      id: initial?.id ?? crypto.randomUUID(),
      name: form.name.trim(),
      url: form.url.trim().replace(/\/+$/, ""),
      color: form.color,
      auth: buildAuth(form, touchedAuth, initial?.auth),
    };

    onSubmit(cluster);
    setForm(INITIAL_FORM);
    setTouchedAuth(new Set());
    onOpenChange(false);
  };

  const handleCancel = () => {
    setForm(INITIAL_FORM);
    setTouchedAuth(new Set());
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{isEdit ? "Edit Cluster" : "Add Cluster"}</DialogTitle>
            <DialogDescription>
              {isEdit
                ? "Update the cluster configuration."
                : "Connect to an Elasticsearch cluster."}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            {/* Name */}
            <div className="grid gap-1.5">
              <label htmlFor="cluster-name" className="text-sm font-medium">
                Name
              </label>
              <Input
                id="cluster-name"
                placeholder="Production"
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
                autoFocus
              />
            </div>

            {/* URL */}
            <div className="grid gap-1.5">
              <label htmlFor="cluster-url" className="text-sm font-medium">
                URL
              </label>
              <Input
                id="cluster-url"
                placeholder="https://localhost:9200"
                value={form.url}
                onChange={(e) => set("url", e.target.value)}
              />
            </div>

            {/* Color picker */}
            <div className="grid gap-1.5">
              <span className="text-sm font-medium">Color</span>
              <div className="flex gap-2">
                {CLUSTER_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className="size-6 rounded-full border-2 transition-transform hover:scale-110"
                    style={{
                      backgroundColor: c,
                      borderColor: form.color === c ? "white" : "transparent",
                      boxShadow: form.color === c ? `0 0 0 2px ${c}` : "none",
                    }}
                    onClick={() => set("color", c)}
                    aria-label={`Select color ${c}`}
                  />
                ))}
              </div>
            </div>

            {/* Auth type */}
            <div className="grid gap-1.5">
              <label className="text-sm font-medium">Authentication</label>
              <Select
                value={form.authType}
                onValueChange={(v) => set("authType", v as AuthType)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.entries(AUTH_TYPE_LABELS) as [AuthType, string][]).map(
                    ([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ),
                  )}
                </SelectContent>
              </Select>
            </div>

            {/* Auth fields — rendered conditionally */}
            {form.authType === "basic" && (
              <>
                <div className="grid gap-1.5">
                  <label htmlFor="auth-username" className="text-sm font-medium">
                    Username
                  </label>
                  <Input
                    id="auth-username"
                    placeholder={isEdit ? "(unchanged)" : "elastic"}
                    value={form.username}
                    onChange={(e) => set("username", e.target.value)}
                    autoComplete="username"
                  />
                </div>
                <div className="grid gap-1.5">
                  <label htmlFor="auth-password" className="text-sm font-medium">
                    Password
                  </label>
                  <Input
                    id="auth-password"
                    type="password"
                    placeholder={isEdit ? "(unchanged)" : undefined}
                    value={form.password}
                    onChange={(e) => set("password", e.target.value)}
                    autoComplete="current-password"
                  />
                </div>
              </>
            )}

            {form.authType === "apikey" && (
              <div className="grid gap-1.5">
                <label htmlFor="auth-apikey" className="text-sm font-medium">
                  API Key
                </label>
                <Input
                  id="auth-apikey"
                  type="password"
                  placeholder={isEdit ? "(unchanged)" : "Base64-encoded API key"}
                  value={form.apiKey}
                  onChange={(e) => set("apiKey", e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  The base64-encoded <code>id:api_key</code> value.
                </p>
              </div>
            )}

            {form.authType === "bearer" && (
              <div className="grid gap-1.5">
                <label htmlFor="auth-bearer" className="text-sm font-medium">
                  Bearer Token
                </label>
                <Input
                  id="auth-bearer"
                  type="password"
                  placeholder={isEdit ? "(unchanged)" : "Token"}
                  value={form.token}
                  onChange={(e) => set("token", e.target.value)}
                />
              </div>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={handleCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {isEdit ? "Save Changes" : "Add Cluster"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** @deprecated Use ClusterDialog instead. */
export const AddClusterDialog = ClusterDialog;
