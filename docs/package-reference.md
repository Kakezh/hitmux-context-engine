# Package Reference

## MCP Packages

Packages:

- `@hitmux/hce`: short alias for the MCP server.
- `@hitmux/hitmux-context-engine`: full-name alias for the MCP server.
- `@hitmux/hitmux-context-engine-mcp`: original MCP server package.

Run with:

```bash
npx -y @hitmux/hce@latest
npx -y @hitmux/hitmux-context-engine@latest
npx -y @hitmux/hitmux-context-engine-mcp@latest
```

Configure product options in `~/.hitmux-context-engine/config.conf` or `./.hitmux-context-engine/config.conf`. See [configuration.md](configuration.md).

### MCP Tools

`index_codebase`

Indexes a codebase directory for hybrid search. Useful arguments include:

- `path`: codebase path.
- `incremental`: manually sync added, modified, removed, or newly ignored files for an already indexed codebase without rebuilding.
- `force`: full rebuild for exceptional cases only, such as embedding/schema/splitter compatibility changes or untrustworthy index state.
- `dryRun`: preview indexable files without writing vectors.
- `customExtensions`: additional extensions to include.
- `customIgnorePatterns`: additional ignore globs.

`search_code`

Searches an indexed codebase with a focused code-search query.

- `path`: codebase path.
- `query`: focused query using likely identifiers, filenames, path words, domain terms, and scope hints.
- `limit`: optional max number of returned results. Leave empty for the bounded default.
- `targetRole`: optional explicit search target: `implementation`, `test`, `docs`, `config`, or `all`. Defaults to `implementation`.
- `includeRelated`: optional boolean. Defaults to `true`; set `false` to return only the primary role group.
- `includeTraceEvidence`: optional boolean. Defaults to `false`; set `true` to attach compact `trace_symbol` evidence for a small number of top implementation or entry results.

`trace_symbol`

Traces an identifier through current source files without requiring a schema migration or re-index. It returns definitions, references, imports, exports, and related tests.

- `path`: codebase path.
- `symbol`: identifier to trace.
- `startPath`: optional file to scan first, usually a top `search_code` result or known entry point.
- `startLine` / `endLine`: optional 1-based line range inside `startPath` to prioritize evidence near a current search result.
- `maxFiles`: optional maximum source files to scan. Defaults to `1000`.
- `maxReferences`: optional maximum entries per evidence section. Defaults to `40`.
- `includeTests`: optional boolean. Defaults to `true`.

Reference evidence may include caller/callee hints when a simple line-level call can be inferred, such as `World.addTower -> EntityManager.addTower`.

`clear_index`

Clears index data for a codebase.

`get_indexing_status`

Returns indexing progress, completion status, counts, or recent errors.

## Core Package

Package: `@hitmux/hitmux-context-engine-core`

Install:

```bash
npm install @hitmux/hitmux-context-engine-core
```

Minimal usage:

```typescript
import { Context, MilvusVectorDatabase, OpenAIEmbedding } from '@hitmux/hitmux-context-engine-core';

const embedding = new OpenAIEmbedding({
    apiKey: 'sk-your-openai-api-key',
    model: 'text-embedding-3-small'
});

const vectorDatabase = new MilvusVectorDatabase({
    address: 'localhost:19530',
    token: ''
});

const context = new Context({
    embedding,
    vectorDatabase
});

await context.indexCodebase('./my-project');

const results = await context.semanticSearch(
    './my-project',
    'function that handles user authentication',
    5
);
```

Database note: Use Local Milvus with `address: "localhost:19530"`. For self-hosted remote Milvus, replace it with the reachable host and port, and pass `token` only if authentication is required. For Zilliz Cloud, use the cloud public endpoint and pass the Personal Key as `token`.

### Common Core APIs

- `indexCodebase(path, progressCallback?, forceReindex?)`
- `reindexByChange(path, progressCallback?)`
- `semanticSearch(path, query, topK?, threshold?, filterExpr?, options?)`
- `traceSymbol(path, symbol, options?)`

`semanticSearch` keeps `topK` as the core API name for the returned result count. Internally, search uses a larger bounded candidate pool before dedupe/rerank, so the visible result count does not cap initial dense/sparse recall.
`options.targetRole` defaults to `implementation`; `options.includeRelated` defaults to `true`. Search results are annotated with `resultGroup`, `isPrimary`, `fileRole`, and `chunkRole` so callers can separate primary implementation matches from entry/export, related test, docs/config, and chunk-level structural matches.
- `hasIndex(path)`
- `clearIndex(path, progressCallback?)`
- `addCustomIgnorePatterns(patterns)`
- `addCustomExtensions(extensions)`
- `updateEmbedding(embedding)`
- `updateVectorDatabase(vectorDB)`
- `updateSplitter(splitter)`

### Search Result Shape

```typescript
interface SemanticSearchResult {
    content: string;
    relativePath: string;
    startLine: number;
    endLine: number;
    language: string;
    score: number;
    resultGroup?: "implementation" | "entry_exports" | "related_tests" | "docs_config" | "other";
    isPrimary?: boolean;
    fileRole?: string;
    chunkRole?: "definition" | "method_body" | "reference" | "test_case" | "assertion" | "re_export" | "module_decl" | string;
}
```

## Development Commands

```bash
pnpm build
pnpm build:core
pnpm build:mcp
pnpm build:examples
pnpm typecheck
pnpm lint
pnpm --filter @hitmux/hitmux-context-engine-core test
pnpm --filter @hitmux/hitmux-context-engine-mcp test
```
