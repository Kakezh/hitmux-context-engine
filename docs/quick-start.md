# Quick Start

This page shows how to start Hitmux Context Engine from MCP clients. Product configuration lives in `~/.hitmux-context-engine/config.conf` or `.hitmux-context-engine/config.conf` inside a project. MCP client configuration only starts the stdio server.

## Product Config

Create the runtime config first:

```bash
mkdir -p ~/.hitmux-context-engine
cat > ~/.hitmux-context-engine/config.conf << 'EOF'
embeddingProvider = OpenRouter
embeddingModel = qwen/qwen3-embedding-4b
openrouterApiKey = sk-or-your-openrouter-api-key
milvusAddress = localhost:19530
EOF
```

Database notes: Local Milvus uses `milvusAddress = localhost:19530`. For a self-hosted remote Milvus instance, use the reachable host and port; set `milvusToken` only when the server requires authentication. For Zilliz Cloud, use the cloud public endpoint as `milvusAddress` and put the Personal Key in `milvusToken`. `config.conf` cannot switch to SQLite, Chroma, Qdrant, LanceDB, or other database backends.

`@hitmux/hce`, `@hitmux/hitmux-context-engine`, and `@hitmux/hitmux-context-engine-mcp` all start the same MCP server. The examples below use the short package name:

```bash
npx -y @hitmux/hce@latest
```

## Claude Code

Add the server directly:

```bash
claude mcp add hitmux-context-engine -- npx -y @hitmux/hce@latest
```

After editing `config.conf`, reconnect the server:

```text
/mcp reconnect hitmux-context-engine
```

## OpenAI Codex CLI

Add the server directly:

```bash
codex mcp add hitmux-context-engine -- npx -y @hitmux/hce@latest
```

You can also edit `~/.codex/config.toml` directly:

```toml
[mcp_servers.hitmux-context-engine]
command = "npx"
args = ["-y", "@hitmux/hce@latest"]
startup_timeout_sec = 20
```

## OpenCode

OpenCode config uses the `mcp` object in `opencode.json` or `opencode.jsonc`. For a global setup, edit `~/.config/opencode/opencode.json`. For a project-local setup, add `opencode.json` in the project root.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "hitmux-context-engine": {
      "type": "local",
      "command": ["npx", "-y", "@hitmux/hce@latest"],
      "enabled": true
    }
  }
}
```

OpenCode merges global and project config. If the same MCP server name appears in more than one config file, the higher-precedence config value wins.

## CC Switch

CC Switch manages MCP servers from its MCP panel and syncs them into supported apps such as Claude Code, Codex, Gemini CLI, OpenCode, and Hermes.

Add Hitmux Context Engine as a custom local stdio server:

| Field | Value |
| --- | --- |
| Server ID | `hitmux-context-engine` |
| Name | `Hitmux Context Engine` |
| Transport Type | `stdio` |
| Command | `npx` |
| Arguments | `-y @hitmux/hce@latest` |

Enable the app toggles for the clients you want CC Switch to manage. CC Switch writes the corresponding client config on sync; restart the target CLI after changing MCP settings.

## Cursor, Windsurf, Claude Desktop, Gemini CLI, Qwen Code, Cline, Roo Code

These clients usually use `mcpServers` JSON config. The settings entry name differs by client, but the server snippet is the same.

Standard config:

```json
{
  "mcpServers": {
    "hitmux-context-engine": {
      "command": "npx",
      "args": ["-y", "@hitmux/hce@latest"]
    }
  }
}
```

On Windows, if the client cannot find the npm shim, change `command` to `npx.cmd`:

```json
{
  "mcpServers": {
    "hitmux-context-engine": {
      "command": "npx.cmd",
      "args": ["-y", "@hitmux/hce@latest"]
    }
  }
}
```

Common settings locations:

| Client | Configuration location |
| --- | --- |
| Cursor | MCP settings in Settings, or project / user-level MCP JSON |
| Windsurf | Cascade / MCP Servers settings |
| Claude Desktop | `claude_desktop_config.json` |
| Gemini CLI | Gemini CLI settings JSON |
| Qwen Code | Qwen Code settings JSON |
| Cline | MCP Servers settings in the VS Code extension |
| Roo Code | MCP Servers settings in the VS Code extension |

## VS Code MCP

VS Code native MCP config usually uses a `servers` structure. Example user-level or workspace-level `.vscode/mcp.json`:

```json
{
  "servers": {
    "hitmux-context-engine": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@hitmux/hce@latest"]
    }
  }
}
```

## Local Source Install

If you want an MCP client to run the current checkout instead of the package published to the npm registry, use:

```bash
./scripts/install-local-global.sh
```

The script checks the Node.js and pnpm versions, installs workspace dependencies from the lockfile, builds `@hitmux/hitmux-context-engine-mcp`, and installs a `hitmux-context-engine-mcp` wrapper that points to the local `packages/mcp/dist/index.js`.

By default, it installs to `$HOME/.local/bin/hitmux-context-engine-mcp` for the current user. Running it with `sudo` installs to `/usr/local/bin/hitmux-context-engine-mcp`. You can also change the command name or install directory:

```bash
sudo ./scripts/install-local-global.sh
COMMAND_NAME=hce-mcp ./scripts/install-local-global.sh
BIN_DIR="$HOME/bin" ./scripts/install-local-global.sh
```

If the install directory is not in `PATH`, add it to `PATH` or use the wrapper's absolute path as the MCP client's `command`.

Local wrapper examples:

```bash
claude mcp add hitmux-context-engine -- hitmux-context-engine-mcp
codex mcp add hitmux-context-engine -- hitmux-context-engine-mcp
```

JSON clients:

```json
{
  "mcpServers": {
    "hitmux-context-engine": {
      "command": "hitmux-context-engine-mcp",
      "args": []
    }
  }
}
```

OpenCode:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "hitmux-context-engine": {
      "type": "local",
      "command": ["hitmux-context-engine-mcp"],
      "enabled": true
    }
  }
}
```

CC Switch:

| Field | Value |
| --- | --- |
| Server ID | `hitmux-context-engine` |
| Name | `Hitmux Context Engine` |
| Transport Type | `stdio` |
| Command | `hitmux-context-engine-mcp` |
| Arguments | |

## Use In A Repository

Open any code repository, then ask your MCP client:

```text
Index this codebase
Check the indexing status
Find functions that handle user authentication
```

After editing `config.conf`, reconnect or restart the MCP server.
