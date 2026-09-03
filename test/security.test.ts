import { describe, expect, it } from "vitest";
import { PolicyError, SecurityPolicy, type SecurityConfig } from "../src/security.js";

function makePolicy(overrides: Partial<SecurityConfig> = {}): SecurityPolicy {
  return new SecurityPolicy({
    mode: "read-only",
    folderAllowlist: [],
    protectedFolders: ["production"],
    datasourceAllowlist: [],
    allowDelete: false,
    dryRun: false,
    auditLog: false,
    ...overrides,
  });
}

describe("capability gating", () => {
  it("read-only enables read only", () => {
    const p = makePolicy();
    expect(p.isCapabilityEnabled("read")).toBe(true);
    expect(p.isCapabilityEnabled("write")).toBe(false);
    expect(p.isCapabilityEnabled("admin")).toBe(false);
  });
  it("read-write enables read and write but not admin", () => {
    const p = makePolicy({ mode: "read-write" });
    expect(p.isCapabilityEnabled("write")).toBe(true);
    expect(p.isCapabilityEnabled("admin")).toBe(false);
  });
});

describe("mode vs capability at guard time", () => {
  it("rejects a write in read-only mode", () => {
    const p = makePolicy();
    expect(() => p.guard({ tool: "create_or_update_dashboard", capability: "write" })).toThrow(PolicyError);
  });
  it("rejects admin in read-write mode", () => {
    const p = makePolicy({ mode: "read-write" });
    expect(() => p.guard({ tool: "delete_dashboard", capability: "admin", destructive: true })).toThrow(/admin/);
  });
});

describe("folder allowlist + protection", () => {
  it("blocks writes to folders outside a non-empty allowlist", () => {
    const p = makePolicy({ mode: "read-write", folderAllowlist: ["team-a"] });
    expect(() =>
      p.guard({ tool: "create_or_update_dashboard", capability: "write", folder: "secret" }),
    ).toThrow(/allowlist/);
  });
  it("allows reading a protected folder but not writing to it", () => {
    const p = makePolicy({ mode: "read-write" });
    expect(() => p.guard({ tool: "get_dashboard", capability: "read", folder: "production" })).not.toThrow();
    expect(() =>
      p.guard({ tool: "create_or_update_dashboard", capability: "write", folder: "production" }),
    ).toThrow(/protected/);
  });
});

describe("datasource allowlist", () => {
  it("blocks queries to datasources outside a non-empty allowlist", () => {
    const p = makePolicy({ datasourceAllowlist: ["prod-prom"] });
    expect(() => p.guard({ tool: "query_datasource", capability: "read", datasource: "other" })).toThrow(/allowlist/);
  });
  it("permits queries to allowlisted datasources", () => {
    const p = makePolicy({ datasourceAllowlist: ["prod-prom"] });
    expect(() => p.guard({ tool: "query_datasource", capability: "read", datasource: "prod-prom" })).not.toThrow();
  });
});

describe("delete gating", () => {
  it("blocks delete without allowDelete even in admin mode", () => {
    const p = makePolicy({ mode: "admin" });
    expect(() => p.guard({ tool: "delete_dashboard", capability: "admin", destructive: true })).toThrow(/ALLOW_DELETE/);
  });
  it("permits delete with allowDelete", () => {
    const p = makePolicy({ mode: "admin", allowDelete: true });
    expect(() => p.guard({ tool: "delete_dashboard", capability: "admin", destructive: true })).not.toThrow();
  });
  it("still blocks deleting from a protected folder", () => {
    const p = makePolicy({ mode: "admin", allowDelete: true });
    expect(() =>
      p.guard({ tool: "delete_dashboard", capability: "admin", destructive: true, folder: "production" }),
    ).toThrow(/protected/);
  });
});

describe("dry run", () => {
  it("flags writes but not reads", () => {
    const p = makePolicy({ mode: "read-write", dryRun: true });
    expect(p.guard({ tool: "get_dashboard", capability: "read" }).dryRun).toBe(false);
    expect(p.guard({ tool: "create_or_update_dashboard", capability: "write" }).dryRun).toBe(true);
  });
});
