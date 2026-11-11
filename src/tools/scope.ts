import type { GrafanaClient } from "../grafana/client.js";
import { GrafanaError } from "../grafana/client.js";
import { GENERAL_FOLDER, type FolderRef, type GuardContext, type SecurityPolicy } from "../security.js";

/**
 * Folder-scope resolution shared by the write and admin tools. Every lookup FAILS CLOSED: if a folder (or one
 * of its ancestors / sub-folders) cannot be resolved, the operation is refused instead of skipping the checks.
 */

/** A folder resolved to every identifier it is known by, plus its ancestors' identifiers (nearest first). */
export interface ResolvedFolder extends FolderRef {
  folder: string[];
  ancestors: string[];
  /** Human-readable name for prompts and messages. */
  label: string;
}

/** Deepest folder nesting we will walk. Grafana's own limit is far lower; this also bounds a parent loop. */
const MAX_DEPTH = 32;
/** Most folders we will visit when checking a folder's descendants. */
const MAX_DESCENDANTS = 1000;
const PAGE = 1000;

export function why(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const GENERAL: ResolvedFolder = { folder: [...GENERAL_FOLDER], ancestors: [], label: "General" };

/**
 * Resolve a folder by UID (blank/undefined = the General folder, which has no parents).
 *
 * - `title` is a title already known (e.g. from a dashboard's meta); it saves a lookup when only the allowlist
 *   applies.
 * - A lookup is made only when needed: the folder's title (when a rule is configured and the title is unknown)
 *   and its ancestors (when protected folders are configured). `always` forces the lookup even with no rules,
 *   for operations that must resolve their target regardless (deletes).
 */
export async function resolveFolder(
  client: GrafanaClient,
  policy: SecurityPolicy,
  ctx: GuardContext,
  folderUid: string | undefined,
  opts: { title?: string; always?: boolean } = {},
): Promise<ResolvedFolder> {
  if (!folderUid) return GENERAL;
  const folder = [folderUid, ...(opts.title ? [opts.title] : [])];
  const needAncestors = policy.hasProtectedFolders;
  const needTitle = !opts.title && policy.hasFolderRules;
  if (!opts.always && !needAncestors && !needTitle) return { folder, ancestors: [], label: opts.title || folderUid };

  const ancestors: string[] = [];
  const seen = new Set<string>();
  let cur: string | undefined = folderUid;
  try {
    for (let depth = 0; cur; depth++) {
      if (depth >= MAX_DEPTH || seen.has(cur)) throw new Error(`folder nesting is too deep or loops at '${cur}'`);
      seen.add(cur);
      const f = await client.getFolder(cur);
      if (depth === 0) {
        if (f.title && !folder.includes(f.title)) folder.push(f.title);
        if (!needAncestors) break;
      } else {
        ancestors.push(cur);
        if (f.title) ancestors.push(f.title);
      }
      cur = f.parentUid || undefined;
    }
  } catch (err) {
    return policy.refuse(
      ctx,
      `Folder '${cur ?? folderUid}' (or one of its parent folders) could not be resolved (${why(err)}), so the ` +
        `operation is refused rather than skipping the protected-folder and allowlist checks. Retry once Grafana is reachable.`,
    );
  }
  return { folder, ancestors, label: opts.title || folderUid };
}

/**
 * Resolve the folder a dashboard currently lives in. Fails closed. A dashboard with no folder is in General.
 */
export async function dashboardFolder(
  client: GrafanaClient,
  policy: SecurityPolicy,
  ctx: GuardContext,
  uid: string,
): Promise<ResolvedFolder> {
  let meta: Record<string, unknown> | undefined;
  try {
    meta = (await client.getDashboard(uid)).meta;
  } catch (err) {
    return policy.refuse(
      ctx,
      `The folder of dashboard '${uid}' could not be resolved (${why(err)}), so the operation is refused rather than ` +
        `skipping the protected-folder and allowlist checks. Retry once Grafana is reachable.`,
    );
  }
  return resolveFolder(client, policy, ctx, (meta?.folderUid as string | undefined) || undefined, {
    title: (meta?.folderTitle as string | undefined) || undefined,
  });
}

/**
 * For an upsert: the folder an EXISTING dashboard (matched by the model's uid) currently sits in, or undefined
 * for a brand-new one. Fails closed on any lookup error other than "not found".
 *
 * A model that names a dashboard only by numeric `id` (no uid), or whose `id` does not belong to its `uid`, is
 * refused: Grafana honours `id` when saving, so it could otherwise overwrite a dashboard other than the one that
 * was checked. The normal round trip (get_dashboard, edit, save) keeps uid and id together and passes.
 */
export async function existingDashboardFolder(
  client: GrafanaClient,
  policy: SecurityPolicy,
  ctx: GuardContext,
  model: Record<string, unknown>,
): Promise<ResolvedFolder | undefined> {
  const uid = typeof model.uid === "string" && model.uid !== "" ? model.uid : undefined;
  const id = model.id;
  const hasId = id !== undefined && id !== null && id !== 0 && id !== "";
  if (!uid) {
    if (hasId) {
      policy.refuse(
        ctx,
        `The dashboard model carries a numeric id (${String(id)}) but no uid, so the dashboard it would overwrite ` +
          `cannot be checked against the folder rules. Include the dashboard's uid, or omit the id to create a new one.`,
      );
    }
    return undefined;
  }
  let existing: { dashboard: Record<string, unknown>; meta: Record<string, unknown> } | undefined;
  try {
    existing = await client.getDashboard(uid);
  } catch (err) {
    if (err instanceof GrafanaError && err.status === 404) existing = undefined;
    else {
      return policy.refuse(
        ctx,
        `The current folder of dashboard '${uid}' could not be resolved (${why(err)}), so the save is refused rather ` +
          `than skipping the protected-folder and allowlist checks. Retry once Grafana is reachable.`,
      );
    }
  }
  if (!existing) {
    if (hasId) {
      policy.refuse(
        ctx,
        `The dashboard model carries a numeric id (${String(id)}) that does not belong to the new uid '${uid}', so the ` +
          `dashboard it would overwrite cannot be checked. Omit the id to create a new dashboard.`,
      );
    }
    return undefined;
  }
  if (hasId && Number(existing.dashboard.id) !== Number(id)) {
    policy.refuse(
      ctx,
      `The dashboard model's id (${String(id)}) does not match dashboard '${uid}' (id ${String(existing.dashboard.id)}), ` +
        `so the dashboard it would overwrite cannot be checked.`,
    );
  }
  return resolveFolder(client, policy, ctx, (existing.meta?.folderUid as string | undefined) || undefined, {
    title: (existing.meta?.folderTitle as string | undefined) || undefined,
  });
}

/**
 * Refuse if any folder nested under `uid` (at any depth) is protected: deleting a folder deletes everything in
 * it, so a protected sub-folder must stop the delete. Only runs when protected folders are configured. Fails
 * closed on a lookup error, an over-long listing, or an over-large tree.
 */
export async function assertNoProtectedDescendants(
  client: GrafanaClient,
  policy: SecurityPolicy,
  ctx: GuardContext,
  uid: string,
): Promise<void> {
  if (!policy.hasProtectedFolders) return;
  const queue: Array<{ uid: string; depth: number }> = [{ uid, depth: 0 }];
  const seen = new Set<string>([uid]);
  while (queue.length > 0) {
    const { uid: parent, depth } = queue.shift()!;
    let children;
    try {
      children = await client.listSubfolders(parent, PAGE);
    } catch (err) {
      return policy.refuse(
        ctx,
        `The sub-folders of '${parent}' could not be listed (${why(err)}), so the delete is refused rather than ` +
          `skipping the protected-folder check on nested folders. Retry once Grafana is reachable.`,
      );
    }
    if (children.length >= PAGE) {
      policy.refuse(ctx, `Folder '${parent}' has ${PAGE} or more sub-folders, too many to check against the protected folders; delete is refused.`);
    }
    for (const child of children) {
      if (seen.has(child.uid)) continue;
      seen.add(child.uid);
      if (policy.isFolderProtected([child.uid, child.title])) {
        policy.refuse(
          ctx,
          `Folder '${uid}' contains the protected folder '${child.title}' (${child.uid}); deleting it would delete the ` +
            `protected folder too (GRAFANA_PROTECTED_FOLDERS).`,
        );
      }
      if (depth + 1 >= MAX_DEPTH || seen.size > MAX_DESCENDANTS) {
        policy.refuse(ctx, `Folder '${uid}' has too many nested folders to check against the protected folders; delete is refused.`);
      }
      queue.push({ uid: child.uid, depth: depth + 1 });
    }
  }
}
