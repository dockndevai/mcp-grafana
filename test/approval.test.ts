import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { AppConfig } from "../src/config.js";
import { GrafanaClient, GrafanaError } from "../src/grafana/client.js";
import { buildServer } from "../src/server.js";

const config = (requireHumanApproval = false): AppConfig => ({
  connection: { baseUrl: "http://grafana.invalid", token: "t", timeoutMs: 1000 },
  security: {
    mode: "admin",
    folderAllowlist: [],
    protectedFolders: [],
    datasourceAllowlist: [],
    allowDelete: true,
    dryRun: false,
    auditLog: false,
    requireHumanApproval,
  },
});

type Answer = { action: "accept" | "decline"; content?: Record<string, unknown> };

/** Connect an in-memory MCP client (optionally able to answer elicitation) to a freshly built server. */
async function connect(opts: { requireHuman?: boolean; answer?: (message: string) => Answer | Promise<Answer>; elicits?: boolean }) {
  const { server } = buildServer(config(opts.requireHuman));
  const prompts: string[] = [];
  const client = new Client({ name: "t", version: "0" }, { capabilities: opts.elicits === false ? {} : { elicitation: {} } });
  if (opts.elicits !== false) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      prompts.push(req.params.message);
      return (await opts.answer?.(req.params.message)) ?? { action: "accept", content: { confirm: true, typed: "f1" } };
    });
  }
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, prompts };
}

const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");

afterEach(() => vi.restoreAllMocks());

function stubDashboardLookup() {
  vi.spyOn(GrafanaClient.prototype, "getDashboard").mockResolvedValue({ dashboard: { uid: "d1" }, meta: { folderUid: "f9" } });
}

/** Folder / annotation lookups now precede the folder-scope checks; stub them as healthy. */
function stubFolderLookup() {
  vi.spyOn(GrafanaClient.prototype, "getFolder").mockResolvedValue({ uid: "f1", title: "Ops" });
}
function stubAnnotationLookup() {
  vi.spyOn(GrafanaClient.prototype, "getAnnotation").mockResolvedValue({ id: 5, dashboardId: 0, text: "x", time: 1 });
}

describe("delete_dashboard approval (end to end)", () => {
  it("shows the tool, full arguments, version and fingerprint, then deletes", async () => {
    stubDashboardLookup();
    vi.spyOn(GrafanaClient.prototype, "dashboardVersion").mockResolvedValue("uid=d1;id=7;version=3;folder=f9");
    const del = vi.spyOn(GrafanaClient.prototype, "deleteDashboard").mockResolvedValue({ message: "deleted" });
    const { client, prompts } = await connect({});
    const res = await client.callTool({ name: "delete_dashboard", arguments: { uid: "d1" } });
    expect(text(res)).toContain("deleted");
    expect(del).toHaveBeenCalledWith("d1");
    expect(prompts[0]).toContain("tool: delete_dashboard");
    expect(prompts[0]).toContain('{"uid":"d1"}');
    expect(prompts[0]).toContain("resource version: uid=d1;id=7;version=3;folder=f9");
    expect(prompts[0]).toMatch(/fingerprint: [0-9a-f]{16}/);
  });

  it("does NOT delete when the dashboard was saved while the human was deciding", async () => {
    stubDashboardLookup();
    const versions = ["uid=d1;version=3", "uid=d1;version=4"];
    vi.spyOn(GrafanaClient.prototype, "dashboardVersion").mockImplementation(async () => versions.shift());
    const del = vi.spyOn(GrafanaClient.prototype, "deleteDashboard").mockResolvedValue({});
    const { client } = await connect({});
    const res = await client.callTool({ name: "delete_dashboard", arguments: { uid: "d1" } });
    expect(text(res)).toContain("resource changed since the prompt");
    expect(del).not.toHaveBeenCalled();
  });

  it("does NOT delete when the human declines", async () => {
    stubDashboardLookup();
    vi.spyOn(GrafanaClient.prototype, "dashboardVersion").mockResolvedValue("v1");
    const del = vi.spyOn(GrafanaClient.prototype, "deleteDashboard").mockResolvedValue({});
    const { client } = await connect({ answer: () => ({ action: "decline" }) });
    await client.callTool({ name: "delete_dashboard", arguments: { uid: "d1" } });
    expect(del).not.toHaveBeenCalled();
  });
});

describe("delete_folder approval (end to end)", () => {
  it("asks for the typed folder uid and deletes when it matches and the version is stable", async () => {
    stubFolderLookup();
    vi.spyOn(GrafanaClient.prototype, "folderVersion").mockResolvedValue("abc123");
    const del = vi.spyOn(GrafanaClient.prototype, "deleteFolder").mockResolvedValue({ message: "Folder deleted" });
    const { client, prompts } = await connect({});
    const res = await client.callTool({ name: "delete_folder", arguments: { uid: "f1" } });
    expect(text(res)).toContain("Folder deleted");
    expect(del).toHaveBeenCalledWith("f1");
    expect(prompts[0]).toContain("tool: delete_folder");
    expect(prompts[0]).toContain('{"uid":"f1"}');
    expect(prompts[0]).toContain("resource version: abc123");
  });

  it("does NOT delete when the typed confirmation does not match", async () => {
    stubFolderLookup();
    vi.spyOn(GrafanaClient.prototype, "folderVersion").mockResolvedValue("abc123");
    const del = vi.spyOn(GrafanaClient.prototype, "deleteFolder").mockResolvedValue({});
    const { client } = await connect({ answer: () => ({ action: "accept", content: { confirm: true, typed: "wrong" } }) });
    const res = await client.callTool({ name: "delete_folder", arguments: { uid: "f1" } });
    expect(text(res)).toContain("typed confirmation did not match");
    expect(del).not.toHaveBeenCalled();
  });

  it("does NOT delete when the folder was renamed or replaced while the human was deciding", async () => {
    stubFolderLookup();
    const versions = ["h1", "h2"];
    vi.spyOn(GrafanaClient.prototype, "folderVersion").mockImplementation(async () => versions.shift());
    const del = vi.spyOn(GrafanaClient.prototype, "deleteFolder").mockResolvedValue({});
    const { client } = await connect({});
    const res = await client.callTool({ name: "delete_folder", arguments: { uid: "f1" } });
    expect(text(res)).toContain("resource changed since the prompt");
    expect(del).not.toHaveBeenCalled();
  });
});

