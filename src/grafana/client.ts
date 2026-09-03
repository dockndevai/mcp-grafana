/**
 * Thin HTTP client for a Grafana instance.
 *
 * Authenticates with a **service account token** (Bearer) rather than a user session, because that
 * is what a process can hold. Scope the token to the least role that works (Viewer for read-only
 * use, Editor for writes) — the token's own role is the primary access control; this server's
 * flags are defence in depth on top of it.
 *
 * Datasource secrets (`secureJsonData`, `basicAuthPassword`, …) are never returned to the model:
 * see `redactDatasource`.
 */

export class GrafanaError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GrafanaError";
  }
}

export interface SearchHit {
  uid: string;
  title: string;
  type: string; // "dash-db" | "dash-folder"
  url?: string;
  folderUid?: string;
  folderTitle?: string;
  tags?: string[];
}

export interface Folder {
  uid: string;
  title: string;
  url?: string;
  parentUid?: string;
}

export interface Datasource {
  uid: string;
  name: string;
  type: string;
  url?: string;
  isDefault?: boolean;
  readOnly?: boolean;
  [k: string]: unknown;
}

/** Fields safe to expose. Everything else (secureJsonData, passwords, tokens) is dropped. */
export function redactDatasource(ds: Record<string, unknown>): Datasource {
  return {
    uid: ds.uid as string,
    name: ds.name as string,
    type: ds.type as string,
    url: ds.url as string | undefined,
    isDefault: ds.isDefault as boolean | undefined,
    readOnly: ds.readOnly as boolean | undefined,
    access: ds.access as string | undefined,
    database: ds.database as string | undefined,
  };
}

export interface DsQuery {
  refId?: string;
  datasourceUid: string;
  datasourceType?: string;
  /** Prometheus/Loki expression. */
  expr?: string;
  /** SQL for SQL datasources. */
  rawSql?: string;
  /** Free-form extra fields merged into the query object. */
  extra?: Record<string, unknown>;
  maxDataPoints?: number;
  intervalMs?: number;
}

export class GrafanaClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly timeoutMs = 30_000,
  ) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...(init.headers ?? {}),
        },
      });
      if (!res.ok) {
        let detail = res.statusText;
        try {
          const body = (await res.json()) as { message?: string };
          detail = body.message ?? detail;
        } catch {
          /* non-JSON error body; status text will do */
        }
        throw new GrafanaError(res.status, detail);
      }
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      return (text ? JSON.parse(text) : undefined) as T;
    } catch (err) {
      if (err instanceof GrafanaError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new GrafanaError(504, `Grafana did not respond within ${this.timeoutMs / 1000}s.`);
      }
      throw new GrafanaError(0, err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
    }
  }

  // --- Health ---
  health() {
    return this.request<{ database?: string; version?: string; commit?: string }>("/api/health");
  }

  // --- Search (dashboards + folders) ---
  search(params: { query?: string; type?: string; tag?: string; folderUIDs?: string; limit?: number }) {
    const q = new URLSearchParams();
    if (params.query) q.set("query", params.query);
    if (params.type) q.set("type", params.type);
    if (params.tag) q.set("tag", params.tag);
    if (params.folderUIDs) q.set("folderUIDs", params.folderUIDs);
    q.set("limit", String(params.limit ?? 100));
    return this.request<SearchHit[]>(`/api/search?${q.toString()}`);
  }

  // --- Dashboards ---
  getDashboard(uid: string) {
    return this.request<{ dashboard: Record<string, unknown>; meta: Record<string, unknown> }>(
      `/api/dashboards/uid/${encodeURIComponent(uid)}`,
    );
  }
  upsertDashboard(body: { dashboard: Record<string, unknown>; folderUid?: string; message?: string; overwrite?: boolean }) {
    return this.request<{ uid: string; id: number; url: string; version: number; status: string }>(
      "/api/dashboards/db",
      { method: "POST", body: JSON.stringify(body) },
    );
  }
  deleteDashboard(uid: string) {
    return this.request<{ title?: string; message?: string }>(`/api/dashboards/uid/${encodeURIComponent(uid)}`, {
      method: "DELETE",
    });
  }

  // --- Folders ---
  listFolders() {
    return this.request<Folder[]>("/api/folders?limit=1000");
  }
  getFolder(uid: string) {
    return this.request<Folder>(`/api/folders/${encodeURIComponent(uid)}`);
  }
  createFolder(body: { title: string; uid?: string; parentUid?: string }) {
    return this.request<Folder>("/api/folders", { method: "POST", body: JSON.stringify(body) });
  }
  deleteFolder(uid: string) {
    return this.request<{ message?: string }>(`/api/folders/${encodeURIComponent(uid)}`, { method: "DELETE" });
  }

  // --- Datasources ---
  listDatasources() {
    return this.request<Array<Record<string, unknown>>>("/api/datasources");
  }
  getDatasource(uid: string) {
    return this.request<Record<string, unknown>>(`/api/datasources/uid/${encodeURIComponent(uid)}`);
  }

  // --- Query (unified /api/ds/query) ---
  query(queries: DsQuery[], from = "now-1h", to = "now") {
    const body = {
      from,
      to,
      queries: queries.map((q, i) => ({
        refId: q.refId ?? `A${i || ""}`,
        datasource: { uid: q.datasourceUid, ...(q.datasourceType ? { type: q.datasourceType } : {}) },
        ...(q.expr !== undefined ? { expr: q.expr } : {}),
        ...(q.rawSql !== undefined ? { rawSql: q.rawSql } : {}),
        maxDataPoints: q.maxDataPoints ?? 100,
        intervalMs: q.intervalMs ?? 60_000,
        ...(q.extra ?? {}),
      })),
    };
    return this.request<Record<string, unknown>>("/api/ds/query", { method: "POST", body: JSON.stringify(body) });
  }

  // --- Alerting (Grafana-managed, read via provisioning API) ---
  listAlertRules() {
    return this.request<Array<Record<string, unknown>>>("/api/v1/provisioning/alert-rules");
  }

  // --- Annotations ---
  listAnnotations(params: { from?: number; to?: number; limit?: number; tags?: string[] } = {}) {
    const q = new URLSearchParams();
    if (params.from) q.set("from", String(params.from));
    if (params.to) q.set("to", String(params.to));
    q.set("limit", String(params.limit ?? 100));
    for (const t of params.tags ?? []) q.append("tags", t);
    return this.request<Array<Record<string, unknown>>>(`/api/annotations?${q.toString()}`);
  }
  createAnnotation(body: { text: string; tags?: string[]; time?: number; timeEnd?: number; dashboardUID?: string; panelId?: number }) {
    return this.request<{ id: number; message: string }>("/api/annotations", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }
  deleteAnnotation(id: number) {
    return this.request<{ message?: string }>(`/api/annotations/${id}`, { method: "DELETE" });
  }
}
