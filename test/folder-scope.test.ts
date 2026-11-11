import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { AppConfig } from "../src/config.js";
import { GrafanaClient, GrafanaError } from "../src/grafana/client.js";
import { buildServer } from "../src/server.js";
import type { SecurityConfig } from "../src/security.js";

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

/** An approving human, so any refusal in these tests comes from folder scoping, not from the prompt. */
async function connect(security: Partial<SecurityConfig> = {}) {
  const { server } = buildServer(config(security));
  const client = new Client({ name: "t", version: "0" }, { capabilities: { elicitation: {} } });
  client.setRequestHandler(ElicitRequestSchema, async () => ({ action: "accept", content: { confirm: true, typed: "f1" } }));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");
const isError = (r: unknown) => (r as { isError?: boolean }).isError === true;

afterEach(() => vi.restoreAllMocks());

const dash = (folderUid: string | undefined, folderTitle?: string) => ({
  dashboard: { uid: "d1" },
  meta: { ...(folderUid !== undefined ? { folderUid } : {}), ...(folderTitle ? { folderTitle } : {}) },
});

function spies() {
  vi.spyOn(GrafanaClient.prototype, "dashboardVersion").mockResolvedValue("v1");
  vi.spyOn(GrafanaClient.prototype, "folderVersion").mockResolvedValue("v1");
  vi.spyOn(GrafanaClient.prototype, "annotationVersion").mockResolvedValue("v1");
  return {
    delDash: vi.spyOn(GrafanaClient.prototype, "deleteDashboard").mockResolvedValue({ message: "deleted" }),
    delFolder: vi.spyOn(GrafanaClient.prototype, "deleteFolder").mockResolvedValue({ message: "deleted" }),
    delAnno: vi.spyOn(GrafanaClient.prototype, "deleteAnnotation").mockResolvedValue({ message: "deleted" }),
    getDash: vi.spyOn(GrafanaClient.prototype, "getDashboard"),
    // Default: a root folder with no parent (ancestors are walked when protected folders are configured).
    getFolder: vi.spyOn(GrafanaClient.prototype, "getFolder").mockImplementation(async (uid: string) => ({ uid, title: uid })),
    listSubfolders: vi.spyOn(GrafanaClient.prototype, "listSubfolders").mockResolvedValue([]),
    getAnno: vi.spyOn(GrafanaClient.prototype, "getAnnotation"),
  };
}

describe("delete_dashboard fails closed when the folder cannot be resolved", () => {
  it.each([
    ["a Grafana 500", new GrafanaError(500, "boom")],
    ["a network error", new GrafanaError(0, "fetch failed")],
    ["a 403", new GrafanaError(403, "forbidden")],
  ])("refuses on %s, with no protection configured", async (_n, err) => {
    const s = spies();
    s.getDash.mockRejectedValue(err);
    const client = await connect();
    const res = await client.callTool({ name: "delete_dashboard", arguments: { uid: "d1" } });
    expect(isError(res)).toBe(true);
    expect(text(res)).toMatch(/Policy denied.*could not be resolved/s);
    expect(s.delDash).not.toHaveBeenCalled();
  });

  it("refuses when the folder lookup fails and a protected folder is configured", async () => {
    const s = spies();
    s.getDash.mockRejectedValue(new GrafanaError(500, "boom"));
    const client = await connect({ protectedFolders: ["Production"] });
    const res = await client.callTool({ name: "delete_dashboard", arguments: { uid: "d1" } });
    expect(isError(res)).toBe(true);
    expect(s.delDash).not.toHaveBeenCalled();
  });

  it("still deletes when the folder resolves and nothing protects it", async () => {
    const s = spies();
    s.getDash.mockResolvedValue(dash("f9", "Team A"));
    const client = await connect();
    await client.callTool({ name: "delete_dashboard", arguments: { uid: "d1" } });
    expect(s.delDash).toHaveBeenCalledWith("d1");
  });
});

describe("delete_dashboard matches a folder by uid OR title", () => {
  it("refuses a dashboard whose folder TITLE is protected", async () => {
    const s = spies();
    s.getDash.mockResolvedValue(dash("f9", "Production"));
    const client = await connect({ protectedFolders: ["Production"] });
    const res = await client.callTool({ name: "delete_dashboard", arguments: { uid: "d1" } });
    expect(text(res)).toContain("protected");
    expect(s.delDash).not.toHaveBeenCalled();
  });

  it("refuses a dashboard whose folder UID is protected", async () => {
    const s = spies();
    s.getDash.mockResolvedValue(dash("f9", "Production"));
    const client = await connect({ protectedFolders: ["f9"] });
    const res = await client.callTool({ name: "delete_dashboard", arguments: { uid: "d1" } });
    expect(text(res)).toContain("protected");
    expect(s.delDash).not.toHaveBeenCalled();
  });

  it("allows a dashboard whose folder title is on the allowlist", async () => {
    const s = spies();
    s.getDash.mockResolvedValue(dash("f9", "Team A"));
    const client = await connect({ folderAllowlist: ["Team A"] });
    await client.callTool({ name: "delete_dashboard", arguments: { uid: "d1" } });
    expect(s.delDash).toHaveBeenCalledWith("d1");
  });

  it("refuses a dashboard whose folder is not on the allowlist", async () => {
    const s = spies();
    s.getDash.mockResolvedValue(dash("f9", "Team B"));
    const client = await connect({ folderAllowlist: ["Team A"] });
    const res = await client.callTool({ name: "delete_dashboard", arguments: { uid: "d1" } });
    expect(text(res)).toContain("allowlist");
    expect(s.delDash).not.toHaveBeenCalled();
  });
});

describe("delete_folder matches the folder by uid OR title", () => {
  const folder = { uid: "f1", title: "Production" };

  it("refuses when the folder TITLE is protected", async () => {
    const s = spies();
    s.getFolder.mockResolvedValue(folder);
    const client = await connect({ protectedFolders: ["Production"] });
    const res = await client.callTool({ name: "delete_folder", arguments: { uid: "f1" } });
    expect(text(res)).toContain("protected");
    expect(s.delFolder).not.toHaveBeenCalled();
  });

  it("refuses when the folder UID is protected", async () => {
    const s = spies();
    s.getFolder.mockResolvedValue(folder);
    const client = await connect({ protectedFolders: ["f1"] });
    const res = await client.callTool({ name: "delete_folder", arguments: { uid: "f1" } });
    expect(text(res)).toContain("protected");
    expect(s.delFolder).not.toHaveBeenCalled();
  });

  it("allows a folder whose title is on the allowlist", async () => {
    const s = spies();
    s.getFolder.mockResolvedValue(folder);
    const client = await connect({ folderAllowlist: ["Production"] });
    await client.callTool({ name: "delete_folder", arguments: { uid: "f1" } });
    expect(s.delFolder).toHaveBeenCalledWith("f1");
  });

  it("refuses (fails closed) when the folder cannot be looked up", async () => {
    const s = spies();
    s.getFolder.mockRejectedValue(new GrafanaError(500, "boom"));
    const client = await connect();
    const res = await client.callTool({ name: "delete_folder", arguments: { uid: "f1" } });
    expect(isError(res)).toBe(true);
    expect(text(res)).toMatch(/Policy denied.*could not be resolved/s);
    expect(s.delFolder).not.toHaveBeenCalled();
  });
});

describe("delete_annotation is folder-scoped via the annotation's dashboard", () => {
  const onDash = { id: 5, dashboardUID: "d1", dashboardId: 7, panelId: 2, text: "x", time: 1 };

  it("refuses an annotation on a dashboard in a protected folder (by title)", async () => {
    const s = spies();
    s.getAnno.mockResolvedValue(onDash);
    s.getDash.mockResolvedValue(dash("f9", "Production"));
    const client = await connect({ protectedFolders: ["Production"] });
    const res = await client.callTool({ name: "delete_annotation", arguments: { id: 5 } });
    expect(text(res)).toContain("protected");
    expect(s.delAnno).not.toHaveBeenCalled();
  });

  it("refuses an annotation on a dashboard in a protected folder (by uid)", async () => {
    const s = spies();
    s.getAnno.mockResolvedValue(onDash);
    s.getDash.mockResolvedValue(dash("f9", "Production"));
    const client = await connect({ protectedFolders: ["f9"] });
    const res = await client.callTool({ name: "delete_annotation", arguments: { id: 5 } });
    expect(text(res)).toContain("protected");
    expect(s.delAnno).not.toHaveBeenCalled();
  });

  it("refuses an annotation whose dashboard is outside the folder allowlist", async () => {
    const s = spies();
    s.getAnno.mockResolvedValue(onDash);
    s.getDash.mockResolvedValue(dash("f9", "Team B"));
    const client = await connect({ folderAllowlist: ["Team A"] });
    const res = await client.callTool({ name: "delete_annotation", arguments: { id: 5 } });
    expect(text(res)).toContain("allowlist");
    expect(s.delAnno).not.toHaveBeenCalled();
  });

  it("deletes an annotation on a dashboard in an allowed, unprotected folder", async () => {
    const s = spies();
    s.getAnno.mockResolvedValue(onDash);
    s.getDash.mockResolvedValue(dash("f9", "Team A"));
    const client = await connect({ folderAllowlist: ["Team A"], protectedFolders: ["Production"] });
    await client.callTool({ name: "delete_annotation", arguments: { id: 5 } });
    expect(s.delAnno).toHaveBeenCalledWith(5);
  });

  it("deletes an organisation-wide annotation (no dashboard) without any folder lookup", async () => {
    const s = spies();
    s.getAnno.mockResolvedValue({ id: 5, dashboardId: 0, text: "deploy", time: 1 });
    const client = await connect({ protectedFolders: ["Production"] });
    await client.callTool({ name: "delete_annotation", arguments: { id: 5 } });
    expect(s.delAnno).toHaveBeenCalledWith(5);
    expect(s.getDash).not.toHaveBeenCalled();
  });

  it("refuses (fails closed) when the annotation cannot be fetched", async () => {
    const s = spies();
    s.getAnno.mockRejectedValue(new GrafanaError(500, "boom"));
    const client = await connect();
    const res = await client.callTool({ name: "delete_annotation", arguments: { id: 5 } });
    expect(isError(res)).toBe(true);
    expect(text(res)).toMatch(/Policy denied.*could not be resolved/s);
    expect(s.delAnno).not.toHaveBeenCalled();
  });

  it("refuses (fails closed) when its dashboard's folder cannot be resolved", async () => {
    const s = spies();
    s.getAnno.mockResolvedValue(onDash);
    s.getDash.mockRejectedValue(new GrafanaError(500, "boom"));
    const client = await connect();
    const res = await client.callTool({ name: "delete_annotation", arguments: { id: 5 } });
    expect(isError(res)).toBe(true);
    expect(s.delAnno).not.toHaveBeenCalled();
  });

  it("refuses (fails closed) when it is tied to a dashboard by numeric id only", async () => {
    const s = spies();
    s.getAnno.mockResolvedValue({ id: 5, dashboardId: 7, text: "x", time: 1 });
    const client = await connect();
    const res = await client.callTool({ name: "delete_annotation", arguments: { id: 5 } });
    expect(isError(res)).toBe(true);
    expect(text(res)).toMatch(/could not be resolved/);
    expect(s.delAnno).not.toHaveBeenCalled();
  });
});
