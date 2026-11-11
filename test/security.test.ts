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
    requireHumanApproval: false,
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

describe("folder given as several identifiers (uid + title)", () => {
  it("is protected when ANY identifier is protected", () => {
    const p = makePolicy({ mode: "admin", allowDelete: true });
    expect(() =>
      p.guard({ tool: "delete_folder", capability: "admin", destructive: true, folder: ["f1", "production"] }),
    ).toThrow(/protected/);
    expect(() =>
      p.guard({ tool: "delete_folder", capability: "admin", destructive: true, folder: ["production", "f1"] }),
    ).toThrow(/protected/);
  });
  it("is allowed when ANY identifier is allowlisted, denied when none is", () => {
    const p = makePolicy({ mode: "admin", allowDelete: true, folderAllowlist: ["Team A"] });
    expect(() => p.guard({ tool: "delete_folder", capability: "admin", destructive: true, folder: ["fa", "Team A"] })).not.toThrow();
    expect(() => p.guard({ tool: "delete_folder", capability: "admin", destructive: true, folder: ["fb", "Team B"] })).toThrow(/allowlist/);
  });
  it("ignores empty identifiers when others are present", () => {
    const p = makePolicy({ mode: "admin", allowDelete: true, folderAllowlist: ["Team A"] });
    expect(() => p.guard({ tool: "delete_folder", capability: "admin", destructive: true, folder: ["", "Team A"] })).not.toThrow();
  });
});

describe("the General folder is scoped explicitly", () => {
  const w = (folder?: string | string[]) => ({ tool: "create_or_update_dashboard", capability: "write" as const, folder });
  it("treats a blank folder as General: refused when an allowlist omits it", () => {
    const p = makePolicy({ mode: "read-write", folderAllowlist: ["Team A"] });
    expect(() => p.guard(w(""))).toThrow(/General.*allowlist/s);
    expect(() => p.guard(w(["", ""]))).toThrow(/allowlist/);
    expect(() => p.guard(w([]))).toThrow(/allowlist/);
  });
  it("allows General when it is allowlisted as General or general", () => {
    expect(() => makePolicy({ mode: "read-write", folderAllowlist: ["General"] }).guard(w(""))).not.toThrow();
    expect(() => makePolicy({ mode: "read-write", folderAllowlist: ["general"] }).guard(w(""))).not.toThrow();
  });
  it("applies protected-folder rules to General", () => {
    expect(() => makePolicy({ mode: "read-write", protectedFolders: ["General"] }).guard(w(""))).toThrow(/protected/);
    expect(() => makePolicy({ mode: "read-write", protectedFolders: ["general"] }).guard(w(""))).toThrow(/protected/);
  });
  it("does not scope a call that names no folder at all (undefined)", () => {
    const p = makePolicy({ mode: "read-write", folderAllowlist: ["Team A"] });
    expect(() => p.guard(w(undefined))).not.toThrow();
  });
  it("does not scope reads", () => {
    const p = makePolicy({ folderAllowlist: ["Team A"] });
    expect(() => p.guard({ tool: "get_dashboard", capability: "read", folder: "" })).not.toThrow();
  });
});

describe("ancestors and extra folders", () => {
  const w = (extra: object) => ({ tool: "create_or_update_dashboard", capability: "write" as const, ...extra });
  it("a protected ancestor protects the folder", () => {
    const p = makePolicy({ mode: "read-write", protectedFolders: ["Production"] });
    expect(() => p.guard(w({ folder: ["svc", "Services"], ancestors: ["prod", "Production"] }))).toThrow(/inside a protected folder/);
    expect(() => p.guard(w({ folder: ["svc", "Services"], ancestors: ["other"] }))).not.toThrow();
  });
  it("an allowlisted ancestor does NOT allow the folder", () => {
    const p = makePolicy({ mode: "read-write", folderAllowlist: ["Team A"], protectedFolders: [] });
    expect(() => p.guard(w({ folder: ["sub", "Sub"], ancestors: ["Team A"] }))).toThrow(/allowlist/);
  });
  it("checks every folder in otherFolders", () => {
    const p = makePolicy({ mode: "read-write", protectedFolders: ["Production"] });
    expect(() => p.guard(w({ folder: "ok", otherFolders: [{ folder: ["prod", "Production"] }] }))).toThrow(/protected/);
    expect(() => p.guard(w({ folder: "ok", otherFolders: [{ folder: "ok2" }] }))).not.toThrow();
  });
  it("reports whether folder rules are configured", () => {
    expect(makePolicy({ protectedFolders: [] }).hasFolderRules).toBe(false);
    expect(makePolicy({ protectedFolders: [], folderAllowlist: ["a"] }).hasFolderRules).toBe(true);
    expect(makePolicy({ protectedFolders: ["p"] }).hasProtectedFolders).toBe(true);
  });
});

describe("refuse (fail-closed scope resolution)", () => {
  it("throws a PolicyError carrying the reason", () => {
    const p = makePolicy({ mode: "admin", allowDelete: true });
    expect(() => p.refuse({ tool: "delete_dashboard", capability: "admin", destructive: true }, "cannot resolve")).toThrow(PolicyError);
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
