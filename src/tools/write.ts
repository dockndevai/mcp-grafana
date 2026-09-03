import { z } from "zod";
import type { ToolDef } from "./types.js";
import { jsonResult, textResult } from "./types.js";

/**
 * Write tools. Registered only in `read-write` mode and up. They create or update dashboards,
 * folders and annotations. None permanently destroys data (dashboards are versioned and can be
 * rolled back) — deletes live in admin.ts.
 */
export const writeTools: ToolDef[] = [
  {
    name: "create_or_update_dashboard",
    capability: "write",
    config: {
      title: "Create or update a dashboard",
      description:
        "Create a new dashboard or update an existing one from a dashboard JSON model. Pass the full " +
        "`dashboard` object (get it from get_dashboard to edit, or build one per the standard). To " +
        "create: omit the model's `id`/`version` and give a `uid` + `title`. To update: keep the " +
        "existing `uid` and set overwrite=true. Grafana versions every save, so this is reversible. " +
        "Put it in a folder with `folderUid`.",
      inputSchema: {
        dashboard: z.record(z.any()).describe("The dashboard JSON model (see get_dashboard for the shape)."),
        folderUid: z.string().optional().describe("Target folder UID. Omit for the General folder."),
        message: z.string().optional().describe("Version note recorded in the dashboard history."),
        overwrite: z.boolean().optional().describe("Set true when updating an existing dashboard by uid."),
      },
    },
    handler: async (args, { client, policy }) => {
      const folderUid = args.folderUid as string | undefined;
      const { dryRun } = policy.guard({ tool: "create_or_update_dashboard", capability: "write", folder: folderUid });
      const dashboard = args.dashboard as Record<string, unknown>;
      if (dryRun) {
        return textResult(
          `[dry-run] Would save dashboard '${(dashboard.title as string) ?? dashboard.uid ?? "(untitled)"}'` +
            `${folderUid ? ` to folder ${folderUid}` : ""}.`,
        );
      }
      return jsonResult(
        await client.upsertDashboard({
          dashboard,
          folderUid,
          message: args.message as string | undefined,
          overwrite: (args.overwrite as boolean | undefined) ?? false,
        }),
      );
    },
  },
  {
    name: "create_folder",
    capability: "write",
    config: {
      title: "Create a folder",
      description: "Create a dashboard folder. Optionally nest it under a parent folder UID.",
      inputSchema: {
        title: z.string().min(1).describe("Folder title."),
        uid: z.string().optional().describe("Explicit UID; omit to let Grafana generate one."),
        parentUid: z.string().optional().describe("Parent folder UID for a nested folder."),
      },
    },
    handler: async (args, { client, policy }) => {
      const parentUid = args.parentUid as string | undefined;
      const { dryRun } = policy.guard({ tool: "create_folder", capability: "write", folder: parentUid });
      if (dryRun) return textResult(`[dry-run] Would create folder '${args.title as string}'.`);
      return jsonResult(
        await client.createFolder({ title: args.title as string, uid: args.uid as string | undefined, parentUid }),
      );
    },
  },
  {
    name: "create_annotation",
    capability: "write",
    config: {
      title: "Create an annotation",
      description:
        "Add an annotation (a marked event) that overlays on dashboard graphs — e.g. a deploy or an " +
        "incident. Attach it globally, or to a specific dashboard/panel with dashboardUID + panelId.",
      inputSchema: {
        text: z.string().min(1).describe("Annotation text."),
        tags: z.array(z.string()).optional().describe("Tags to group/filter annotations, e.g. ['deploy']."),
        time: z.number().int().optional().describe("Start time, epoch ms. Default: now."),
        timeEnd: z.number().int().optional().describe("End time, epoch ms, for a region annotation."),
        dashboardUID: z.string().optional().describe("Attach to this dashboard."),
        panelId: z.number().int().optional().describe("Attach to this panel within the dashboard."),
      },
    },
    handler: async (args, { client, policy }) => {
      const { dryRun } = policy.guard({ tool: "create_annotation", capability: "write" });
      if (dryRun) return textResult(`[dry-run] Would create annotation: ${args.text as string}`);
      return jsonResult(
        await client.createAnnotation({
          text: args.text as string,
          tags: args.tags as string[] | undefined,
          time: args.time as number | undefined,
          timeEnd: args.timeEnd as number | undefined,
          dashboardUID: args.dashboardUID as string | undefined,
          panelId: args.panelId as number | undefined,
        }),
      );
    },
  },
];
