# Installing `mcp-grafana` in your MCP client

`mcp-grafana` is a **stdio** MCP server. Any MCP-compatible agent can run it.

- **From npm (recommended):** `npx -y @dockndevai/mcp-grafana`
- **From source:** `node /ABSOLUTE/PATH/TO/mcp-grafana/dist/index.js` after `npm install && npm run build`.

> You need a Grafana **service-account token** (`GRAFANA_TOKEN`). **Start in `read-only` mode** with a Viewer-role token and raise it deliberately. See [`.env.example`](../.env.example) for every variable.

## Claude Code (CLI)

```bash
claude mcp add grafana \
  -e GRAFANA_URL="http://localhost:3000" \
  -e GRAFANA_TOKEN="glsa_..." \
  -e GRAFANA_MODE="read-only" \
  -- npx -y @dockndevai/mcp-grafana
```

Add `-s user` to install it for all your projects, or `-s project` for a shared `.mcp.json`. List with `claude mcp list`, remove with `claude mcp remove grafana`.

## Claude Desktop

Edit `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`) and merge:

```json
{
  "mcpServers": {
    "grafana": {
      "command": "npx",
      "args": ["-y", "@dockndevai/mcp-grafana"],
      "env": {
        "GRAFANA_URL": "http://localhost:3000",
        "GRAFANA_TOKEN": "glsa_...",
        "GRAFANA_MODE": "read-only"
      }
    }
  }
}
```

Restart Claude Desktop. The server appears under the tools (🔨) menu.

## Cursor

Create `.cursor/mcp.json` (or `~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "grafana": {
      "command": "npx",
      "args": ["-y", "@dockndevai/mcp-grafana"],
      "env": { "GRAFANA_URL": "http://localhost:3000", "GRAFANA_TOKEN": "glsa_...", "GRAFANA_MODE": "read-only" }
    }
  }
}
```

Then enable it in **Cursor Settings → MCP**.

## OpenAI Codex CLI

Edit `~/.codex/config.toml`:

```toml
[mcp_servers.grafana]
command = "npx"
args = ["-y", "@dockndevai/mcp-grafana"]
env = { GRAFANA_URL = "http://localhost:3000", GRAFANA_TOKEN = "glsa_...", GRAFANA_MODE = "read-only" }
```

## Windsurf

Edit `~/.codeium/windsurf/mcp_config.json` with the same `mcpServers` block as Cursor, then **Refresh** in the Windsurf MCP panel.

## VS Code (GitHub Copilot / Agent mode)

Create `.vscode/mcp.json` (top-level key is `servers`):

```json
{
  "servers": {
    "grafana": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@dockndevai/mcp-grafana"],
      "env": { "GRAFANA_URL": "http://localhost:3000", "GRAFANA_TOKEN": "glsa_...", "GRAFANA_MODE": "read-only" }
    }
  }
}
```

## Verify

On startup the server logs a line to **stderr** like:

```
grafana-mcp connected to http://localhost:3000 [mode=read-only, tools=11: get_health, search, ...]
```

If `GRAFANA_TOKEN` is missing it exits with the fix printed to stderr. Ask your agent to *"list the Grafana tools"* to confirm.
