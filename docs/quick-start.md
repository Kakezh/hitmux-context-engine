# Quick Start

本页说明 MCP client 侧如何启动 Hitmux Context Engine。产品配置放在 `~/.hitmux-context-engine/config.conf` 或项目内的 `.hitmux-context-engine/config.conf`；MCP client 配置只负责启动 stdio server。

## Product Config

先创建运行配置：

```bash
mkdir -p ~/.hitmux-context-engine
cat > ~/.hitmux-context-engine/config.conf << 'EOF'
embeddingProvider = OpenRouter
embeddingModel = qwen/qwen3-embedding-4b
openrouterApiKey = sk-or-your-openrouter-api-key
milvusAddress = localhost:19530
EOF
```

数据库说明：Local Milvus 使用 `milvusAddress = localhost:19530`。自托管远端 Milvus 使用可访问的 host 和 port；只有服务端启用了认证时才设置 `milvusToken`。Zilliz Cloud 使用 cloud public endpoint 作为 `milvusAddress`，并把 Personal Key 写入 `milvusToken`。`config.conf` 不能切换到 SQLite、Chroma、Qdrant、LanceDB 或其它数据库后端。

`@hitmux/hce`、`@hitmux/hitmux-context-engine` 和 `@hitmux/hitmux-context-engine-mcp` 都会启动同一个 MCP server。下面示例默认使用短包名：

```bash
npx -y @hitmux/hce@latest
```

## Claude Code

直接添加：

```bash
claude mcp add hitmux-context-engine -- npx -y @hitmux/hce@latest
```

修改 `config.conf` 后重新连接：

```text
/mcp reconnect hitmux-context-engine
```

## OpenAI Codex CLI

直接添加：

```bash
codex mcp add hitmux-context-engine -- npx -y @hitmux/hce@latest
```

也可以直接编辑 `~/.codex/config.toml`：

```toml
[mcp_servers.hitmux-context-engine]
command = "npx"
args = ["-y", "@hitmux/hce@latest"]
startup_timeout_sec = 20
```

## Cursor, Windsurf, Claude Desktop, Gemini CLI, Qwen Code, Cline, Roo Code

这些客户端通常使用 `mcpServers` JSON 配置。配置入口名称不同，但 server 片段相同。

常规配置：

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

Windows 客户端如果找不到 npm shim，把 `command` 改成 `npx.cmd`：

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

常见配置入口：

| Client | 配置位置 |
| --- | --- |
| Cursor | Settings 中的 MCP 配置，或项目 / 用户级 MCP JSON |
| Windsurf | Cascade / MCP Servers 设置 |
| Claude Desktop | `claude_desktop_config.json` |
| Gemini CLI | Gemini CLI settings JSON |
| Qwen Code | Qwen Code settings JSON |
| Cline | VS Code 扩展的 MCP Servers 设置 |
| Roo Code | VS Code 扩展的 MCP Servers 设置 |

## VS Code MCP

VS Code 原生 MCP 配置通常使用 `servers` 结构。用户级或工作区级 `.vscode/mcp.json` 示例：

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

如果希望 MCP client 运行当前 checkout，而不是 npm registry 上的发布包，使用：

```bash
./scripts/install-local-global.sh
```

脚本会检查 Node.js 和 pnpm 版本，按 lockfile 安装 workspace 依赖，构建 `@hitmux/hitmux-context-engine-mcp`，并安装一个指向本地 `packages/mcp/dist/index.js` 的 `hitmux-context-engine-mcp` wrapper。

默认安装到当前用户的 `$HOME/.local/bin/hitmux-context-engine-mcp`。使用 `sudo` 会安装到 `/usr/local/bin/hitmux-context-engine-mcp`。也可以改命令名或安装目录：

```bash
sudo ./scripts/install-local-global.sh
COMMAND_NAME=hce-mcp ./scripts/install-local-global.sh
BIN_DIR="$HOME/bin" ./scripts/install-local-global.sh
```

如果安装目录不在 `PATH`，把它加入 `PATH`，或者在 MCP client 的 `command` 中写 wrapper 的绝对路径。

本地 wrapper 的配置示例：

```bash
claude mcp add hitmux-context-engine -- hitmux-context-engine-mcp
codex mcp add hitmux-context-engine -- hitmux-context-engine-mcp
```

JSON 客户端：

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

## Use In A Repository

打开任意代码仓库后，在 MCP client 中请求：

```text
Index this codebase
Check the indexing status
Find functions that handle user authentication
```

修改 `config.conf` 后，需要重新连接或重启 MCP server。