describe("delete_annotation approval (end to end)", () => {
  it("refuses when the annotation changed while the human was deciding", async () => {
    stubAnnotationLookup();
    const versions = ["a1", "a2"];
    vi.spyOn(GrafanaClient.prototype, "annotationVersion").mockImplementation(async () => versions.shift());
    const del = vi.spyOn(GrafanaClient.prototype, "deleteAnnotation").mockResolvedValue({});
    const { client } = await connect({});
    const res = await client.callTool({ name: "delete_annotation", arguments: { id: 5 } });
    expect(text(res)).toContain("resource changed since the prompt");
    expect(del).not.toHaveBeenCalled();
  });

  it("deletes when the version is stable", async () => {
    stubAnnotationLookup();
    vi.spyOn(GrafanaClient.prototype, "annotationVersion").mockResolvedValue("a1");
    const del = vi.spyOn(GrafanaClient.prototype, "deleteAnnotation").mockResolvedValue({ message: "ok" });
    const { client } = await connect({});
    await client.callTool({ name: "delete_annotation", arguments: { id: 5 } });
    expect(del).toHaveBeenCalledWith(5);
  });
});

describe("GRAFANA_REQUIRE_HUMAN_APPROVAL", () => {
  it("falls back to the flags when the client cannot elicit (default)", async () => {
    stubDashboardLookup();
    vi.spyOn(GrafanaClient.prototype, "dashboardVersion").mockResolvedValue("v1");
    const del = vi.spyOn(GrafanaClient.prototype, "deleteDashboard").mockResolvedValue({});
    const { client } = await connect({ elicits: false });
    await client.callTool({ name: "delete_dashboard", arguments: { uid: "d1" } });
    expect(del).toHaveBeenCalledWith("d1");
  });

  it("refuses to delete when the client cannot elicit and human approval is required", async () => {
    stubFolderLookup();
    stubDashboardLookup();
    vi.spyOn(GrafanaClient.prototype, "dashboardVersion").mockResolvedValue("v1");
    vi.spyOn(GrafanaClient.prototype, "folderVersion").mockResolvedValue("h");
    const delD = vi.spyOn(GrafanaClient.prototype, "deleteDashboard").mockResolvedValue({});
    const delF = vi.spyOn(GrafanaClient.prototype, "deleteFolder").mockResolvedValue({});
    const { client } = await connect({ elicits: false, requireHuman: true });
    const a = await client.callTool({ name: "delete_dashboard", arguments: { uid: "d1" } });
    const b = await client.callTool({ name: "delete_folder", arguments: { uid: "f1" } });
    expect(text(a)).toContain("no human approval channel");
    expect(text(b)).toContain("no human approval channel");
    expect(delD).not.toHaveBeenCalled();
    expect(delF).not.toHaveBeenCalled();
  });
});

describe("version tokens (GrafanaClient)", () => {
  const grafana = () => new GrafanaClient("http://grafana.invalid", "t");

  it("dashboardVersion changes when the dashboard is saved, is undefined when gone, and throws on other errors", async () => {
    const get = vi.spyOn(GrafanaClient.prototype, "getDashboard");
    get.mockResolvedValueOnce({ dashboard: { uid: "d", id: 1, version: 1 }, meta: { folderUid: "f" } });
    get.mockResolvedValueOnce({ dashboard: { uid: "d", id: 1, version: 2 }, meta: { folderUid: "f" } });
    const v1 = await grafana().dashboardVersion("d");
    const v2 = await grafana().dashboardVersion("d");
    expect(v1).toBeDefined();
    expect(v1).not.toBe(v2);
    get.mockRejectedValueOnce(new GrafanaError(404, "not found"));
    expect(await grafana().dashboardVersion("d")).toBeUndefined();
    get.mockRejectedValueOnce(new GrafanaError(500, "boom"));
    await expect(grafana().dashboardVersion("d")).rejects.toThrow("boom");
  });

  it("folderVersion ignores volatile fields but sees a rename or a recreate", async () => {
    const get = vi.spyOn(GrafanaClient.prototype, "getFolder");
    const base = { id: 3, uid: "f", title: "Ops", created: "2026-01-01T00:00:00Z" };
    get.mockResolvedValueOnce({ ...base, version: 1, updated: "a" } as never);
    get.mockResolvedValueOnce({ ...base, version: 9, updated: "b" } as never);
    get.mockResolvedValueOnce({ ...base, title: "Renamed" } as never);
    get.mockResolvedValueOnce({ ...base, id: 4, created: "2026-02-01T00:00:00Z" } as never);
    const a = await grafana().folderVersion("f");
    const volatileOnly = await grafana().folderVersion("f");
    const renamed = await grafana().folderVersion("f");
    const recreated = await grafana().folderVersion("f");
    expect(a).toBe(volatileOnly);
    expect(a).not.toBe(renamed);
    expect(a).not.toBe(recreated);
  });
});
