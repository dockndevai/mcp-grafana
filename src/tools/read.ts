import { z } from "zod";
import { redactDatasource } from "../grafana/client.js";
import type { ToolDef } from "./types.js";
import { jsonResult, textResult } from "./types.js";

/**
 * Read tools. Available in every access mode (read-only and up). None of these mutate Grafana.
 * Datasource secrets are never returned (see redactDatasource).
 */
export const readTools: ToolDef[] = [
  {
    name: "get_health",
    capability: "read",
    config: {
      title: "Grafana health",
      description: "Check the Grafana instance is reachable and return its version and database status.",
      inputSchema: {},
    },
    handler: async (_args, { client, policy }) => {
      policy.guard({ tool: "get_health", capability: "read" });
      return jsonResult(await client.health());
    },
  },
  {
    name: "search",
    capability: "read",
    config: {
      title: "Search dashboards & folders",
      description:
        "Search dashboards and folders by name/tag. Use this first to find a dashboard's UID before " +
        "get_dashboard. Returns title, uid, type (dash-db | dash-folder), folder and tags.",
      inputSchema: {
        query: z.string().optional().describe("Free-text match on title. Omit to list everything."),
        type: z.enum(["dash-db", "dash-folder"]).optional().describe("Restrict to dashboards or folders."),
        tag: z.string().optional().describe("Restrict to a dashboard tag."),
        limit: z.number().int().min(1).max(1000).optional(),
      },
    },
    handler: async (args, { client, policy }) => {
      policy.guard({ tool: "search", capability: "read" });
      return jsonResult(
        await client.search({
          query: args.query as string | undefined,
          type: args.type as string | undefined,
          tag: args.tag as string | undefined,
          limit: args.limit as number | undefined,
        }),
      );
    },
  },
  {
    name: "list_dashboards",
    capability: "read",
    config: {
      title: "List dashboards",
      description: "List dashboards (optionally filtered by tag). Shorthand for search with type=dash-db.",
      inputSchema: { tag: z.string().optional().describe("Restrict to a tag."), limit: z.number().int().min(1).max(1000).optional() },
    },
    handler: async (args, { client, policy }) => {
      policy.guard({ tool: "list_dashboards", capability: "read" });
      return jsonResult(await client.search({ type: "dash-db", tag: args.tag as string | undefined, limit: args.limit as number | undefined }));
    },
  },
  {
    name: "get_dashboard",
    capability: "read",
    config: {
      title: "Get dashboard",
      description:
        "Return the full dashboard JSON model (panels, targets, templating, time) plus meta (folder, " +
        "version, url) for a dashboard UID. This is the model you edit and pass back to " +
        "create_or_update_dashboard.",
      inputSchema: { uid: z.string().min(1).describe("Dashboard UID (from search).") },
    },
    handler: async (args, { client, policy }) => {
      policy.guard({ tool: "get_dashboard", capability: "read" });
      return jsonResult(await client.getDashboard(args.uid as string));
    },
  },
  {
    name: "list_folders",
    capability: "read",
    config: { title: "List folders", description: "List dashboard folders with their UIDs and titles.", inputSchema: {} },
    handler: async (_args, { client, policy }) => {
      policy.guard({ tool: "list_folders", capability: "read" });
      return jsonResult(await client.listFolders());
    },
  },
  {
    name: "get_folder",
    capability: "read",
    config: { title: "Get folder", description: "Return a folder's details by UID.", inputSchema: { uid: z.string().min(1) } },
    handler: async (args, { client, policy }) => {
      policy.guard({ tool: "get_folder", capability: "read" });
      return jsonResult(await client.getFolder(args.uid as string));
    },
  },
  {
    name: "list_datasources",
    capability: "read",
    config: {
      title: "List datasources",
      description:
        "List configured datasources (uid, name, type, url). Secrets (secureJsonData, passwords, " +
        "tokens) are never returned. Use the uid with query_datasource.",
      inputSchema: {},
    },
    handler: async (_args, { client, policy }) => {
      policy.guard({ tool: "list_datasources", capability: "read" });
      return jsonResult((await client.listDatasources()).map(redactDatasource));
    },
  },
  {
    name: "get_datasource",
    capability: "read",
    config: {
      title: "Get datasource",
      description: "Return a single datasource by UID (secrets redacted).",
      inputSchema: { uid: z.string().min(1) },
    },
    handler: async (args, { client, policy }) => {
      policy.guard({ tool: "get_datasource", capability: "read" });
      return jsonResult(redactDatasource(await client.getDatasource(args.uid as string)));
    },
  },
  {
    name: "query_datasource",
    capability: "read",
    config: {
      title: "Query a datasource",
      description:
        "Run a query against a datasource through Grafana's unified query API and return the result " +
        "frames. For Prometheus/Loki set `expr` (PromQL / LogQL); for SQL datasources set `rawSql`. " +
        "Reading data only — this never mutates anything. Use a bounded time range and a small " +
        "maxDataPoints to keep results manageable.",
      inputSchema: {
        datasourceUid: z.string().min(1).describe("Datasource UID (from list_datasources)."),
        expr: z.string().optional().describe("PromQL or LogQL expression, e.g. 'up' or 'rate(http_requests_total[5m])'."),
        rawSql: z.string().optional().describe("SQL for SQL datasources (a single read-only SELECT)."),
        from: z.string().optional().describe("Range start, e.g. 'now-1h' or an epoch ms string. Default now-1h."),
        to: z.string().optional().describe("Range end, e.g. 'now'. Default now."),
        maxDataPoints: z.number().int().min(1).max(5000).optional().describe("Cap on returned points. Default 100."),
      },
    },
    handler: async (args, { client, policy }) => {
      const datasourceUid = args.datasourceUid as string;
      policy.guard({ tool: "query_datasource", capability: "read", datasource: datasourceUid });
      const result = await client.query(
        [
          {
            datasourceUid,
            expr: args.expr as string | undefined,
            rawSql: args.rawSql as string | undefined,
            maxDataPoints: args.maxDataPoints as number | undefined,
          },
        ],
        (args.from as string | undefined) ?? "now-1h",
        (args.to as string | undefined) ?? "now",
      );
      return jsonResult(result);
    },
  },
  {
    name: "list_alert_rules",
    capability: "read",
    config: {
      title: "List alert rules",
      description: "List Grafana-managed alert rules (via the provisioning API): title, condition, folder, state.",
      inputSchema: {},
    },
    handler: async (_args, { client, policy }) => {
      policy.guard({ tool: "list_alert_rules", capability: "read" });
      return jsonResult(await client.listAlertRules());
    },
  },
  {
    name: "list_annotations",
    capability: "read",
    config: {
      title: "List annotations",
      description: "List annotations (events overlaid on graphs), optionally within a time range or by tag.",
      inputSchema: {
        from: z.number().int().optional().describe("Range start, epoch ms."),
        to: z.number().int().optional().describe("Range end, epoch ms."),
        tags: z.array(z.string()).optional().describe("Restrict to annotations with these tags."),
        limit: z.number().int().min(1).max(1000).optional(),
      },
    },
    handler: async (args, { client, policy }) => {
      policy.guard({ tool: "list_annotations", capability: "read" });
      return jsonResult(
        await client.listAnnotations({
          from: args.from as number | undefined,
          to: args.to as number | undefined,
          tags: args.tags as string[] | undefined,
          limit: args.limit as number | undefined,
        }),
      );
    },
  },
];
