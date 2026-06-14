# Troubleshooting

## Check Indexing Status First

先让 MCP client 调用：

```text
Check the indexing status
```

这会调用 `get_indexing_status`，通常能看到索引进度、完成状态或最近一次索引错误。

## Check Configuration

Hitmux Context Engine 从以下位置读取产品配置：

1. `~/.hitmux-context-engine/config.conf`
2. `./.hitmux-context-engine/config.conf`
3. built-in defaults

环境变量和 `~/.hitmux-context-engine/.env` 不用于 MCP 产品配置。

常见检查项：

- 当前 `embeddingProvider` 有对应的 API key 字段，例如 `openrouterApiKey`、`openaiApiKey`、`voyageaiApiKey` 或 `geminiApiKey`。
- Local Milvus 使用 `milvusAddress = localhost:19530`。
- 自托管远端 Milvus 使用可访问的 host 和 port 作为 `milvusAddress`；只有服务端启用了认证时才设置 `milvusToken`。
- Zilliz Cloud 使用 cloud public endpoint 作为 `milvusAddress`，并把 Personal Key 写入 `milvusToken`。
- SQLite、Chroma、Qdrant、LanceDB 和其它数据库后端不能通过 `config.conf` 选择。
- 项目内 `.hitmux-context-engine/config.conf` 没有用空字符串覆盖全局密钥。

## Reconnect After Config Changes

修改 `config.conf` 后，重新连接或重启 MCP server。

Claude Code：

```text
/mcp reconnect hitmux-context-engine
```

Gemini CLI：

```text
/mcp refresh
```

GUI MCP client 通常在 MCP settings 中提供 restart、reconnect 或 enable/disable 切换。

## Get Logs

Claude Code 和 Gemini CLI：

```bash
claude --debug
gemini --debug
```

Cursor、Windsurf、Cline、Roo Code 这类 IDE / extension 通常在 Output 面板中提供 MCP 日志。

报告问题时请附带：

- MCP client 名称和版本。
- MCP client server config。
- 已脱敏的 `config.conf`。
- `get_indexing_status` 输出。
- 相关 debug logs。

## Windows: `spawn C:\Windows\system32\cmd.exe ENOENT`

这个错误由 MCP client 在 Hitmux Context Engine 启动前抛出。检查：

```powershell
Test-Path "$env:SystemRoot\System32\cmd.exe"
Get-Command node
Get-Command npm
Get-Command npx
```

如果 `cmd.exe` 不存在，修复 Windows，或把 `ComSpec` 恢复为 `%SystemRoot%\System32\cmd.exe`。如果 `npx` 不存在，从官方 Windows installer 重新安装 Node.js，并重启 MCP client。

无法正确解析 npm shim 的客户端可以使用 `npx.cmd`：

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

## Completed Status Shows `0 files, 0 chunks`

`get_indexing_status` 读取本机 MCP snapshot metadata。如果 completed entry 显示零计数：

1. 确认正在检查的是最初索引时的同一个绝对路径。
2. 对该路径运行 `clear_index`。
3. 对同一路径重新运行 `index_codebase`。

## Fully Local Setup

完全本地配置可以使用 Local Milvus 加 Ollama：

```conf
embeddingProvider = Ollama
embeddingModel = nomic-embed-text
ollamaHost = http://127.0.0.1:11434
milvusAddress = localhost:19530
```
