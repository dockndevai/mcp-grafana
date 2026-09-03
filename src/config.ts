/**
 * Configuration from environment variables.
 */
import type { AccessMode, SecurityConfig } from "./security.js";

export interface GrafanaConnection {
  baseUrl: string;
  token: string;
  timeoutMs: number;
}

export interface AppConfig {
  connection: GrafanaConnection;
  security: SecurityConfig;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function list(name: string): string[] {
  const v = process.env[name];
  if (!v) return [];
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseMode(): AccessMode {
  const raw = (process.env.GRAFANA_MODE ?? "read-only").toLowerCase();
  if (raw === "read-only" || raw === "read-write" || raw === "admin") return raw;
  throw new Error(`Invalid GRAFANA_MODE '${raw}'. Expected one of: read-only, read-write, admin.`);
}

export function loadConfig(): AppConfig {
  return {
    connection: {
      baseUrl: (process.env.GRAFANA_URL || "http://localhost:3000").replace(/\/$/, ""),
      token: process.env.GRAFANA_TOKEN ?? process.env.GRAFANA_API_KEY ?? "",
      timeoutMs: Number(process.env.GRAFANA_TIMEOUT_MS ?? 30000),
    },
    security: {
      mode: parseMode(),
      folderAllowlist: list("GRAFANA_FOLDER_ALLOWLIST"),
      protectedFolders: list("GRAFANA_PROTECTED_FOLDERS"),
      datasourceAllowlist: list("GRAFANA_DATASOURCE_ALLOWLIST"),
      allowDelete: bool("GRAFANA_ALLOW_DELETE", false),
      dryRun: bool("GRAFANA_DRY_RUN", false),
      auditLog: bool("GRAFANA_AUDIT_LOG", true),
    },
  };
}
