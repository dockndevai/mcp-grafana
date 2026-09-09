import { z } from "zod";
import type { ToolDef } from "./types.js";
import { jsonResult, textResult } from "./types.js";

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
      // Resolve the dashboard's folder so protected-folder enforcement applies to deletes too.
      let folder: string | undefined;
      try {
        const d = await client.getDashboard(uid);
        folder = (d.meta?.folderUid as string) || (d.meta?.folderTitle as string) || undefined;
      } catch {
        /* if we can't resolve it, the guard still enforces capability + allowDelete */
      }
      const { dryRun } = policy.guard({ tool: "delete_dashboard", capability: "admin", destructive: true, folder });
      if (dryRun) return textResult(`[dry-run] Would delete dashboard ${uid}.`);
      const ok = await confirm.confirm({ action: "delete dashboard", target: uid, details: { folder } });
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
      const { dryRun } = policy.guard({ tool: "delete_folder", capability: "admin", destructive: true, folder: uid });
      if (dryRun) return textResult(`[dry-run] Would delete folder ${uid} and its dashboards.`);
      const ok = await confirm.confirm({ action: "delete folder (and its dashboards)", target: uid });
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
      const { dryRun } = policy.guard({ tool: "delete_annotation", capability: "admin", destructive: true });
      if (dryRun) return textResult(`[dry-run] Would delete annotation ${id}.`);
      const ok = await confirm.confirm({ action: "delete annotation", target: String(id) });
      if (!ok.approved) return textResult(`Deletion cancelled — ${ok.reason}.`);
      return jsonResult(await client.deleteAnnotation(id));
    },
  },
];
