import { z } from "zod";
import type { ToolDef } from "./types.js";
import { jsonResult, textResult } from "./types.js";

/**
 * Write tools. Registered only in `read-write` mode and up. They create or update dashboards,
 * folders, annotations and alert silences. None permanently destroys data (dashboards are
 * versioned and can be rolled back, silences expire on their own or can be ended early) —
 * deletes live in admin.ts.
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
        dashboard: z.record(z.string(), z.any()).describe("The dashboard JSON model (see get_dashboard for the shape)."),
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
  {
    name: "create_silence",
    capability: "write",
    config: {
      title: "Create an alert silence",
      description:
        "Mute alerts matching label matchers for a time window — e.g. during planned maintenance. " +
        "It expires automatically at `endsAt`, or can be ended early with expire_silence. This only " +
        "suppresses notifications; the underlying alert rule keeps evaluating and firing.",
      inputSchema: {
        matchers: z
          .array(
            z.object({
              name: z.string().min(1).describe("Label name to match, e.g. 'alertname' or 'severity'."),
              value: z.string().describe("Label value (or pattern, if isRegex) to match."),
              isRegex: z.boolean().optional().describe("Treat `value` as a regular expression. Default false."),
              isEqual: z.boolean().optional().describe("Match equality (true) or inequality (false). Default true."),
            }),
          )
          .min(1)
          .describe("Label matchers. An alert is silenced only when it matches ALL of these."),
        startsAt: z.string().optional().describe("ISO 8601 start time. Default: now."),
        endsAt: z.string().describe("ISO 8601 end time — the silence stops muting automatically at this time."),
        comment: z.string().min(1).describe("Why this silence exists, shown to anyone who looks it up later."),
        createdBy: z.string().optional().describe("Who/what created it. Defaults to 'mcp-grafana'."),
      },
    },
    handler: async (args, { client, policy }) => {
      const { dryRun } = policy.guard({ tool: "create_silence", capability: "write" });
      const matchers = args.matchers as Array<{ name: string; value: string; isRegex?: boolean; isEqual?: boolean }>;
      const startsAt = (args.startsAt as string | undefined) ?? new Date().toISOString();
      const endsAt = args.endsAt as string;
      const comment = args.comment as string;
      if (dryRun) {
        return textResult(
          `[dry-run] Would silence alerts matching ${JSON.stringify(matchers)} from ${startsAt} until ${endsAt} (${comment}).`,
        );
      }
      return jsonResult(
        await client.createSilence({
          matchers,
          startsAt,
          endsAt,
          comment,
          createdBy: (args.createdBy as string | undefined) ?? "mcp-grafana",
        }),
      );
    },
  },
  {
    name: "expire_silence",
    capability: "write",
    config: {
      title: "Expire a silence early",
      description:
        "End an active or pending silence immediately, resuming notifications for the alerts it was " +
        "muting. Not destructive: the silence record is kept, just marked expired — it is the " +
        "intended way to cancel a silence you created early.",
      inputSchema: { id: z.string().min(1).describe("Silence id (from list_silences or create_silence).") },
    },
    handler: async (args, { client, policy }) => {
      const id = args.id as string;
      const { dryRun } = policy.guard({ tool: "expire_silence", capability: "write" });
      if (dryRun) return textResult(`[dry-run] Would expire silence ${id}.`);
      await client.expireSilence(id);
      return textResult(`Silence ${id} expired — notifications resume for alerts it was muting.`);
    },
  },
];
