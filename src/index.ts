#!/usr/bin/env node
/**
 * MCP server for Grafana.
 *
 * Lets an agent explore and operate Grafana — search dashboards and folders, read the dashboard
 * JSON model, list and query datasources (Prometheus/Loki/SQL via the unified /api/ds/query),
 * inspect alert rules and annotations, and (in higher modes) create/update dashboards and folders,
 * write annotations, and delete.
 *
 * Safe by default: starts in read-only mode, so only the read tools are registered. Writes need
 * GRAFANA_MODE=read-write; deletes need admin mode plus GRAFANA_ALLOW_DELETE=true. The access model
 * (src/security.ts) is defence in depth over the Grafana service-account token's own role.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";

const config = loadConfig();

if (!config.connection.token) {
  process.stderr.write(
    "GRAFANA_TOKEN is not set. Create a service account token in Grafana " +
      "(Administration → Service accounts → Add token) and export it as GRAFANA_TOKEN. " +
      "Use a Viewer-role account for read-only use.\n",
  );
  process.exit(1);
}

const { server, enabled } = buildServer(config);

const transport = new StdioServerTransport();
await server.connect(transport);
// stdout carries the protocol; diagnostics go to stderr.
process.stderr.write(
  `grafana-mcp connected to ${config.connection.baseUrl} [mode=${config.security.mode}, tools=${enabled.length}: ${enabled.join(", ")}]\n`,
);
