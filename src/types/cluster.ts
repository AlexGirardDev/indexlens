export type AuthType = "none" | "basic" | "apikey" | "bearer";

export interface AuthNone {
  type: "none";
}

export interface AuthBasic {
  type: "basic";
  username: string;
  password: string;
}

export interface AuthApiKey {
  type: "apikey";
  apiKey: string;
}

export interface AuthBearer {
  type: "bearer";
  token: string;
}

export type AuthConfig = AuthNone | AuthBasic | AuthApiKey | AuthBearer;

export interface ClusterConfig {
  id: string;
  name: string;
  url: string;
  auth: AuthConfig;
  color: string;
}

export type Page = "dashboard" | "indices" | "rest" | "settings";

export const AUTH_TYPE_LABELS: Record<AuthType, string> = {
  none: "No authentication",
  basic: "Basic (username / password)",
  apikey: "API Key",
  bearer: "Bearer Token",
};

export const CLUSTER_COLORS = [
  "#ef4444", // red
  "#f97316", // orange
  "#eab308", // yellow
  "#22c55e", // green
  "#06b6d4", // cyan
  "#3b82f6", // blue
  "#8b5cf6", // violet
  "#ec4899", // pink
] as const;
