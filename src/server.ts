import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "./config.js";
import { makeConfirmer } from "./elicit.js";
import { GuardClient, loadGuardConfig } from "./guard.js";
import { GrafanaClient, GrafanaError } from "./grafana/client.js";
import { PolicyError, SecurityPolicy } from "./security.js";
import { adminTools } from "./tools/admin.js";
import { annotationsFor } from "./tools/annotations.js";
import { readTools } from "./tools/read.js";
import type { ToolContext, ToolDef } from "./tools/types.js";
import { writeTools } from "./tools/write.js";

export const ALL_TOOLS: ToolDef[] = [...readTools, ...writeTools, ...adminTools];

export function buildServer(config: AppConfig): { server: McpServer; enabled: string[] } {
  const policy = new SecurityPolicy(config.security);
  const client = new GrafanaClient(config.connection.baseUrl, config.connection.token, config.connection.timeoutMs);

  const server = new McpServer({ name: "grafana", version: "0.3.0" });
  const guard = new GuardClient(loadGuardConfig());
  const ctx: ToolContext = { client, policy, confirm: makeConfirmer(server), guard };

  const enabled: string[] = [];
  for (const tool of ALL_TOOLS) {
    if (!policy.isCapabilityEnabled(tool.capability)) continue;
    enabled.push(tool.name);
    server.registerTool(
      tool.name,
      { ...tool.config, annotations: annotationsFor(tool) },
      async (args: Record<string, unknown>) => {
        try {
          // laya-guard: assess every mutating op before it runs (no-op unless *_GUARD_MODE is set).
          if (tool.capability !== "read") {
            await guard.enforce({ tool: tool.name, command: `${tool.name} ${JSON.stringify(args ?? {})}`, context: tool.name }, ctx.confirm);
          }
          return await tool.handler(args ?? {}, ctx);
        } catch (err) {
          return toErrorResult(err);
        }
      },
    );
  }

  return { server, enabled };
}

function toErrorResult(err: unknown) {
  let message: string;
  if (err instanceof PolicyError) {
    message = `Policy denied: ${err.message}`;
  } else if (err instanceof GrafanaError) {
    message =
      err.status === 401 || err.status === 403
        ? `Grafana refused this request (${err.status}): ${err.message}. The service-account token may lack the role for this operation.`
        : err.message;
  } else if (err instanceof Error) {
    message = err.message;
  } else {
    message = String(err);
  }
  return { content: [{ type: "text" as const, text: message }], isError: true };
}
