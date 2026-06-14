# Issue.md

## 当前状态

2026-06-14 只读审查发现下列待修复问题。审查方式：4 个 SubAgent 并行检查 `packages/core`、`packages/mcp`、入口脚本/发布包装、测试与文档一致性；主线程抽查了高风险源码上下文。

已修复并移除原 P0 前三条：startup snapshot validation timeout、background sync lock heartbeat、incremental delete filter normalization/escaping。

已修复并移除原 P1 前五条：snapshot lock 获取失败后仍写文件、`get_indexing_status` stale memory、增量同步后 snapshot 统计不更新、`extensionFilter` filter expression 校验不足、`splitterType` 配置默认不生效。

已修复并移除 2026-06-14 本轮前五条：`searchTopK` / `searchThreshold` runtime 读取、项目级 `customExtensions` / `customIgnorePatterns` 作用域、`snapshotBaseDir` 构造参数、OpenAI-compatible dimension cache key、`pnpm benchmark` 失败退出码。

已执行验证：

```bash
pnpm --dir packages/mcp exec node --import tsx --test src/handlers.snapshot-reconcile.test.ts
pnpm --dir packages/mcp exec node --import tsx --test src/sync.background.test.ts
pnpm --filter @hitmux/hitmux-context-engine-core test -- context.ignore-patterns.test.ts
pnpm --dir packages/mcp exec node --import tsx --test src/snapshot.concurrent.test.ts
pnpm --dir packages/mcp exec node --import tsx --test src/handlers.get-indexing-status.test.ts
pnpm --dir packages/mcp exec node --import tsx --test src/handlers.args.test.ts
pnpm --dir packages/mcp exec node --import tsx --test src/sync.background.test.ts src/handlers.index-concurrency.test.ts
pnpm --filter @hitmux/hitmux-context-engine-core test -- context.ignore-patterns.test.ts sync/synchronizer.test.ts embedding/openai-embedding.test.ts
node --test scripts/build-benchmark.test.js
pnpm typecheck
```

结果：通过。

未执行真实 Milvus/Zilliz endpoint smoke，所以下列运行时问题是静态审查结论，live reproduction 为 `not verified`。

## P2 - 验证脚本、发布包装和示例

### 1. `mcp-status-smoke.mjs` 默认命令和本地安装脚本不一致

- 位置：`scripts/mcp-status-smoke.mjs:11`, `scripts/mcp-status-smoke.mjs:60`, `scripts/install-local-global.sh:8`
- 触发条件：用户按 `scripts/install-local-global.sh` 安装后直接运行 `node scripts/mcp-status-smoke.mjs --path <repo>`。
- 影响：smoke 尝试执行不存在的 `hce`，失败点是命令解析而不是 MCP server。
- 原因：smoke 默认 `hce`，本地安装默认 `hitmux-context-engine-mcp`。
- 修复方向：统一默认命令；或明确 smoke 默认面向 npm alias，并在本地安装文档中要求传 `--command hitmux-context-engine-mcp`。

### 2. `build:examples` 没有保证 core 先构建

- 位置：`package.json:10`, `examples/basic-usage/package.json:8`, `packages/core/package.json:5`
- 触发条件：fresh checkout 或执行过 `pnpm clean` 后直接运行 `pnpm build:examples`。
- 影响：example 构建依赖缺失或陈旧的 `packages/core/dist`。
- 原因：example 依赖 workspace core，但根脚本只构建 `examples/*`，没有包含依赖闭包。
- 修复方向：让 `build:examples` 先跑 `pnpm build:core`，或使用包含依赖的 pnpm filter。

### 3. 发布包 sourcemap / declaration map 指向未发布的 `src`

- 位置：`packages/core/tsconfig.json:8`, `packages/mcp/tsconfig.json:8`, `packages/core/package.json:48`, `packages/mcp/package.json:31`
- 触发条件：用户在已发布包里调试 stack trace，或 IDE 跟随 `.d.ts.map`。
- 影响：源码映射落到包外路径，调试和类型跳转失效。
- 原因：包文件列表只包含 `dist`，但 map 文件指向 `../src/...`。
- 修复方向：发布 `src`，关闭 map 发布，或启用自包含 sourcemap 策略。

### 4. Python E2E 脚本路径和退出码不可靠

- 位置：`python/test_endtoend.py:41`, `python/test_endtoend.py:111`
- 触发条件：从仓库根目录运行 `python python/test_endtoend.py`，或 TypeScript 调用失败。
- 影响：可能找错 `./test_context.ts`；失败也可能以 0 退出。
- 原因：脚本默认 working directory 是当前目录，且只打印结果不 `sys.exit(1)`。
- 修复方向：以 `Path(__file__).parent` 作为 executor working_dir，或传绝对 TS 文件路径；`main()` 按 success 设置退出码。

### 5. Python E2E 仍验证旧 env/direct-core 路径

- 位置：`python/test_endtoend.py:20`, `python/test_context.ts:21`, `docs/configuration.md:11`
- 触发条件：用户按当前 `config.conf` 配了 OpenRouter/Voyage/Gemini/Ollama 或 proxy 后运行 Python E2E。
- 影响：验证的不是当前 MCP runtime 配置路径，可能错误失败或错误通过。
- 原因：脚本仍用 `OPENAI_API_KEY` / `MILVUS_ADDRESS` 并直接构造 `OpenAIEmbedding`、`MilvusVectorDatabase`。
- 修复方向：复用 MCP `createMcpConfig` / `createEmbeddingInstance` 路径，或明确标为 legacy core-only smoke。

### 6. CannonWar search-quality runner 遗漏 database proxy 配置

- 位置：`evaluation/search-quality/run-cannonwar-search-quality.ts:697`, `evaluation/search-quality/run-cannonwar-search-quality.ts:699`, `packages/mcp/src/index.ts:133`
- 触发条件：`databaseUseSystemProxy = true` 或代理环境影响 Milvus/Zilliz 连接。
- 影响：benchmark 与真实 MCP 行为不一致，可能错误失败或错误通过。
- 原因：runner 读取 MCP config，但构造 `MilvusVectorDatabase` 时只传 address/token，未传 `useSystemProxy`。
- 修复方向：传入 `useSystemProxy: config.databaseUseSystemProxy`，并加轻量构造参数测试。

## 建议修复顺序

1. 先修剩余验证脚本和发布包装可信度问题。
2. 再处理示例构建、Python E2E 和 CannonWar benchmark 与真实 MCP runtime 的一致性。
