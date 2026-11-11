import { z } from "zod";
import type { ToolDef } from "./types.js";
import { jsonResult, textResult } from "./types.js";
import type { GuardContext } from "../security.js";
import { assertNoProtectedDescendants, dashboardFolder, resolveFolder, why, type ResolvedFolder } from "./scope.js";

/**
 * Admin tools. Registered only in `admin` mode, and every one is destructive, so each is
 * additionally gated behind GRAFANA_ALLOW_DELETE=true. Deleting a dashboard/folder is not
 * version-recoverable through the API, so protected folders block it.
 */
export const adminTools: ToolDef[] = [
  {
    name: "delete_dashboard",
    capability: "admin",
    destructive: true,
    config: {
      title: "Delete a dashboard",
      description:
        "Permanently delete a dashboard by UID. Refused for dashboards in a protected folder. Requires " +
        "admin mode and GRAFANA_ALLOW_DELETE=true.",
      inputSchema: { uid: z.string().min(1).describe("Dashboard UID.") },
    },
    handler: async (args, { client, policy, confirm }) => {
      const uid = args.uid as string;
      const base: GuardContext = { tool: "delete_dashboard", capability: "admin", destructive: true };
      // Resolve the dashboard's folder so protected-folder enforcement applies to deletes too (fails closed).
      const scope = await dashboardFolder(client, policy, base, uid);
      const { dryRun } = policy.guard({ ...base, folder: scope.folder, ancestors: scope.ancestors });
      if (dryRun) return textResult(`[dry-run] Would delete dashboard ${uid}.`);
      const ok = await confirm.confirm({
        action: "delete dashboard",
        target: uid,
        details: { folder: scope.label },
        probe: () => client.dashboardVersion(uid),
      });
      if (!ok.approved) return textResult(`Deletion cancelled — ${ok.reason}.`);
      return jsonResult(await client.deleteDashboard(uid));
    },
  },
  {
    name: "delete_folder",
    capability: "admin",
    destructive: true,
    config: {
      title: "Delete a folder",
      description:
        "Permanently delete a folder (and the dashboards inside it) by UID. Refused for protected " +
        "folders. Requires admin mode and GRAFANA_ALLOW_DELETE=true.",
      inputSchema: { uid: z.string().min(1).describe("Folder UID.") },
    },
    handler: async (args, { client, policy, confirm }) => {
      const uid = args.uid as string;
      const base: GuardContext = { tool: "delete_folder", capability: "admin", destructive: true };
      // Match the folder by UID *and* title, since GRAFANA_PROTECTED_FOLDERS / the allowlist accept either, and by its
      // ancestors, since a protected parent protects its sub-folders (fails closed).
      const scope = await resolveFolder(client, policy, { ...base, folder: uid }, uid, { always: true });
      const { dryRun } = policy.guard({ ...base, folder: scope.folder, ancestors: scope.ancestors });
      // Deleting a folder deletes the folders inside it, so a protected sub-folder at any depth stops the delete.
      await assertNoProtectedDescendants(client, policy, { ...base, folder: scope.folder }, uid);
      if (dryRun) return textResult(`[dry-run] Would delete folder ${uid} and its dashboards.`);
      const ok = await confirm.confirm({
        action: "delete folder (and its dashboards)",
        target: uid,
        typed: true,
        probe: () => client.folderVersion(uid),
      });
      if (!ok.approved) return textResult(`Deletion cancelled — ${ok.reason}.`);
      return jsonResult(await client.deleteFolder(uid));
    },
  },
  {
    name: "delete_annotation",
    capability: "admin",
    destructive: true,
    config: {
      title: "Delete an annotation",
      description: "Delete an annotation by numeric id. Requires admin mode and GRAFANA_ALLOW_DELETE=true.",
      inputSchema: { id: z.number().int().describe("Annotation id (from list_annotations).") },
    },
    handler: async (args, { client, policy, confirm }) => {
      const id = args.id as number;
      const base: GuardContext = { tool: "delete_annotation", capability: "admin", destructive: true };
      // An annotation attached to a dashboard inherits that dashboard's folder scope. Org-wide annotations
      // (no dashboard) have no folder. Anything we cannot resolve is refused (fails closed).
      let scope: ResolvedFolder | undefined;
      let annotation: Record<string, unknown>;
      try {
        annotation = await client.getAnnotation(id);
      } catch (err) {
        return policy.refuse(
          base,
          `Annotation ${id} could not be resolved (${why(err)}), so its dashboard's folder cannot be checked and the ` +
            `delete is refused. Retry once Grafana is reachable.`,
        );
      }
      const dashboardUid = (annotation.dashboardUID as string | undefined) || undefined;
      if (dashboardUid) {
        scope = await dashboardFolder(client, policy, base, dashboardUid);
      } else if (Number(annotation.dashboardId) > 0) {
        policy.refuse(
          base,
          `Annotation ${id} is attached to a dashboard (id ${String(annotation.dashboardId)}) that could not be resolved ` +
            `to a UID, so its folder cannot be checked and the delete is refused.`,
        );
      }
      const { dryRun } = policy.guard({ ...base, folder: scope?.folder, ancestors: scope?.ancestors });
      if (dryRun) return textResult(`[dry-run] Would delete annotation ${id}.`);
      const ok = await confirm.confirm({
        action: "delete annotation",
        target: String(id),
        details: { dashboard: dashboardUid, folder: scope?.label },
        probe: () => client.annotationVersion(id),
      });
      if (!ok.approved) return textResult(`Deletion cancelled — ${ok.reason}.`);
      return jsonResult(await client.deleteAnnotation(id));
    },
  },
];
