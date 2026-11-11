/**
 * Security policy engine.
 *
 * Flags decide which tools are registered (capability vs. access mode) and whether each individual
 * call is allowed at runtime (folder scoping, protected folders, datasource allowlist, delete
 * gating, dry-run). Pure logic — fully unit-testable. Defence in depth on top of the Grafana
 * service-account token's own role.
 */

export type Capability = "read" | "write" | "admin";
export type AccessMode = "read-only" | "read-write" | "admin";

const MODE_RANK: Record<AccessMode, number> = { "read-only": 0, "read-write": 1, admin: 2 };
const CAPABILITY_RANK: Record<Capability, number> = { read: 0, write: 1, admin: 2 };

export interface SecurityConfig {
  mode: AccessMode;
  /** If set, only these folders (by UID or title) may be written to / deleted from. Empty = all. */
  folderAllowlist: string[];
  /** Folders that can be read but never written to or deleted (e.g. a "Production" folder). */
  protectedFolders: string[];
  /** If set, only these datasources (by UID or name) may be queried. Empty = all. */
  datasourceAllowlist: string[];
  /** Destructive ops (delete dashboard/folder/annotation) require this to be true. */
  allowDelete: boolean;
  /** Validate + log writes without executing them. */
  dryRun: boolean;
  auditLog: boolean;
  /** Refuse destructive ops that no human can approve (no elicitation support) instead of trusting the flags alone. */
  requireHumanApproval: boolean;
}

export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

/**
 * The identifiers the root ("General") folder is known by. Grafana gives it no UID, so an operator can name it
 * `General` or `general` in GRAFANA_FOLDER_ALLOWLIST / GRAFANA_PROTECTED_FOLDERS.
 */
export const GENERAL_FOLDER: readonly string[] = ["General", "general"];

/** A folder to check: the identifiers it is known by, plus the identifiers of its ancestors (nearest first). */
export interface FolderRef {
  folder: string | string[];
  ancestors?: string[];
}

export interface GuardContext {
  tool: string;
  capability: Capability;
  /**
   * Folder a dashboard/folder call targets. OMIT it only for calls that are not folder-scoped (reads, org-level
   * annotations); an empty/blank folder means the General (root) folder, which is scoped like any other.
   * Pass every identifier the folder is known by (its UID and its title) so the allowlist and protected list
   * match whichever form the operator configured: the folder is protected if ANY identifier is protected, and
   * allowed if ANY identifier is allowlisted.
   */
  folder?: string | string[];
  /**
   * Identifiers of the folder's ancestors (parent, grandparent, ...). A protected ancestor protects the folder.
   * They are not consulted for the allowlist: an allowlisted parent does not allow its sub-folders.
   */
  ancestors?: string[];
  /**
   * Further folders the call also touches, each checked exactly like `folder`. Used when an overwrite touches
   * both the folder a dashboard currently sits in and the folder it is being saved to.
   */
  otherFolders?: FolderRef[];
  /** Datasource a query targets (UID or name), when it names one. */
  datasource?: string;
  destructive?: boolean;
}

/** Normalise a folder reference (one identifier or several) to its non-empty identifiers. */
function folderIds(folder: string | string[] | undefined): string[] {
  return (Array.isArray(folder) ? folder : [folder]).filter((f): f is string => typeof f === "string" && f !== "");
}

export class SecurityPolicy {
  constructor(private readonly config: SecurityConfig) {}

  get mode(): AccessMode {
    return this.config.mode;
  }

  isCapabilityEnabled(capability: Capability): boolean {
    return CAPABILITY_RANK[capability] <= MODE_RANK[this.config.mode];
  }

  /** True if any folder rule is configured, i.e. an operation's folder needs to be resolved at all. */
  get hasFolderRules(): boolean {
    return this.config.folderAllowlist.length > 0 || this.config.protectedFolders.length > 0;
  }
  /** True if protected folders are configured, i.e. a folder's ancestors / sub-folders need to be walked. */
  get hasProtectedFolders(): boolean {
    return this.config.protectedFolders.length > 0;
  }

  isFolderAllowed(folder: string | string[]): boolean {
    if (this.config.folderAllowlist.length === 0) return true;
    return folderIds(folder).some((f) => this.config.folderAllowlist.includes(f));
  }
  isFolderProtected(folder: string | string[]): boolean {
    return folderIds(folder).some((f) => this.config.protectedFolders.includes(f));
  }

