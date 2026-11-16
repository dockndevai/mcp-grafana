import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AppConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { redactContactPoint } from "../src/grafana/client.js";
import type { SecurityConfig } from "../src/security.js";

/**
 * get_alert_rule, list_contact_points, list_notification_policies: read-only alerting tools over the
 * provisioning API. The main risk is a contact point's secure settings (webhook URLs, tokens,
 * passwords, …) leaking to the model, so these tests focus on that redaction plus basic wiring.
 */

const config = (security: Partial<SecurityConfig> = {}): AppConfig => ({
  connection: { baseUrl: "http://grafana.invalid", token: "t", timeoutMs: 1000 },
  security: {
    mode: "read-only",
    folderAllowlist: [],
    protectedFolders: [],
    datasourceAllowlist: [],
    allowDelete: false,
    dryRun: false,
    auditLog: false,
    requireHumanApproval: false,
    ...security,
  },
});

async function connect(security: Partial<SecurityConfig> = {}) {
  const { server } = buildServer(config(security));
  const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");
const isError = (r: unknown) => (r as { isError?: boolean }).isError === true;

afterEach(() => vi.unstubAllGlobals());

describe("redactContactPoint", () => {
  it("replaces settings keys that look secret, and leaves the rest alone", () => {
    const cp = redactContactPoint({
      uid: "cp1",
      name: "on-call-slack",
      type: "slack",
      settings: {
        url: "https://hooks.slack.com/services/T000/B000/xxxxxxxxxxxxxxxxxxxxxxxx",
        token: "xoxb-super-secret",
        password: "p",
        apiKey: "k",
        title: "{{ .CommonLabels.alertname }}",
        severity: "critical",
      },
    });
    expect(cp.settings.url).toBe("[redacted]");
    expect(cp.settings.token).toBe("[redacted]");
    expect(cp.settings.password).toBe("[redacted]");
    expect(cp.settings.apiKey).toBe("[redacted]");
    expect(cp.settings.title).toBe("{{ .CommonLabels.alertname }}");
    expect(cp.settings.severity).toBe("critical");
  });

  it("is case-insensitive and matches embedded keys (webhookUrl, integrationKey, …)", () => {
    const cp = redactContactPoint({
      name: "pagerduty",
      type: "pagerduty",
      settings: { integrationKey: "secret", WebhookURL: "https://example.invalid/hook", description: "ok" },
    });
    expect(cp.settings.integrationKey).toBe("[redacted]");
    expect(cp.settings.WebhookURL).toBe("[redacted]");
    expect(cp.settings.description).toBe("ok");
  });

  it("tolerates missing settings", () => {
    expect(redactContactPoint({ name: "x", type: "email" }).settings).toEqual({});
  });
});

function installFakeGrafana() {
  const calls: Array<{ method: string; path: string }> = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const path = u.pathname;
    const method = (init.method ?? "GET").toUpperCase();
    calls.push({ method, path });
    const json = (status: number, v: unknown) =>
      new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (path === "/api/v1/provisioning/alert-rules/missing") return json(404, { message: "not found" });
    if (path === "/api/v1/provisioning/alert-rules/r1") {
      return json(200, { uid: "r1", title: "High error rate", condition: "B", for: "5m", noDataState: "NoData" });
    }
    if (path === "/api/v1/provisioning/contact-points") {
      return json(200, [{ uid: "cp1", name: "oncall", type: "webhook", settings: { url: "https://secret.invalid", httpMethod: "POST" } }]);
    }
    if (path === "/api/v1/provisioning/policies") {
      return json(200, { receiver: "oncall", routes: [{ receiver: "team-a", matchers: ["team=a"] }] });
    }
    return json(404, { message: `unhandled ${method} ${path}` });
  });
  return calls;
}

describe("get_alert_rule", () => {
  it("returns a single alert rule's full detail by uid", async () => {
    installFakeGrafana();
    const c = await connect();
    const res = await c.callTool({ name: "get_alert_rule", arguments: { uid: "r1" } });
    expect(isError(res)).toBe(false);
    expect(JSON.parse(text(res))).toMatchObject({ uid: "r1", title: "High error rate" });
  });

  it("surfaces a 404 for an unknown uid as a tool error, not a crash", async () => {
    installFakeGrafana();
    const c = await connect();
    const res = await c.callTool({ name: "get_alert_rule", arguments: { uid: "missing" } });
    expect(isError(res)).toBe(true);
  });
});

describe("list_contact_points", () => {
  it("never returns the raw webhook URL (or any other secret-looking setting)", async () => {
    installFakeGrafana();
    const c = await connect();
    const res = await c.callTool({ name: "list_contact_points", arguments: {} });
    expect(isError(res)).toBe(false);
    const body = text(res);
    expect(body).not.toContain("secret.invalid");
    const parsed = JSON.parse(body) as Array<{ settings: Record<string, unknown> }>;
    expect(parsed[0]!.settings.url).toBe("[redacted]");
    expect(parsed[0]!.settings.httpMethod).toBe("POST");
  });

  it("is available in read-only mode", async () => {
    installFakeGrafana();
    const c = await connect({ mode: "read-only" });
    const res = await c.callTool({ name: "list_contact_points", arguments: {} });
    expect(isError(res)).toBe(false);
  });
});

describe("list_notification_policies", () => {
  it("returns the routing tree", async () => {
    installFakeGrafana();
    const c = await connect();
    const res = await c.callTool({ name: "list_notification_policies", arguments: {} });
    expect(isError(res)).toBe(false);
    expect(JSON.parse(text(res))).toMatchObject({ receiver: "oncall" });
  });
});
