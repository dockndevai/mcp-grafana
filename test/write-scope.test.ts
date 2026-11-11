import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { AppConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";
import type { SecurityConfig } from "../src/security.js";

/**
 * Scope checks for the WRITE tools (create_or_update_dashboard, create_annotation, create_folder) and the
 * nested-folder / General-folder rules. A tiny in-memory Grafana sits behind a stubbed `fetch`, so these tests
 * exercise the real client + policy + handlers and assert on which HTTP calls were (not) made.
 */

const config = (security: Partial<SecurityConfig> = {}): AppConfig => ({
  connection: { baseUrl: "http://grafana.invalid", token: "t", timeoutMs: 1000 },
  security: {
    mode: "admin",
    folderAllowlist: [],
    protectedFolders: [],
    datasourceAllowlist: [],
    allowDelete: true,
    dryRun: false,
    auditLog: false,
    requireHumanApproval: false,
    ...security,
  },
});

async function connect(security: Partial<SecurityConfig> = {}) {
  const { server } = buildServer(config(security));
  const client = new Client({ name: "t", version: "0" }, { capabilities: { elicitation: {} } });
  // An approving human, so any refusal below comes from scope checks and not from the prompt.
  client.setRequestHandler(ElicitRequestSchema, async (req) => {
    const m = (req.params as { requestedSchema?: { properties?: Record<string, unknown> } }).requestedSchema?.properties ?? {};
    return { action: "accept", content: "typed" in m ? { confirm: true, typed: lastTyped } : { confirm: true } };
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}
let lastTyped = "";

const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");
const isError = (r: unknown) => (r as { isError?: boolean }).isError === true;

interface FolderRow { uid: string; title: string; parentUid?: string }
interface DashRow { uid: string; id: number; title: string; folderUid?: string }

class FakeGrafana {
  folders = new Map<string, FolderRow>();
  dashboards = new Map<string, DashRow>();
  failGet = new Set<string>(); // request paths that answer 500
  calls: Array<{ method: string; path: string; body?: unknown }> = [];
  writes() {
    return this.calls.filter((c) => c.method !== "GET");
  }
  addFolder(uid: string, title: string, parentUid?: string) {
    this.folders.set(uid, { uid, title, ...(parentUid ? { parentUid } : {}) });
    return this;
  }
  addDash(uid: string, id: number, folderUid?: string) {
    this.dashboards.set(uid, { uid, id, title: uid, ...(folderUid ? { folderUid } : {}) });
    return this;
  }
  install() {
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      const u = new URL(url);
      const path = u.pathname + u.search;
      const method = (init.method ?? "GET").toUpperCase();
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      this.calls.push({ method, path, body });
      const json = (status: number, v: unknown) =>
        new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
      if (this.failGet.has(path)) return json(500, { message: "boom" });

      let m = /^\/api\/dashboards\/uid\/(.+)$/.exec(u.pathname);
      if (m) {
        const d = this.dashboards.get(decodeURIComponent(m[1]!));
        if (!d) return json(404, { message: "Dashboard not found" });
        if (method === "DELETE") return json(200, { message: "deleted" });
        const f = d.folderUid ? this.folders.get(d.folderUid) : undefined;
        return json(200, {
          dashboard: { uid: d.uid, id: d.id, title: d.title, version: 1 },
          meta: { folderUid: d.folderUid ?? "", folderTitle: f?.title ?? "General" },
        });
      }
      if (u.pathname === "/api/folders" && method === "GET") {
        const parent = u.searchParams.get("parentUid");
        return json(200, [...this.folders.values()].filter((f) => (f.parentUid ?? null) === parent));
      }
      m = /^\/api\/folders\/(.+)$/.exec(u.pathname);
      if (m) {
        const f = this.folders.get(decodeURIComponent(m[1]!));
        if (!f) return json(404, { message: "folder not found" });
        return json(200, { id: 1, created: "2026-01-01", ...f });
      }
      if (u.pathname === "/api/dashboards/db") return json(200, { status: "success", uid: "x", id: 1, url: "/d/x", version: 2 });
      if (u.pathname === "/api/annotations" && method === "POST") return json(200, { id: 9, message: "created" });
      if (u.pathname === "/api/folders" && method === "POST") return json(200, { uid: "n", title: "n" });
      return json(404, { message: `unhandled ${method} ${path}` });
    });
    return this;
  }
}

afterEach(() => vi.unstubAllGlobals());

const upsert = (c: Client, args: Record<string, unknown>) => c.callTool({ name: "create_or_update_dashboard", arguments: args });
const posted = (g: FakeGrafana, path: string) => g.writes().filter((w) => w.method === "POST" && w.path === path);

describe("gap 1: create_or_update_dashboard checks the dashboard's CURRENT folder", () => {
  const fixture = () =>
    new FakeGrafana()
      .addFolder("prod", "Production")
      .addFolder("team", "Team A")
      .addDash("dp", 11, "prod")
      .addDash("dt", 12, "team")
      .install();

  it("refuses overwriting a dashboard that sits in a protected folder when folderUid is omitted", async () => {
    const g = fixture();
    const c = await connect({ protectedFolders: ["Production"] });
    const res = await upsert(c, { dashboard: { uid: "dp", title: "x" }, overwrite: true });
    expect(isError(res)).toBe(true);
    expect(text(res)).toMatch(/protected/);
    expect(posted(g, "/api/dashboards/db")).toHaveLength(0);
  });

  it("refuses MOVING a dashboard out of a protected folder into another folder", async () => {
    const g = fixture();
    const c = await connect({ protectedFolders: ["Production"] });
    const res = await upsert(c, { dashboard: { uid: "dp", title: "x" }, folderUid: "team", overwrite: true });
    expect(isError(res)).toBe(true);
    expect(text(res)).toMatch(/protected/);
    expect(posted(g, "/api/dashboards/db")).toHaveLength(0);
  });

  it("refuses overwriting a dashboard whose current folder is outside the allowlist, even into an allowed one", async () => {
    const g = fixture();
    const c = await connect({ folderAllowlist: ["Team A"] });
    const res = await upsert(c, { dashboard: { uid: "dp", title: "x" }, folderUid: "team", overwrite: true });
    expect(isError(res)).toBe(true);
    expect(text(res)).toMatch(/allowlist/);
    expect(posted(g, "/api/dashboards/db")).toHaveLength(0);
  });

  it("refuses when the current folder cannot be looked up (fails closed)", async () => {
    const g = fixture();
    g.failGet.add("/api/dashboards/uid/dt");
    const c = await connect({ protectedFolders: ["Production"] });
    const res = await upsert(c, { dashboard: { uid: "dt", title: "x" }, folderUid: "team", overwrite: true });
    expect(isError(res)).toBe(true);
    expect(text(res)).toMatch(/could not be resolved/);
    expect(posted(g, "/api/dashboards/db")).toHaveLength(0);
  });

  it("allows updating a dashboard in place when both folders pass", async () => {
    const g = fixture();
    const c = await connect({ folderAllowlist: ["Team A"], protectedFolders: ["Production"] });
    const res = await upsert(c, { dashboard: { uid: "dt", title: "x" }, folderUid: "team", overwrite: true });
    expect(isError(res)).toBe(false);
    expect(posted(g, "/api/dashboards/db")).toHaveLength(1);
  });

  it("treats a uid that does not exist yet (404) as a new dashboard", async () => {
    const g = fixture();
    const c = await connect({ folderAllowlist: ["Team A"], protectedFolders: ["Production"] });
    const res = await upsert(c, { dashboard: { uid: "brand-new", title: "x" }, folderUid: "team" });
    expect(isError(res)).toBe(false);
    expect(posted(g, "/api/dashboards/db")).toHaveLength(1);
  });

  it("refuses a model that targets an existing dashboard by numeric id under a different uid", async () => {
    const g = fixture();
    const c = await connect({ protectedFolders: ["Production"] });
    const res = await upsert(c, { dashboard: { uid: "fresh", id: 11, title: "x" }, folderUid: "team", overwrite: true });
    expect(isError(res)).toBe(true);
    expect(posted(g, "/api/dashboards/db")).toHaveLength(0);
  });

  it("refuses a model whose id belongs to a DIFFERENT existing dashboard than its uid", async () => {
    const g = fixture();
    const c = await connect({ protectedFolders: ["Production"] });
    // uid "dt" is an unprotected dashboard; id 11 is the protected dashboard "dp".
    const res = await upsert(c, { dashboard: { uid: "dt", id: 11, title: "x" }, folderUid: "team", overwrite: true });
    expect(isError(res)).toBe(true);
    expect(text(res)).toMatch(/does not match/);
    expect(posted(g, "/api/dashboards/db")).toHaveLength(0);
  });

  it("refuses a model that carries a numeric id but no uid (cannot be scoped)", async () => {
    const g = fixture();
    const c = await connect({ protectedFolders: ["Production"] });
    const res = await upsert(c, { dashboard: { id: 11, title: "x" }, folderUid: "team", overwrite: true });
    expect(isError(res)).toBe(true);
    expect(posted(g, "/api/dashboards/db")).toHaveLength(0);
  });

  it("accepts a model whose id matches its uid (the normal get_dashboard -> edit round trip)", async () => {
    const g = fixture();
    const c = await connect({ protectedFolders: ["Production"] });
    const res = await upsert(c, { dashboard: { uid: "dt", id: 12, title: "x" }, folderUid: "team", overwrite: true });
    expect(isError(res)).toBe(false);
    expect(posted(g, "/api/dashboards/db")).toHaveLength(1);
  });

  it("makes no lookups and changes nothing when no folder rule is configured", async () => {
    const g = fixture();
    const c = await connect();
    const res = await upsert(c, { dashboard: { uid: "dp", title: "x" }, overwrite: true });
    expect(isError(res)).toBe(false);
    expect(g.calls.filter((x) => x.method === "GET")).toHaveLength(0);
    expect(posted(g, "/api/dashboards/db")).toHaveLength(1);
  });

  it("matches the TARGET folder by title too", async () => {
    const g = fixture();
    const c = await connect({ protectedFolders: ["Production"] });
    const res = await upsert(c, { dashboard: { uid: "new1", title: "x" }, folderUid: "prod" });
    expect(isError(res)).toBe(true);
    expect(text(res)).toMatch(/protected/);
    expect(posted(g, "/api/dashboards/db")).toHaveLength(0);
  });
});

describe("gap 2: create_annotation checks the folder of the dashboard it attaches to", () => {
  const fixture = () =>
    new FakeGrafana().addFolder("prod", "Production").addFolder("team", "Team A").addDash("dp", 11, "prod").addDash("dt", 12, "team").install();
  const annotate = (c: Client, args: Record<string, unknown>) => c.callTool({ name: "create_annotation", arguments: { text: "deploy", ...args } });

  it("refuses an annotation on a dashboard in a protected folder", async () => {
    const g = fixture();
    const c = await connect({ protectedFolders: ["Production"] });
    const res = await annotate(c, { dashboardUID: "dp" });
    expect(isError(res)).toBe(true);
    expect(text(res)).toMatch(/protected/);
    expect(posted(g, "/api/annotations")).toHaveLength(0);
  });

  it("refuses an annotation on a dashboard outside the allowlist", async () => {
    const g = fixture();
    const c = await connect({ folderAllowlist: ["Team A"] });
    const res = await annotate(c, { dashboardUID: "dp" });
    expect(isError(res)).toBe(true);
    expect(text(res)).toMatch(/allowlist/);
    expect(posted(g, "/api/annotations")).toHaveLength(0);
  });

  it("allows an annotation on a dashboard in an allowed, unprotected folder", async () => {
    const g = fixture();
    const c = await connect({ folderAllowlist: ["Team A"], protectedFolders: ["Production"] });
    const res = await annotate(c, { dashboardUID: "dt" });
    expect(isError(res)).toBe(false);
    expect(posted(g, "/api/annotations")).toHaveLength(1);
  });

  it("allows an organisation-level annotation (no dashboard) without any lookup", async () => {
    const g = fixture();
    const c = await connect({ folderAllowlist: ["Team A"], protectedFolders: ["Production"] });
    const res = await annotate(c, {});
    expect(isError(res)).toBe(false);
    expect(g.calls.filter((x) => x.method === "GET")).toHaveLength(0);
    expect(posted(g, "/api/annotations")).toHaveLength(1);
  });

  it("refuses when the dashboard's folder cannot be resolved (fails closed)", async () => {
    const g = fixture();
    g.failGet.add("/api/dashboards/uid/dt");
    const c = await connect({ protectedFolders: ["Production"] });
    const res = await annotate(c, { dashboardUID: "dt" });
    expect(isError(res)).toBe(true);
    expect(text(res)).toMatch(/could not be resolved/);
    expect(posted(g, "/api/annotations")).toHaveLength(0);
  });

  it("refuses an annotation on a dashboard that does not exist when rules are configured", async () => {
    const g = fixture();
    const c = await connect({ protectedFolders: ["Production"] });
    const res = await annotate(c, { dashboardUID: "ghost" });
    expect(isError(res)).toBe(true);
    expect(posted(g, "/api/annotations")).toHaveLength(0);
  });

  it("does not look anything up when no folder rule is configured", async () => {
    const g = fixture();
    const c = await connect();
    const res = await annotate(c, { dashboardUID: "dp" });
    expect(isError(res)).toBe(false);
    expect(g.calls.filter((x) => x.method === "GET")).toHaveLength(0);
  });
});

describe("gap 3: the General folder is scoped explicitly", () => {
  const fixture = () => new FakeGrafana().addFolder("team", "Team A").addDash("dg", 20).install();

  it("refuses a write with no folderUid when an allowlist is configured", async () => {
    const g = fixture();
    const c = await connect({ folderAllowlist: ["Team A"] });
    const res = await upsert(c, { dashboard: { uid: "n1", title: "x" } });
    expect(isError(res)).toBe(true);
    expect(text(res)).toMatch(/General.*allowlist/s);
    expect(posted(g, "/api/dashboards/db")).toHaveLength(0);
  });

  it.each(["General", "general"])("allows General when %s is on the allowlist", async (name) => {
    const g = fixture();
    const c = await connect({ folderAllowlist: [name] });
    const res = await upsert(c, { dashboard: { uid: "n1", title: "x" } });
    expect(isError(res)).toBe(false);
    expect(posted(g, "/api/dashboards/db")).toHaveLength(1);
  });

  it("refuses a write to General when General is protected", async () => {
    const g = fixture();
    const c = await connect({ protectedFolders: ["General"] });
    const res = await upsert(c, { dashboard: { uid: "n1", title: "x" } });
    expect(isError(res)).toBe(true);
    expect(text(res)).toMatch(/protected/);
    expect(posted(g, "/api/dashboards/db")).toHaveLength(0);
  });

  it("still allows General when no allowlist or protection mentions it", async () => {
    const g = fixture();
    const c = await connect({ protectedFolders: ["Production"] });
    const res = await upsert(c, { dashboard: { uid: "n1", title: "x" } });
    expect(isError(res)).toBe(false);
    expect(posted(g, "/api/dashboards/db")).toHaveLength(1);
  });

  it("refuses creating a root-level folder under an allowlist that omits General", async () => {
    const g = fixture();
    const c = await connect({ folderAllowlist: ["Team A"] });
    const res = await c.callTool({ name: "create_folder", arguments: { title: "New" } });
    expect(isError(res)).toBe(true);
    expect(posted(g, "/api/folders")).toHaveLength(0);
  });

  it("refuses deleting a dashboard that lives in General under an allowlist that omits General", async () => {
    const g = fixture();
    const c = await connect({ folderAllowlist: ["Team A"] });
    const res = await c.callTool({ name: "delete_dashboard", arguments: { uid: "dg" } });
    expect(isError(res)).toBe(true);
    expect(g.writes().filter((w) => w.method === "DELETE")).toHaveLength(0);
  });
});

describe("gap 4: nested folders", () => {
  // Production > Services > Payments        Team A (root)
  const fixture = () =>
    new FakeGrafana()
      .addFolder("prod", "Production")
      .addFolder("svc", "Services", "prod")
      .addFolder("pay", "Payments", "svc")
      .addFolder("team", "Team A")
      .addDash("dpay", 30, "pay")
      .install();

  it.each([
    ["a child", "svc"],
    ["a grandchild", "pay"],
  ])("a protected parent protects %s: writes into it are refused", async (_n, folderUid) => {
    const g = fixture();
    const c = await connect({ protectedFolders: ["Production"] });
    const res = await upsert(c, { dashboard: { uid: "n1", title: "x" }, folderUid });
    expect(isError(res)).toBe(true);
    expect(text(res)).toMatch(/protected/);
    expect(posted(g, "/api/dashboards/db")).toHaveLength(0);
  });

  it("matches a protected parent by uid as well as title", async () => {
    const g = fixture();
    const c = await connect({ protectedFolders: ["prod"] });
    const res = await upsert(c, { dashboard: { uid: "n1", title: "x" }, folderUid: "pay" });
    expect(isError(res)).toBe(true);
    expect(posted(g, "/api/dashboards/db")).toHaveLength(0);
  });

  it("refuses creating a folder under a sub-folder of a protected parent", async () => {
    const g = fixture();
    const c = await connect({ protectedFolders: ["Production"] });
    const res = await c.callTool({ name: "create_folder", arguments: { title: "New", parentUid: "svc" } });
    expect(isError(res)).toBe(true);
    expect(posted(g, "/api/folders")).toHaveLength(0);
  });

  it("refuses deleting a dashboard that lives in a sub-folder of a protected parent", async () => {
    const g = fixture();
    const c = await connect({ protectedFolders: ["Production"] });
    const res = await c.callTool({ name: "delete_dashboard", arguments: { uid: "dpay" } });
    expect(isError(res)).toBe(true);
    expect(text(res)).toMatch(/protected/);
    expect(g.writes().filter((w) => w.method === "DELETE")).toHaveLength(0);
  });

  it("refuses an annotation on a dashboard in a sub-folder of a protected parent", async () => {
    const g = fixture();
    const c = await connect({ protectedFolders: ["Production"] });
    const res = await c.callTool({ name: "create_annotation", arguments: { text: "x", dashboardUID: "dpay" } });
    expect(isError(res)).toBe(true);
    expect(posted(g, "/api/annotations")).toHaveLength(0);
  });

  it("refuses deleting a sub-folder of a protected parent", async () => {
    const g = fixture();
    lastTyped = "pay";
    const c = await connect({ protectedFolders: ["Production"] });
    const res = await c.callTool({ name: "delete_folder", arguments: { uid: "pay" } });
    expect(isError(res)).toBe(true);
    expect(text(res)).toMatch(/protected/);
    expect(g.writes().filter((w) => w.method === "DELETE")).toHaveLength(0);
  });

  it("refuses deleting a folder that CONTAINS a protected sub-folder", async () => {
    const g = new FakeGrafana().addFolder("root", "Platform").addFolder("mid", "Mid", "root").addFolder("keep", "Production", "mid").install();
    lastTyped = "root";
    const c = await connect({ protectedFolders: ["Production"] });
    const res = await c.callTool({ name: "delete_folder", arguments: { uid: "root" } });
    expect(isError(res)).toBe(true);
    expect(text(res)).toMatch(/protected/);
    expect(g.writes().filter((w) => w.method === "DELETE")).toHaveLength(0);
  });

  it("matches the nested protected sub-folder by uid as well as title", async () => {
    const g = new FakeGrafana().addFolder("root", "Platform").addFolder("keep", "Whatever", "root").install();
    lastTyped = "root";
    const c = await connect({ protectedFolders: ["keep"] });
    const res = await c.callTool({ name: "delete_folder", arguments: { uid: "root" } });
    expect(isError(res)).toBe(true);
    expect(g.writes().filter((w) => w.method === "DELETE")).toHaveLength(0);
  });

  it("deletes a folder whose sub-folders are all unprotected", async () => {
    const g = new FakeGrafana().addFolder("root", "Platform").addFolder("a", "A", "root").addFolder("b", "B", "a").install();
    lastTyped = "root";
    const c = await connect({ protectedFolders: ["Production"] });
    const res = await c.callTool({ name: "delete_folder", arguments: { uid: "root" } });
    expect(isError(res)).toBe(false);
    expect(g.writes().filter((w) => w.method === "DELETE")).toHaveLength(1);
  });

  it("refuses delete_folder when the sub-folder listing fails (fails closed)", async () => {
    const g = new FakeGrafana().addFolder("root", "Platform").addFolder("a", "A", "root").install();
    g.failGet.add("/api/folders?parentUid=root&limit=1000");
    lastTyped = "root";
    const c = await connect({ protectedFolders: ["Production"] });
    const res = await c.callTool({ name: "delete_folder", arguments: { uid: "root" } });
    expect(isError(res)).toBe(true);
    expect(g.writes().filter((w) => w.method === "DELETE")).toHaveLength(0);
  });

  it("refuses delete_folder when a listing is full (it may be truncated, so it cannot be vouched for)", async () => {
    const g = new FakeGrafana().addFolder("root", "Platform");
    for (let i = 0; i < 1000; i++) g.addFolder(`c${i}`, `C${i}`, "root");
    g.install();
    lastTyped = "root";
    const c = await connect({ protectedFolders: ["Production"] });
    const res = await c.callTool({ name: "delete_folder", arguments: { uid: "root" } });
    expect(isError(res)).toBe(true);
    expect(text(res)).toMatch(/too many/);
    expect(g.writes().filter((w) => w.method === "DELETE")).toHaveLength(0);
  });

  it("refuses a write when the parent chain cannot be resolved (fails closed)", async () => {
    const g = fixture();
    g.failGet.add("/api/folders/svc");
    const c = await connect({ protectedFolders: ["Production"] });
    const res = await upsert(c, { dashboard: { uid: "n1", title: "x" }, folderUid: "pay" });
    expect(isError(res)).toBe(true);
    expect(text(res)).toMatch(/could not be resolved/);
    expect(posted(g, "/api/dashboards/db")).toHaveLength(0);
  });

  it("refuses a write when the parent chain loops", async () => {
    const g = new FakeGrafana().addFolder("a", "A", "b").addFolder("b", "B", "a").install();
    const c = await connect({ protectedFolders: ["Production"] });
    const res = await upsert(c, { dashboard: { uid: "n1", title: "x" }, folderUid: "a" });
    expect(isError(res)).toBe(true);
    expect(posted(g, "/api/dashboards/db")).toHaveLength(0);
  });

  it("does not walk parents when no protected folder is configured (allowlist only)", async () => {
    const g = fixture();
    const c = await connect({ folderAllowlist: ["Payments"] });
    const res = await upsert(c, { dashboard: { uid: "n1", title: "x" }, folderUid: "pay" });
    expect(isError(res)).toBe(false);
    expect(g.calls.filter((x) => x.path.startsWith("/api/folders/svc"))).toHaveLength(0);
  });
});