  /**
   * Refuse an operation whose scope could not be established (e.g. the target's folder could not be looked
   * up). Scope checks must fail CLOSED: an unresolvable target is denied, never waved through unchecked.
   */
  refuse(ctx: GuardContext, reason: string): never {
    this.audit(ctx, "DENY", reason);
    throw new PolicyError(reason);
  }
  isDatasourceAllowed(ds: string): boolean {
    if (this.config.datasourceAllowlist.length === 0) return true;
    return this.config.datasourceAllowlist.includes(ds);
  }

  guard(ctx: GuardContext): { dryRun: boolean } {
    if (!this.isCapabilityEnabled(ctx.capability)) {
      this.audit(ctx, "DENY", `capability '${ctx.capability}' exceeds mode '${this.config.mode}'`);
      throw new PolicyError(
        `Operation '${ctx.tool}' requires '${ctx.capability}' access but the server runs in '${this.config.mode}' mode. Set GRAFANA_MODE to grant it.`,
      );
    }

    if (ctx.datasource !== undefined && ctx.datasource !== "" && !this.isDatasourceAllowed(ctx.datasource)) {
      this.audit(ctx, "DENY", `datasource '${ctx.datasource}' not in allowlist`);
      throw new PolicyError(
        `Datasource '${ctx.datasource}' is not in the configured allowlist (GRAFANA_DATASOURCE_ALLOWLIST).`,
      );
    }

    if (ctx.capability !== "read") {
      const refs: FolderRef[] = [];
      if (ctx.folder !== undefined) refs.push({ folder: ctx.folder, ancestors: ctx.ancestors });
      refs.push(...(ctx.otherFolders ?? []));
      for (const ref of refs) this.checkFolder(ctx, ref);
    }

    if (ctx.destructive && !this.config.allowDelete) {
      this.audit(ctx, "DENY", "delete not enabled");
      throw new PolicyError(
        `Destructive operation '${ctx.tool}' is disabled. Set GRAFANA_ALLOW_DELETE=true to enable it.`,
      );
    }

    const dryRun = ctx.capability !== "read" && this.config.dryRun;
    this.audit(ctx, dryRun ? "DRY_RUN" : "ALLOW");
    return { dryRun };
  }

  /** Allowlist + protected-folder check for one folder. A blank folder is the General (root) folder. */
  private checkFolder(ctx: GuardContext, ref: FolderRef): void {
    const ids = folderIds(ref.folder);
    const folder = ids.length > 0 ? ids : [...GENERAL_FOLDER];
    const label = ids.length > 0 ? ids.join(" / ") : "General";
    if (!this.isFolderAllowed(folder)) {
      this.audit(ctx, "DENY", `folder '${label}' not in allowlist`);
      throw new PolicyError(`Folder '${label}' is not in the configured allowlist (GRAFANA_FOLDER_ALLOWLIST).`);
    }
    if (this.isFolderProtected(folder)) {
      this.audit(ctx, "DENY", `folder '${label}' is protected`);
      throw new PolicyError(
        `Folder '${label}' is protected (GRAFANA_PROTECTED_FOLDERS); it can be read but not modified.`,
      );
    }
    if (ref.ancestors && this.isFolderProtected(ref.ancestors)) {
      this.audit(ctx, "DENY", `folder '${label}' is inside a protected folder`);
      throw new PolicyError(
        `Folder '${label}' is inside a protected folder (GRAFANA_PROTECTED_FOLDERS protects its sub-folders too); ` +
          `it can be read but not modified.`,
      );
    }
  }

  private audit(ctx: GuardContext, decision: string, reason?: string): void {
    if (!this.config.auditLog) return;
    const line = {
      ts: new Date().toISOString(),
      audit: "grafana-mcp",
      decision,
      tool: ctx.tool,
      capability: ctx.capability,
      folder: ctx.folder === undefined ? null : folderIds(ctx.folder).join(" / ") || "General",
      datasource: ctx.datasource ?? null,
      destructive: ctx.destructive ?? false,
      ...(reason ? { reason } : {}),
    };
    process.stderr.write(`${JSON.stringify(line)}\n`);
  }
}
