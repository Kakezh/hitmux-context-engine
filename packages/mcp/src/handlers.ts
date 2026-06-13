import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { Context, COLLECTION_LIMIT_MESSAGE, FileSynchronizer, IndexAbortError, normalizeCodebaseIdentityPath, type SearchTargetRole, type SymbolTraceEvidence, type SymbolTraceResult } from "@hitmux/hitmux-context-engine-core";
import { SnapshotManager } from "./snapshot.js";
import { getBooleanFromConfig, type CodebaseIndexOptions, type CodebaseInfoIndexed, type RequestSplitterType } from "./config.js";
import { createRequestSplitter, isRequestSplitterType, resolveRequestSplitterType } from "./splitter.js";
import { analyzeFilenameLikeQuery, formatFilenameQueryNotice, searchResultsAreFallbackMatches } from "./search-filename-query.js";
import { ensureAbsolutePath, truncateContent, trackCodebasePath } from "./utils.js";

const DEFAULT_SEARCH_RESULT_LIMIT = 20;
const SOURCE_CONTEXT_WINDOW_LINES = 4;
const SEARCH_CONTEXT_MAX_CHARS = 5000;
const SEARCH_TRACE_FOLLOWUP_RESULT_LIMIT = 5;
const SEARCH_TRACE_FOLLOWUP_SYMBOL_LIMIT = 3;
const SEARCH_TRACE_EVIDENCE_RESULT_LIMIT = 3;
const SEARCH_TRACE_EVIDENCE_SYMBOL_LIMIT = 1;
const SEARCH_TRACE_EVIDENCE_MAX_FILES = 500;
const SEARCH_TRACE_EVIDENCE_MAX_REFERENCES = 8;
const NOT_INDEXED_INDEXING_HINT = "Please index it first using the index_codebase tool. Before first indexing, create a project ignore file such as .hceignore when you need to exclude generated, large, or private paths. The indexer automatically loads .*ignore files it finds in the project tree, so files like .hceignore, .gitignore, and .cursorignore are applied without passing ignoreFiles.";

export class ToolHandlers {
    private context: Context;
    private snapshotManager: SnapshotManager;
    private indexingStats: { indexedFiles: number; totalChunks: number } | null = null;
    private currentWorkspace: string;
    /**
     * Tracks active background indexing tasks per absolute codebase path so
     * clear_index can cancel and await them before dropping the collection.
     * Without this, a clear_index call returns "successfully cleared" while
     * the background task keeps embedding chunks and writing them into the
     * just-cleared collection (issue #199).
     */
    private indexingTasks: Map<string, { controller: AbortController; promise: Promise<void> }> = new Map();
    private indexingStateLocks: Map<string, Promise<void>> = new Map();

    constructor(context: Context, snapshotManager: SnapshotManager) {
        this.context = context;
        this.snapshotManager = snapshotManager;
        this.currentWorkspace = process.cwd();
        console.log(`[WORKSPACE] Current workspace: ${this.currentWorkspace}`);
    }

    private errorResponse(text: string) {
        return {
            content: [{
                type: "text",
                text
            }],
            isError: true
        };
    }

    private notIndexedResponse(absolutePath: string) {
        return this.errorResponse(`Error: Codebase '${absolutePath}' is not indexed. ${NOT_INDEXED_INDEXING_HINT}`);
    }

    private validateRequiredStringArgs(toolName: string, args: any, fields: string[]): { error: ReturnType<ToolHandlers["errorResponse"]> | null } {
        if (!args || typeof args !== "object" || Array.isArray(args)) {
            return {
                error: this.errorResponse(`Error: ${toolName} requires an argument object with ${fields.map((field) => `'${field}'`).join(", ")}.`)
            };
        }

        const missingFields = fields.filter((field) => typeof args[field] !== "string" || args[field].trim().length === 0);
        if (missingFields.length > 0) {
            return {
                error: this.errorResponse(`Error: Missing required argument(s) for ${toolName}: ${missingFields.map((field) => `'${field}'`).join(", ")}.`)
            };
        }

        return { error: null };
    }

    private validateOptionalStringArrayArgs(toolName: string, args: any, fields: string[]): { error: ReturnType<ToolHandlers["errorResponse"]> | null } {
        for (const field of fields) {
            const value = args?.[field];
            if (value === undefined) {
                continue;
            }
            if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
                return {
                    error: this.errorResponse(`Error: ${toolName} argument '${field}' must be an array of non-empty strings.`)
                };
            }
        }

        return { error: null };
    }

    private normalizeStringArray(value: unknown): string[] {
        if (!Array.isArray(value)) {
            return [];
        }

        return value
            .map((item) => typeof item === "string" ? item.trim() : "")
            .filter((item) => item.length > 0);
    }

    private normalizeOptionalSearchLimit(value: unknown): { limit?: number; error?: ReturnType<ToolHandlers["errorResponse"]> } {
        if (value === undefined || value === null) {
            return {};
        }

        if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
            return {
                error: this.errorResponse("Error: search_code argument 'limit' must be a positive number when provided.")
            };
        }

        return { limit: Math.floor(value) };
    }

    private normalizeOptionalSearchTargetRole(value: unknown): { targetRole?: SearchTargetRole; error?: ReturnType<ToolHandlers["errorResponse"]> } {
        if (value === undefined || value === null) {
            return {};
        }

        if (value === "implementation" || value === "test" || value === "docs" || value === "config" || value === "all") {
            return { targetRole: value };
        }

        return {
            error: this.errorResponse("Error: search_code argument 'targetRole' must be one of: implementation, test, docs, config, all.")
        };
    }

    private normalizeOptionalIncludeRelated(value: unknown): { includeRelated?: boolean; error?: ReturnType<ToolHandlers["errorResponse"]> } {
        if (value === undefined || value === null) {
            return {};
        }

        if (typeof value === "boolean") {
            return { includeRelated: value };
        }

        return {
            error: this.errorResponse("Error: search_code argument 'includeRelated' must be a boolean when provided.")
        };
    }

    private normalizeOptionalIncludeTraceEvidence(value: unknown): { includeTraceEvidence?: boolean; error?: ReturnType<ToolHandlers["errorResponse"]> } {
        if (value === undefined || value === null) {
            return {};
        }

        if (typeof value === "boolean") {
            return { includeTraceEvidence: value };
        }

        return {
            error: this.errorResponse("Error: search_code argument 'includeTraceEvidence' must be a boolean when provided.")
        };
    }

    private normalizeOptionalTraceNumber(toolName: string, field: string, value: unknown): { value?: number; error?: ReturnType<ToolHandlers["errorResponse"]> } {
        if (value === undefined || value === null) {
            return {};
        }

        if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
            return {
                error: this.errorResponse(`Error: ${toolName} argument '${field}' must be a positive number when provided.`)
            };
        }

        return { value: Math.floor(value) };
    }

    private normalizeOptionalTraceBoolean(toolName: string, field: string, value: unknown): { value?: boolean; error?: ReturnType<ToolHandlers["errorResponse"]> } {
        if (value === undefined || value === null) {
            return {};
        }

        if (typeof value !== "boolean") {
            return {
                error: this.errorResponse(`Error: ${toolName} argument '${field}' must be a boolean when provided.`)
            };
        }

        return { value };
    }

    private formatSearchResultLocation(result: any): { location: string; warning?: string } {
        if (this.hasValidLineRange(result)) {
            return {
                location: `${result.relativePath}:${result.startLine}-${result.endLine}`
            };
        }

        return {
            location: `${result.relativePath}:unknown`,
            warning: typeof result.lineRangeWarning === "string" && result.lineRangeWarning.length > 0
                ? result.lineRangeWarning
                : "line range unavailable; re-index this codebase to refresh line metadata."
        };
    }

    private hasValidLineRange(result: any): result is { relativePath: string; startLine: number; endLine: number } {
        return result?.lineRangeUnavailable !== true
            && typeof result?.startLine === "number"
            && typeof result?.endLine === "number"
            && Number.isInteger(result.startLine)
            && Number.isInteger(result.endLine)
            && result.startLine > 0
            && result.endLine >= result.startLine;
    }

    private formatSearchScoreReason(result: any): string | undefined {
        const scoreReasons = Array.isArray(result?.scoreReasons)
            ? result.scoreReasons.filter((reason: unknown): reason is string => typeof reason === "string" && reason.length > 0)
            : [];
        if (scoreReasons.length > 0) {
            return scoreReasons.join(", ");
        }

        return typeof result?.scoreReason === "string" && result.scoreReason.length > 0
            ? result.scoreReason
            : undefined;
    }

    private formatSearchResultGroupLabel(group: unknown): string {
        switch (group) {
            case "implementation":
                return "Implementation matches";
            case "entry_exports":
                return "Entry / exports";
            case "related_tests":
                return "Related tests";
            case "docs_config":
                return "Docs / config";
            default:
                return "Other matches";
        }
    }

    private formatSymbolTraceSection(title: string, entries: SymbolTraceEvidence[]): string {
        if (entries.length === 0) {
            return `## ${title}\n\nNone found.`;
        }

        return `## ${title}\n\n` + entries.map((entry, index) => {
            const matchedText = entry.matchedText ? `\n   Matched: ${entry.matchedText}` : "";
            const moduleLink = entry.resolvedPath ? `\n   Module: ${entry.moduleSpecifier ?? ""} -> ${entry.resolvedPath}` : "";
            const caller = entry.enclosingSymbol ? `\n   Caller: ${entry.enclosingSymbol}` : "";
            const callee = entry.callTarget ? `\n   Callee: ${entry.callTarget}` : "";
            return `${index + 1}. ${entry.relativePath}:${entry.line}${matchedText}${moduleLink}${caller}${callee}\n   ${entry.preview}`;
        }).join("\n\n");
    }

    private formatSearchTraceFollowup(
        result: any,
        resultIndex: number,
        codebasePath: string,
        contextText: string
    ): string {
        if (resultIndex >= SEARCH_TRACE_FOLLOWUP_RESULT_LIMIT || typeof result?.relativePath !== "string") {
            return "";
        }
        if (result?.resultGroup !== undefined && result.resultGroup !== "implementation" && result.resultGroup !== "entry_exports") {
            return "";
        }

        const symbols = this.extractTraceFollowupSymbols(contextText);
        if (symbols.length === 0) {
            return "";
        }

        const suggestions = symbols
            .slice(0, SEARCH_TRACE_FOLLOWUP_SYMBOL_LIMIT)
            .map((symbol) => `trace_symbol({ path: "${codebasePath}", symbol: "${symbol}", startPath: "${result.relativePath}" })`);

        return `   Structure follow-up: ${suggestions.join("; ")}\n`;
    }

    private async formatSearchTraceEvidence(
        result: any,
        resultIndex: number,
        codebasePath: string,
        contextText: string
    ): Promise<string> {
        if (resultIndex >= SEARCH_TRACE_EVIDENCE_RESULT_LIMIT || typeof result?.relativePath !== "string") {
            return "";
        }
        if (result?.resultGroup !== undefined && result.resultGroup !== "implementation" && result.resultGroup !== "entry_exports") {
            return "";
        }

        const symbols = this.extractTraceFollowupSymbols(contextText).slice(0, SEARCH_TRACE_EVIDENCE_SYMBOL_LIMIT);
        if (symbols.length === 0) {
            return "   Trace evidence: insufficient; no traceable implementation symbol found in this result.\n";
        }

        const traces: string[] = [];
        for (const symbol of symbols) {
            try {
                const trace = await this.context.traceSymbol(codebasePath, symbol, {
                    startPath: result.relativePath,
                    startLine: this.hasValidLineRange(result) ? result.startLine : undefined,
                    endLine: this.hasValidLineRange(result) ? result.endLine : undefined,
                    maxFiles: SEARCH_TRACE_EVIDENCE_MAX_FILES,
                    maxReferences: SEARCH_TRACE_EVIDENCE_MAX_REFERENCES,
                    includeTests: true
                });
                traces.push(this.formatCompactTraceEvidence(result, symbol, trace));
            } catch (error) {
                traces.push(`   Trace evidence (${symbol}): insufficient; trace failed: ${error instanceof Error ? error.message : String(error)}\n`);
            }
        }

        return traces.join("");
    }

    private formatCompactTraceEvidence(result: any, symbol: string, trace: SymbolTraceResult): string {
        const hasEvidence = trace.definitions.length > 0
            || trace.references.length > 0
            || trace.imports.length > 0
            || trace.exports.length > 0
            || trace.relatedTests.length > 0;
        const lines = [`   Trace evidence (${symbol}):`];

        if (!hasEvidence) {
            lines.push("      Evidence insufficient: no definitions, references, imports, exports, or related tests found.");
            return `${lines.join("\n")}\n`;
        }

        this.pushCompactEvidenceChainLine(lines, result, symbol, trace);
        this.pushCompactTraceLine(lines, "Owner definitions", trace.definitions);
        this.pushCompactTraceLine(lines, "Entry references", trace.references);
        this.pushCompactCallChainLine(lines, trace.references);
        const moduleLinks = [...trace.imports, ...trace.exports]
            .filter((entry) => entry.moduleSpecifier || entry.resolvedPath);
        this.pushCompactTraceLine(lines, "Module links", moduleLinks, true);
        this.pushCompactTraceLine(lines, "Related tests", trace.relatedTests);
        if (trace.truncated) {
            lines.push("      Warning: trace truncated by maxFiles or maxReferences.");
        }
        if (trace.warnings.length > 0) {
            lines.push(`      Warning: ${trace.warnings.slice(0, 2).join("; ")}`);
        }

        return `${lines.join("\n")}\n`;
    }

    private pushCompactEvidenceChainLine(lines: string[], result: any, symbol: string, trace: SymbolTraceResult): void {
        const steps: string[] = [];
        const seen = new Set<string>();
        const pushStep = (step: string | undefined) => {
            if (!step || seen.has(step)) {
                return;
            }
            seen.add(step);
            steps.push(step);
        };

        if (typeof result?.relativePath === "string") {
            const lineRange = this.hasValidLineRange(result)
                ? `:${result.startLine}-${result.endLine}`
                : "";
            pushStep(`entry ${result.relativePath}${lineRange}`);
        }

        const moduleLinks = [...trace.imports, ...trace.exports]
            .filter((entry) => entry.resolvedPath)
            .slice(0, 3);
        for (const entry of moduleLinks) {
            pushStep(`${entry.kind} ${entry.relativePath}:${entry.line} -> ${entry.resolvedPath}`);
        }

        const owner = trace.definitions[0];
        if (owner) {
            pushStep(`owner ${owner.relativePath}:${owner.line} ${symbol}`);
        }

        const localCall = trace.references.find((entry) => entry.enclosingSymbol && entry.callTarget);
        if (localCall) {
            pushStep(`call ${localCall.relativePath}:${localCall.line} ${localCall.enclosingSymbol} -> ${localCall.callTarget}`);
        } else if (trace.references[0]) {
            const reference = trace.references[0];
            pushStep(`reference ${reference.relativePath}:${reference.line}`);
        }

        if (steps.length > 1) {
            lines.push(`      Evidence chain: ${steps.join(" => ")}`);
        }
    }

    private pushCompactTraceLine(
        lines: string[],
        label: string,
        entries: SymbolTraceEvidence[],
        includeResolution: boolean = false
    ): void {
        if (entries.length === 0) {
            return;
        }

        const formatted = entries.slice(0, 3).map((entry) => {
            const resolved = includeResolution && entry.resolvedPath
                ? ` -> ${entry.resolvedPath}`
                : "";
            return `${entry.relativePath}:${entry.line}${resolved}`;
        }).join("; ");
        lines.push(`      ${label}: ${formatted}`);
    }

    private pushCompactCallChainLine(lines: string[], entries: SymbolTraceEvidence[]): void {
        const chains = entries
            .filter((entry) => entry.enclosingSymbol && entry.callTarget)
            .slice(0, 3)
            .map((entry) => `${entry.relativePath}:${entry.line} ${entry.enclosingSymbol} -> ${entry.callTarget}`);

        if (chains.length > 0) {
            lines.push(`      Call chain: ${chains.join("; ")}`);
        }
    }

    private extractTraceFollowupSymbols(content: string): string[] {
        const symbols = new Set<string>();
        const addSymbol = (value: string | undefined) => {
            if (!value || !/^[A-Z][A-Za-z0-9_$]*$/.test(value) || this.isUnhelpfulTraceSymbol(value)) {
                return;
            }
            symbols.add(value);
        };

        const patterns = [
            /@delegate\s+([A-Z][A-Za-z0-9_$]*)\b/g,
            /\b(?:new|extends|implements)\s+([A-Z][A-Za-z0-9_$]*)\b/g,
            /:\s*([A-Z][A-Za-z0-9_$]*)\b/g,
            /\bas\s+([A-Z][A-Za-z0-9_$]*)\b/g,
            /\b(?:class|interface|type|enum)\s+([A-Z][A-Za-z0-9_$]*)\b/g
        ];

        for (const pattern of patterns) {
            let match: RegExpExecArray | null;
            while ((match = pattern.exec(content)) !== null) {
                addSymbol(match[1]);
            }
        }

        for (const importMatch of content.matchAll(/\bimport\s*\{([^}]+)\}/g)) {
            for (const imported of importMatch[1].split(",")) {
                const name = imported.trim().split(/\s+as\s+/)[0]?.trim();
                addSymbol(name);
            }
        }

        for (const exportMatch of content.matchAll(/\bexport\s*\{([^}]+)\}/g)) {
            for (const exported of exportMatch[1].split(",")) {
                const name = exported.trim().split(/\s+as\s+/)[0]?.trim();
                addSymbol(name);
            }
        }

        return [...symbols];
    }

    private isUnhelpfulTraceSymbol(symbol: string): boolean {
        return new Set([
            "Array",
            "Boolean",
            "Date",
            "Error",
            "Map",
            "Number",
            "Object",
            "Promise",
            "Record",
            "Set",
            "String",
            "WeakMap",
            "WeakSet"
        ]).has(symbol);
    }

    private formatSearchResultContext(result: any, codebasePath: string): { context: string; source: string; warning?: string } {
        const fallbackContent = truncateContent(String(result?.content ?? ""), SEARCH_CONTEXT_MAX_CHARS);
        if (!this.hasValidLineRange(result)) {
            return {
                context: fallbackContent,
                source: "indexed chunk fallback"
            };
        }

        const resolvedPath = this.resolveResultSourcePath(codebasePath, result.relativePath);
        if (!resolvedPath) {
            return {
                context: fallbackContent,
                source: "indexed chunk fallback",
                warning: "source rehydrate skipped because the result path is outside the indexed codebase."
            };
        }

        try {
            const source = fs.readFileSync(resolvedPath, "utf-8");
            const lines = source.split(/\r?\n/);
            const contextStartLine = Math.max(1, result.startLine - SOURCE_CONTEXT_WINDOW_LINES);
            const contextEndLine = Math.min(lines.length, result.endLine + SOURCE_CONTEXT_WINDOW_LINES);

            if (contextStartLine > contextEndLine) {
                return {
                    context: fallbackContent,
                    source: "indexed chunk fallback",
                    warning: "source rehydrate failed because the indexed line range is outside the current source file."
                };
            }

            return {
                context: truncateContent(lines.slice(contextStartLine - 1, contextEndLine).join("\n"), SEARCH_CONTEXT_MAX_CHARS),
                source: `current source file, lines ${contextStartLine}-${contextEndLine}; indexed range ${result.startLine}-${result.endLine}`
            };
        } catch {
            return {
                context: fallbackContent,
                source: "indexed chunk fallback",
                warning: "source rehydrate failed; using indexed chunk fallback."
            };
        }
    }

    private resolveResultSourcePath(codebasePath: string, relativePath: unknown): string | null {
        if (typeof relativePath !== "string" || relativePath.trim().length === 0) {
            return null;
        }

        const resolvedPath = path.resolve(codebasePath, relativePath);
        const relativeToCodebase = path.relative(codebasePath, resolvedPath);
        if (relativeToCodebase.startsWith("..") || path.isAbsolute(relativeToCodebase)) {
            return null;
        }

        return resolvedPath;
    }

    private async resolveSearchResultLimit(explicitLimit: number | undefined, _codebasePath: string): Promise<number> {
        if (explicitLimit !== undefined) {
            return explicitLimit;
        }

        return DEFAULT_SEARCH_RESULT_LIMIT;
    }

    private isInteractiveIndexingEnabled(): boolean {
        return getBooleanFromConfig("interactiveIndexing", true);
    }

    private async withIndexingStateLock<T>(codebasePath: string, run: () => Promise<T>): Promise<T> {
        const previous = this.indexingStateLocks.get(codebasePath);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const chain = (previous ?? Promise.resolve()).catch(() => undefined).then(() => gate);

        this.indexingStateLocks.set(codebasePath, chain);
        await previous?.catch(() => undefined);

        try {
            return await run();
        } finally {
            release();
            if (this.indexingStateLocks.get(codebasePath) === chain) {
                this.indexingStateLocks.delete(codebasePath);
            }
        }
    }

    /**
     * Query Milvus for the real row count of a codebase's collection.
     * Returns null if the count cannot be determined — callers must NOT write a
     * snapshot entry in that case. Writing { indexedFiles: 0, totalChunks: 0,
     * status: 'completed' } for an unknown-state collection poisons the client:
     * the client treats 0/0 as "not indexed" and triggers force reindex, which
     * deletes real data and rewrites 0/0 — an infinite loop. See Issue #295.
     */
    private async queryIndexedFileCount(collectionName: string, rowCount: number): Promise<number | undefined> {
        try {
            const rows = await this.context.getVectorDatabase().query(collectionName, '', ['relativePath'], rowCount);
            const filePaths = new Set<string>();

            for (const row of rows) {
                if (typeof row.relativePath === 'string' && row.relativePath.length > 0) {
                    filePaths.add(row.relativePath);
                }
            }

            if (filePaths.size > 0) {
                return filePaths.size;
            }
        } catch (error) {
            console.warn(`[SNAPSHOT-RECOVERY] Failed to query distinct indexed files for '${collectionName}':`, error);
        }

        return undefined;
    }

    private async queryCollectionStats(codebasePath: string): Promise<{ indexedFiles: number; totalChunks: number; statsSource: 'collection_row_count' } | null> {
        try {
            const collectionName = this.context.getCollectionName(codebasePath);
            const rowCount = await this.context.getVectorDatabase().getCollectionRowCount(collectionName);
            if (rowCount < 0) {
                console.warn(`[SNAPSHOT-RECOVERY] Row count unknown for '${codebasePath}', skipping recovery write`);
                return null;
            }
            if (rowCount === 0) {
                console.warn(`[SNAPSHOT-RECOVERY] Collection '${collectionName}' truly empty — NOT writing recovered entry (would poison client)`);
                return null;
            }

            const indexedFiles = await this.queryIndexedFileCount(collectionName, rowCount);
            return { indexedFiles: indexedFiles ?? 0, totalChunks: rowCount, statsSource: 'collection_row_count' };
        } catch (error) {
            console.warn(`[SNAPSHOT-RECOVERY] Failed to query stats for '${codebasePath}':`, error);
            return null;
        }
    }

    private getMerkleTrackedFileCount(codebasePath: string): number | undefined {
        try {
            const normalizedPath = normalizeCodebaseIdentityPath(codebasePath);
            const hash = crypto.createHash('md5').update(normalizedPath).digest('hex');
            const snapshotPath = path.join(os.homedir(), '.hitmux-context-engine', 'merkle', `${hash}.json`);
            const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
            if (Array.isArray(snapshot.fileHashes)) {
                return snapshot.fileHashes.length;
            }
            if (snapshot.fileHashes && typeof snapshot.fileHashes === 'object') {
                return Object.keys(snapshot.fileHashes).length;
            }
        } catch {
            return undefined;
        }

        return undefined;
    }

    private hasRecoveredStats(codebasePath: string, info: CodebaseInfoIndexed): boolean {
        if (info.statsSource === 'collection_row_count') {
            return true;
        }

        const trackedFileCount = this.getMerkleTrackedFileCount(codebasePath);
        return trackedFileCount !== undefined
            && info.indexedFiles === info.totalChunks
            && trackedFileCount !== info.indexedFiles;
    }

    private formatIndexedStatistics(codebasePath: string, info: CodebaseInfoIndexed): string {
        if (this.hasRecoveredStats(codebasePath, info)) {
            if (info.statsSource === 'collection_row_count' && info.indexedFiles > 0) {
                return `${info.indexedFiles} files, ${info.totalChunks} chunks`;
            }

            const trackedFileCount = this.getMerkleTrackedFileCount(codebasePath);
            if (trackedFileCount !== undefined) {
                return `${trackedFileCount} files, ${info.totalChunks} chunks`;
            }

            return `file count unknown, ${info.totalChunks} chunks`;
        }

        return `${info.indexedFiles} files, ${info.totalChunks} chunks`;
    }

    /**
     * One-shot startup validation: find any legacy 0/0+completed entries on disk
     * (left over from old MCP versions, v1 snapshot migrations, or pre-fix recovery
     * paths) and either heal them with the real Milvus row count or remove them
     * if the underlying collection is empty/missing. See Issue #295.
     *
     * Safe to call multiple times but intended to run once per server start after
     * loadCodebaseSnapshot(). Errors are caught and logged; never throws.
     */
    public async validateLegacyZeroEntries(): Promise<void> {
        try {
            const indexedCodebases = this.snapshotManager.getIndexedCodebases();
            let healed = 0, removed = 0, skipped = 0, checked = 0;

            for (const codebasePath of indexedCodebases) {
                const info = this.snapshotManager.getCodebaseInfo(codebasePath);
                if (!info || info.status !== 'indexed') continue;
                // Only validate suspiciously-zero entries
                if (info.indexedFiles !== 0 || info.totalChunks !== 0) continue;

                checked++;
                const collectionName = this.context.getCollectionName(codebasePath);
                const vdb = this.context.getVectorDatabase();

                // First probe: does the collection even exist? A "no" here is
                // authoritative (permanent orphan), while a throw is most likely
                // transient (Milvus unreachable) — keep those two cases distinct
                // so we don't destroy real state on a network blip.
                let collectionExists: boolean;
                try {
                    collectionExists = await vdb.hasCollection(collectionName);
                } catch (err) {
                    console.warn(`[SNAPSHOT-VALIDATE] hasCollection failed for '${codebasePath}' (likely transient), skipping:`, err);
                    skipped++;
                    continue;
                }

                if (!collectionExists) {
                    // Permanent orphan — no matching Milvus collection, so the
                    // 0/0+completed snapshot entry is a pure phantom. Remove it.
                    this.snapshotManager.removeCodebaseCompletely(codebasePath);
                    removed++;
                    console.warn(`[SNAPSHOT-VALIDATE] Removed orphan 0/0 entry '${codebasePath}' — no matching Milvus collection`);
                    continue;
                }

                // Collection exists — get an accurate row count.
                let rowCount: number;
                try {
                    rowCount = await vdb.getCollectionRowCount(collectionName);
                } catch (err) {
                    console.warn(`[SNAPSHOT-VALIDATE] getCollectionRowCount failed for '${codebasePath}', skipping:`, err);
                    skipped++;
                    continue;
                }

                if (rowCount > 0) {
                    const indexedFiles = await this.queryIndexedFileCount(collectionName, rowCount);
                    this.snapshotManager.setCodebaseIndexed(codebasePath, {
                        indexedFiles: indexedFiles ?? 0,
                        totalChunks: rowCount,
                        status: 'completed' as const,
                        statsSource: 'collection_row_count' as const,
                    });
                    healed++;
                    console.log(`[SNAPSHOT-VALIDATE] Healed legacy 0/0 entry '${codebasePath}' → rows=${rowCount}`);
                } else if (rowCount === 0) {
                    // Collection exists but truly empty — the 0/0+completed entry
                    // is a phantom. Remove so the user must explicitly reindex.
                    this.snapshotManager.removeCodebaseCompletely(codebasePath);
                    removed++;
                    console.warn(`[SNAPSHOT-VALIDATE] Removed phantom 0/0 entry '${codebasePath}' — collection exists but empty`);
                } else {
                    // rowCount === -1 despite the collection existing: the count
                    // query failed after the existence probe succeeded. Treat as
                    // transient and leave the entry alone.
                    skipped++;
                    console.warn(`[SNAPSHOT-VALIDATE] Row count unavailable for existing collection '${codebasePath}', skipping`);
                }
            }

            if (healed > 0 || removed > 0) {
                this.snapshotManager.saveCodebaseSnapshot();
            }
            if (checked > 0) {
                console.log(`[SNAPSHOT-VALIDATE] Done — checked=${checked} healed=${healed} removed=${removed} skipped=${skipped}`);
            }
        } catch (error) {
            console.warn(`[SNAPSHOT-VALIDATE] Unexpected error during legacy 0/0 validation (non-fatal):`, error);
        }
    }

    /**
     * Validate every indexed snapshot entry against the backing vector DB.
     * A restart can load stale local state after the remote collection was
     * deleted; remove those entries before clients can report them searchable.
     */
    public async validateIndexedCollections(): Promise<void> {
        try {
            const indexedCodebases = this.snapshotManager.getIndexedCodebases();
            let removed = 0, skipped = 0, checked = 0;

            for (const codebasePath of indexedCodebases) {
                checked++;
                const collectionName = this.context.getCollectionName(codebasePath);
                let collectionExists: boolean;

                try {
                    collectionExists = await this.context.getVectorDatabase().hasCollection(collectionName);
                } catch (error) {
                    skipped++;
                    console.warn(`[SNAPSHOT-RECONCILE] hasCollection failed for '${codebasePath}' (leaving snapshot entry unchanged):`, error);
                    continue;
                }

                if (!collectionExists) {
                    this.snapshotManager.removeCodebaseCompletely(codebasePath);
                    removed++;
                    console.warn(`[SNAPSHOT-RECONCILE] Removed stale indexed entry '${codebasePath}' — collection '${collectionName}' is missing`);
                }
            }

            if (removed > 0) {
                this.snapshotManager.saveCodebaseSnapshot();
            }
            if (checked > 0) {
                console.log(`[SNAPSHOT-RECONCILE] Done — checked=${checked} removed=${removed} skipped=${skipped}`);
            }
        } catch (error) {
            console.warn(`[SNAPSHOT-RECONCILE] Unexpected error during indexed collection validation (non-fatal):`, error);
        }
    }

    /**
     * Sync indexed codebases from Zilliz Cloud collections
     * This method fetches all collections from the vector database,
     * extracts codebasePath from collection description (preferred) or falls back
     * to querying document metadata for old collections,
     * and updates the snapshot with discovered codebases.
     *
     * Logic: Compare mcp-codebase-snapshot.json with zilliz cloud collections
     * - If local snapshot has extra directories (not in cloud), remove them
     * - If local snapshot is missing directories (exist in cloud), ignore them
     */
    private async syncIndexedCodebasesFromCloud(): Promise<void> {
        try {
            console.log(`[SYNC-CLOUD] 🔄 Syncing indexed codebases from Zilliz Cloud...`);

            // Get all collections using the interface method
            const vectorDb = this.context.getVectorDatabase();

            // Use the new listCollections method from the interface
            const collections = await vectorDb.listCollections();

            console.log(`[SYNC-CLOUD] 📋 Found ${collections.length} collections in Zilliz Cloud`);

            if (collections.length === 0) {
                console.log(`[SYNC-CLOUD] ✅ No collections found in cloud. Skipping deletion of local codebases to avoid data loss from transient errors.`);
                return;
            }

            const cloudCodebases = new Set<string>();
            let codeCollectionsChecked = 0;
            let successfulExtractions = 0;

            // Check each collection for codebase path
            for (const collectionName of collections) {
                try {
                    // Skip collections that don't match the code_chunks pattern (support both legacy and new collections)
                    if (!collectionName.startsWith('code_chunks_') && !collectionName.startsWith('hybrid_code_chunks_')) {
                        console.log(`[SYNC-CLOUD] ⏭️  Skipping non-code collection: ${collectionName}`);
                        continue;
                    }

                    codeCollectionsChecked++;
                    console.log(`[SYNC-CLOUD] 🔍 Checking collection: ${collectionName}`);

                    // Try to extract codebasePath from collection description first (new format)
                    let extracted = false;
                    try {
                        const description = await vectorDb.getCollectionDescription(collectionName);
                        if (description && description.startsWith('codebasePath:')) {
                            const codebasePath = description.split(/\r?\n/, 1)[0].substring('codebasePath:'.length);
                            if (codebasePath.length > 0) {
                                console.log(`[SYNC-CLOUD] 📍 Found codebase path from description: ${codebasePath} in collection: ${collectionName}`);
                                cloudCodebases.add(codebasePath);
                                successfulExtractions++;
                                extracted = true;
                            }
                        }
                    } catch (descError: any) {
                        console.warn(`[SYNC-CLOUD] ⚠️  Failed to get description for collection ${collectionName}:`, descError.message || descError);
                    }

                    // Fallback: query document metadata for old collections without new description format
                    if (!extracted) {
                        console.log(`[SYNC-CLOUD] 🔄 Falling back to query-based extraction for collection: ${collectionName}`);
                        try {
                            const results = await vectorDb.query(
                                collectionName,
                                undefined as any, // Don't pass empty filter
                                ['metadata'], // Only fetch metadata field
                                1 // Only need one result to extract codebasePath
                            );

                            if (results && results.length > 0) {
                                const firstResult = results[0];
                                const metadataStr = firstResult.metadata;

                                if (metadataStr) {
                                    const metadata = JSON.parse(metadataStr);
                                    const codebasePath = metadata.codebasePath;

                                    if (codebasePath && typeof codebasePath === 'string') {
                                        console.log(`[SYNC-CLOUD] 📍 Found codebase path from query: ${codebasePath} in collection: ${collectionName}`);
                                        cloudCodebases.add(codebasePath);
                                        successfulExtractions++;
                                    } else {
                                        console.warn(`[SYNC-CLOUD] ⚠️  No codebasePath found in metadata for collection: ${collectionName}`);
                                    }
                                } else {
                                    console.warn(`[SYNC-CLOUD] ⚠️  No metadata found in collection: ${collectionName}`);
                                }
                            } else {
                                console.log(`[SYNC-CLOUD] ℹ️  Collection ${collectionName} is empty`);
                            }
                        } catch (queryError: any) {
                            console.warn(`[SYNC-CLOUD] ⚠️  Fallback query failed for collection ${collectionName}:`, queryError.message || queryError);
                        }
                    }
                } catch (collectionError: any) {
                    console.warn(`[SYNC-CLOUD] ⚠️  Error checking collection ${collectionName}:`, collectionError.message || collectionError);
                    // Continue with next collection
                }
            }

            console.log(`[SYNC-CLOUD] 📊 Found ${cloudCodebases.size} valid codebases in cloud (checked ${codeCollectionsChecked} code collections, ${successfulExtractions} successfully extracted)`);

            // Safety guard: if we checked code collections but none returned results,
            // treat this as an extraction failure rather than "cloud is empty".
            // This prevents deleting all local codebases due to transient errors.
            if (codeCollectionsChecked > 0 && successfulExtractions === 0) {
                console.warn(`[SYNC-CLOUD] ⚠️  All ${codeCollectionsChecked} code collection extractions failed. Skipping sync to avoid accidental deletion of local codebases.`);
                return;
            }

            // Get current local codebases
            const localCodebases = new Set(this.snapshotManager.getIndexedCodebases());
            console.log(`[SYNC-CLOUD] 📊 Found ${localCodebases.size} local codebases in snapshot`);

            let hasChanges = false;

            // Remove local codebases that don't exist in cloud
            for (const localCodebase of localCodebases) {
                if (!cloudCodebases.has(localCodebase)) {
                    this.snapshotManager.removeCodebaseCompletely(localCodebase);
                    hasChanges = true;

                    try {
                        await FileSynchronizer.deleteSnapshot(localCodebase);
                    } catch (error: any) {
                        console.warn(`[SYNC-CLOUD] ⚠️  Failed to delete local merkle snapshot for removed codebase '${localCodebase}':`, error?.message || error);
                    }

                    console.log(`[SYNC-CLOUD] ➖ Removed local codebase (not in cloud): ${localCodebase}`);
                }
            }

            // Add cloud codebases that are missing from local snapshot (recovery).
            // Query Milvus for the real row count — if unknown/empty, skip the write
            // so we don't persist a poisoning 0/0+completed entry (Issue #295).
            for (const cloudCodebase of cloudCodebases) {
                if (!localCodebases.has(cloudCodebase)) {
                    const indexingCodebase = this.snapshotManager.findIndexingCodebasePath(cloudCodebase);
                    if (indexingCodebase !== undefined) {
                        console.log(`[SYNC-CLOUD] ⏭️  Skipped recovery for ${cloudCodebase} because '${indexingCodebase}' is currently indexing`);
                        continue;
                    }

                    const stats = await this.queryCollectionStats(cloudCodebase);
                    if (stats) {
                        this.snapshotManager.setCodebaseIndexed(cloudCodebase, {
                            ...stats,
                            status: 'completed' as const
                        });
                        hasChanges = true;
                        console.log(`[SYNC-CLOUD] ➕ Recovered codebase from cloud: ${cloudCodebase} (rows=${stats.totalChunks})`);
                    } else {
                        console.log(`[SYNC-CLOUD] ⏭️  Skipped recovery for ${cloudCodebase} (row count unknown or zero)`);
                    }
                }
            }

            if (hasChanges) {
                this.snapshotManager.saveCodebaseSnapshot();
                console.log(`[SYNC-CLOUD] 💾 Updated snapshot to match cloud state`);
            } else {
                console.log(`[SYNC-CLOUD] ✅ Local snapshot already matches cloud state`);
            }

            console.log(`[SYNC-CLOUD] ✅ Cloud sync completed successfully`);
        } catch (error: any) {
            console.error(`[SYNC-CLOUD] ❌ Error syncing codebases from cloud:`, error.message || error);
            // Don't throw - this is not critical for the main functionality
        }
    }

    public async handleIndexCodebase(args: any): Promise<any> {
        const validation = this.validateRequiredStringArgs("index_codebase", args, ["path"]);
        if (validation.error) {
            return validation.error;
        }
        const arrayValidation = this.validateOptionalStringArrayArgs("index_codebase", args, ["customExtensions", "ignorePatterns", "ignoreFiles"]);
        if (arrayValidation.error) {
            return arrayValidation.error;
        }

        const { path: codebasePath, force, splitter, maxDepth, dryRun, incremental } = args;
        const forceReindex = force || false;
        const incrementalIndex = incremental === true;
        const splitterWasProvided = typeof splitter === "string";
        const requestedSplitter = splitter || 'ast'; // Default to AST
        const customFileExtensions = this.normalizeStringArray(args.customExtensions);
        const customIgnorePatterns = this.normalizeStringArray(args.ignorePatterns);
        const customIgnoreFiles = this.normalizeStringArray(args.ignoreFiles);
        const customFileExtensionsProvided = Array.isArray(args.customExtensions);
        const customIgnorePatternsProvided = Array.isArray(args.ignorePatterns);
        const customIgnoreFilesProvided = Array.isArray(args.ignoreFiles);
        const requestMaxDepth = Number.isFinite(maxDepth) && maxDepth >= 0
            ? Math.floor(maxDepth)
            : undefined;
        const requestMaxDepthProvided = requestMaxDepth !== undefined;

        try {
            if (incrementalIndex && forceReindex) {
                return this.errorResponse("Error: index_codebase arguments 'incremental' and 'force' are mutually exclusive. Use incremental=true for manual change sync, or force=true for full re-index.");
            }
            if (incrementalIndex && dryRun === true) {
                return this.errorResponse("Error: index_codebase incremental=true cannot be combined with dryRun=true.");
            }

            // Validate splitter parameter
            if (!isRequestSplitterType(requestedSplitter)) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Invalid splitter type '${requestedSplitter}'. Must be 'ast' or 'langchain'.`
                    }],
                    isError: true
                };
            }
            const splitterType: RequestSplitterType = requestedSplitter;
            const indexOptions: CodebaseIndexOptions = {
                requestSplitter: splitterType,
                requestCustomExtensions: customFileExtensions,
                requestIgnorePatterns: customIgnorePatterns,
                requestIgnoreFiles: customIgnoreFiles,
                requestMaxDepth
            };
            // Force absolute path resolution - warn if relative path provided
            const absolutePath = ensureAbsolutePath(codebasePath);

            // Validate path exists
            if (!fs.existsSync(absolutePath)) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' does not exist. Original input: '${codebasePath}'`
                    }],
                    isError: true
                };
            }

            // Check if it's a directory
            const stat = fs.statSync(absolutePath);
            if (!stat.isDirectory()) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' is not a directory`
                    }],
                    isError: true
                };
            }

            if (dryRun === true) {
                const preview = await this.context.previewIndexableFiles(
                    absolutePath,
                    customIgnorePatterns,
                    customFileExtensions,
                    {
                        additionalIgnoreFiles: customIgnoreFiles,
                        maxDepth: requestMaxDepth
                    }
                );
                const pathInfo = codebasePath !== absolutePath
                    ? `\nNote: Input path '${codebasePath}' was resolved to absolute path '${absolutePath}'`
                    : '';
                const sampleText = preview.files.length > 0
                    ? preview.files.map((file: string, index: number) => `${index + 1}. ${file}`).join('\n')
                    : 'No files matched the current indexing rules.';
                const truncatedInfo = preview.totalFiles > preview.files.length
                    ? `\nShowing first ${preview.files.length} of ${preview.totalFiles} file(s).`
                    : '';

                return {
                    content: [{
                        type: "text",
                        text: `Dry run for codebase '${absolutePath}'.${pathInfo}\nMatched ${preview.totalFiles} file(s).${truncatedInfo}\n\n${sampleText}`
                    }]
                };
            }

            if (!this.isInteractiveIndexingEnabled()) {
                return {
                    content: [{
                        type: "text",
                        text: "Error: Interactive indexing is disabled by config.interactiveIndexing=false. Run index_codebase with dryRun=true to inspect matching files."
                    }],
                    isError: true
                };
            }

            // Sync indexed codebases from cloud first
            await this.syncIndexedCodebasesFromCloud();

            return await this.withIndexingStateLock(absolutePath, async () => {
                if (this.indexingTasks.has(absolutePath)) {
                    return {
                        content: [{
                            type: "text",
                            text: `Codebase '${absolutePath}' is already being indexed in the background. Please wait for completion.`
                        }],
                        isError: true
                    };
                }

            // Check if already indexing
            if (this.snapshotManager.getIndexingCodebases().includes(absolutePath)) {
                if (forceReindex) {
                    console.log(`[FORCE-REINDEX] Clearing stale indexing state for '${absolutePath}'`);
                    this.snapshotManager.removeCodebaseCompletely(absolutePath);
                    this.snapshotManager.saveCodebaseSnapshot();
                } else {
                    return {
                        content: [{
                            type: "text",
                            text: `Codebase '${absolutePath}' is already being indexed in the background. Please wait for completion.`
                        }],
                        isError: true
                    };
                }
            }

            //Check if the snapshot and cloud index are in sync
            const snapshotHasIndex = this.snapshotManager.getIndexedCodebases().includes(absolutePath);
            const vectorDbHasIndex = await this.context.hasIndex(absolutePath);
            if (snapshotHasIndex !== vectorDbHasIndex) {
                if (vectorDbHasIndex && !snapshotHasIndex) {
                    // Query Milvus for real row count. If unknown/empty, log and move on
                    // without writing 0/0+completed (which would trigger the force-reindex
                    // loop in Issue #295). The user is about to (re)index anyway.
                    const stats = await this.queryCollectionStats(absolutePath);
                    if (stats) {
                        console.warn(`[INDEX-VALIDATION] Recovering missing snapshot for '${absolutePath}' (rows=${stats.totalChunks})`);
                        this.snapshotManager.setCodebaseIndexed(absolutePath, { ...stats, status: 'completed' as const });
                        this.snapshotManager.saveCodebaseSnapshot();
                    } else {
                        console.warn(`[INDEX-VALIDATION] VectorDB reports index for '${absolutePath}' but row count unknown/zero — not writing snapshot entry`);
                    }
                } else if (!vectorDbHasIndex && snapshotHasIndex) {
                    console.warn(`[INDEX-VALIDATION] Clearing stale snapshot for '${absolutePath}'`);
                    this.snapshotManager.removeCodebaseCompletely(absolutePath);
                    this.snapshotManager.saveCodebaseSnapshot();
                }
            }

            if (incrementalIndex) {
                return await this.handleManualIncrementalIndexing(
                    absolutePath,
                    codebasePath,
                    splitterType,
                    {
                        splitterWasProvided,
                        customFileExtensions,
                        customIgnorePatterns,
                        customIgnoreFiles,
                        customFileExtensionsProvided,
                        customIgnorePatternsProvided,
                        customIgnoreFilesProvided,
                        requestMaxDepth,
                        requestMaxDepthProvided
                    }
                );
            }

            // Check if already indexed (unless force is true)
            if (!forceReindex && this.snapshotManager.getIndexedCodebases().includes(absolutePath)) {
                return {
                    content: [{
                        type: "text",
                        text: `Codebase '${absolutePath}' is already indexed. Use incremental=true to manually sync changed files, or force=true to full re-index.`
                    }],
                    isError: true
                };
            }

            // If force reindex and codebase is already indexed, remove it
            if (forceReindex) {
                this.snapshotManager.removeCodebaseCompletely(absolutePath);
                this.snapshotManager.saveCodebaseSnapshot();
                if (await this.context.hasIndex(absolutePath)) {
                    console.log(`[FORCE-REINDEX] 🔄 Clearing index for '${absolutePath}'`);
                    await this.context.clearIndex(absolutePath);
                }
            }

            // CRITICAL: Pre-index collection creation validation
            try {
                console.log(`[INDEX-VALIDATION] 🔍 Validating collection creation capability`);
                const canCreateCollection = await this.context.getVectorDatabase().checkCollectionLimit();

                if (!canCreateCollection) {
                    console.error(`[INDEX-VALIDATION] ❌ Collection limit validation failed: ${absolutePath}`);

                    // CRITICAL: Immediately return the COLLECTION_LIMIT_MESSAGE to MCP client
                    return {
                        content: [{
                            type: "text",
                            text: COLLECTION_LIMIT_MESSAGE
                        }],
                        isError: true
                    };
                }

                console.log(`[INDEX-VALIDATION] ✅  Collection creation validation completed`);
            } catch (validationError: any) {
                // Handle other collection creation errors
                console.error(`[INDEX-VALIDATION] ❌ Collection creation validation failed:`, validationError);
                return {
                    content: [{
                        type: "text",
                        text: `Error validating collection creation: ${validationError.message || validationError}`
                    }],
                    isError: true
                };
            }

            if (customFileExtensions.length > 0) {
                console.log(`[CUSTOM-EXTENSIONS] Using ${customFileExtensions.length} request-scoped custom extensions: ${customFileExtensions.join(', ')}`);
            }

            // Check current status and log if retrying after failure
            const currentStatus = this.snapshotManager.getCodebaseStatus(absolutePath);
            if (currentStatus === 'indexfailed') {
                const failedInfo = this.snapshotManager.getCodebaseInfo(absolutePath) as any;
                console.log(`[BACKGROUND-INDEX] Retrying indexing for previously failed codebase. Previous error: ${failedInfo?.errorMessage || 'Unknown error'}`);
            }

            // Set to indexing status and save snapshot immediately
            this.snapshotManager.setCodebaseIndexing(absolutePath, 0, indexOptions);
            this.snapshotManager.saveCodebaseSnapshot();

            // Track the codebase path for syncing
            trackCodebasePath(absolutePath);

            // Start background indexing - now safe to proceed.
            // Track the controller + promise so clear_index can cancel and
            // await us before dropping the underlying collection.
            const controller = new AbortController();
            const promise = this.startBackgroundIndexing(
                absolutePath,
                forceReindex,
                splitterType,
                customIgnorePatterns,
                customFileExtensions,
                customIgnoreFiles,
                requestMaxDepth,
                indexOptions,
                controller.signal
            ).finally(() => {
                // Only clear the entry if it still points at this run — a
                // concurrent re-index may have replaced us.
                const current = this.indexingTasks.get(absolutePath);
                if (current && current.controller === controller) {
                    this.indexingTasks.delete(absolutePath);
                }
            });
            this.indexingTasks.set(absolutePath, { controller, promise });

            const pathInfo = codebasePath !== absolutePath
                ? `\nNote: Input path '${codebasePath}' was resolved to absolute path '${absolutePath}'`
                : '';

            const extensionInfo = customFileExtensions.length > 0
                ? `\nUsing ${customFileExtensions.length} custom extensions: ${customFileExtensions.join(', ')}`
                : '';

            const ignoreInfo = customIgnorePatterns.length > 0
                ? `\nUsing ${customIgnorePatterns.length} custom ignore patterns: ${customIgnorePatterns.join(', ')}`
                : '';
            const ignoreFilesInfo = customIgnoreFiles.length > 0
                ? `\nUsing ${customIgnoreFiles.length} custom ignore files: ${customIgnoreFiles.join(', ')}`
                : '';
            const maxDepthInfo = requestMaxDepth !== undefined
                ? `\nLimiting traversal to maxDepth=${requestMaxDepth}`
                : '';

            return {
                content: [{
                    type: "text",
                    text: `Started background indexing for codebase '${absolutePath}' using ${splitterType.toUpperCase()} splitter.${pathInfo}${extensionInfo}${ignoreInfo}${ignoreFilesInfo}${maxDepthInfo}\n\nIndexing is running in the background. You can search the codebase while indexing is in progress, but results may be incomplete until indexing completes.`
                }]
            };
            });

        } catch (error: any) {
            // Enhanced error handling to prevent MCP service crash
            console.error('Error in handleIndexCodebase:', error);

            // Ensure we always return a proper MCP response, never throw
            return {
                content: [{
                    type: "text",
                    text: `Error starting indexing: ${error.message || error}`
                }],
                isError: true
            };
        }
    }

    private async handleManualIncrementalIndexing(
        absolutePath: string,
        originalPath: string,
        requestedSplitter: RequestSplitterType,
        options: {
            splitterWasProvided: boolean;
            customFileExtensions: string[];
            customIgnorePatterns: string[];
            customIgnoreFiles: string[];
            customFileExtensionsProvided: boolean;
            customIgnorePatternsProvided: boolean;
            customIgnoreFilesProvided: boolean;
            requestMaxDepth?: number;
            requestMaxDepthProvided: boolean;
        }
    ): Promise<any> {
        const info = this.snapshotManager.getCodebaseInfo(absolutePath);
        if (!info || info.status !== 'indexed') {
            return this.notIndexedResponse(absolutePath);
        }

        const splitterType = options.splitterWasProvided
            ? requestedSplitter
            : resolveRequestSplitterType(info.requestSplitter);
        const ignorePatterns = options.customIgnorePatternsProvided
            ? options.customIgnorePatterns
            : info.requestIgnorePatterns || [];
        const customExtensions = options.customFileExtensionsProvided
            ? options.customFileExtensions
            : info.requestCustomExtensions || [];
        const ignoreFiles = options.customIgnoreFilesProvided
            ? options.customIgnoreFiles
            : info.requestIgnoreFiles || [];
        const maxDepth = options.requestMaxDepthProvided
            ? options.requestMaxDepth
            : info.requestMaxDepth;

        const stats = await this.context.reindexByChange(
            absolutePath,
            undefined,
            ignorePatterns,
            customExtensions,
            createRequestSplitter(splitterType),
            ignoreFiles,
            maxDepth,
            { skipEffectiveLineLimit: true }
        );

        this.snapshotManager.clearCodebaseSyncWarning(absolutePath);
        this.snapshotManager.saveCodebaseSnapshot();

        const pathInfo = originalPath !== absolutePath
            ? `\nNote: Input path '${originalPath}' was resolved to absolute path '${absolutePath}'`
            : '';
        const optionInfo = [
            `splitter=${splitterType}`,
            customExtensions.length > 0 ? `customExtensions=${customExtensions.join(', ')}` : null,
            ignorePatterns.length > 0 ? `ignorePatterns=${ignorePatterns.join(', ')}` : null,
            ignoreFiles.length > 0 ? `ignoreFiles=${ignoreFiles.join(', ')}` : null,
            maxDepth !== undefined ? `maxDepth=${maxDepth}` : null
        ].filter((item): item is string => item !== null).join('; ');

        return {
            content: [{
                type: "text",
                text: `Manual incremental indexing completed for '${absolutePath}'.${pathInfo}\nChanges: Added ${stats.added}, Removed ${stats.removed}, Modified ${stats.modified}.\nOptions: ${optionInfo}`
            }]
        };
    }

    private async startBackgroundIndexing(
        codebasePath: string,
        forceReindex: boolean,
        splitterType: RequestSplitterType,
        customIgnorePatterns: string[] = [],
        customFileExtensions: string[] = [],
        customIgnoreFiles: string[] = [],
        requestMaxDepth?: number,
        indexOptions?: CodebaseIndexOptions,
        signal?: AbortSignal
    ): Promise<void> {
        const absolutePath = codebasePath;
        let lastSaveTime = 0; // Track last save timestamp

        try {
            console.log(`[BACKGROUND-INDEX] Starting background indexing for: ${absolutePath}`);

            // Note: If force reindex, collection was already cleared during validation phase
            if (forceReindex) {
                console.log(`[BACKGROUND-INDEX] ℹ️  Force reindex mode - collection was already cleared during validation`);
            }

            const requestSplitter = createRequestSplitter(splitterType);

            // Load ignore patterns from files first (including .ignore, .gitignore, etc.)
            // and merge them with this request's custom ignore patterns without
            // relying on shared Context state for this background indexing task.
            const ignorePatterns = await this.context.getEffectiveIgnorePatterns(absolutePath, customIgnorePatterns, customIgnoreFiles);
            const supportedExtensions = this.context.getEffectiveSupportedExtensions(customFileExtensions);

            // Initialize file synchronizer with proper ignore patterns (including project-specific patterns)
            console.log(`[BACKGROUND-INDEX] Using ignore patterns: ${ignorePatterns.join(', ')}`);
            if (customFileExtensions.length > 0) {
                console.log(`[BACKGROUND-INDEX] Using ${customFileExtensions.length} request-scoped custom extensions: ${customFileExtensions.join(', ')}`);
            }
            if (customIgnoreFiles.length > 0) {
                console.log(`[BACKGROUND-INDEX] Using ${customIgnoreFiles.length} request-scoped ignore files: ${customIgnoreFiles.join(', ')}`);
            }
            if (requestMaxDepth !== undefined) {
                console.log(`[BACKGROUND-INDEX] Limiting traversal to maxDepth=${requestMaxDepth}`);
            }
            const synchronizer = new FileSynchronizer(absolutePath, ignorePatterns, supportedExtensions, { maxDepth: requestMaxDepth });
            await synchronizer.initialize();

            // Store synchronizer in the context (let context manage collection names)
            await this.context.getPreparedCollection(absolutePath);
            const collectionName = this.context.getCollectionName(absolutePath);
            this.context.setSynchronizer(collectionName, synchronizer);

            console.log(`[BACKGROUND-INDEX] Starting indexing with ${splitterType} splitter for: ${absolutePath}`);

            // Log embedding provider information before indexing
            const embeddingProvider = this.context.getEmbedding();
            console.log(`[BACKGROUND-INDEX] 🧠 Using embedding provider: ${embeddingProvider.getProvider()} with dimension: ${embeddingProvider.getDimension()}`);

            // Start indexing with the appropriate context and progress tracking
            console.log(`[BACKGROUND-INDEX] 🚀 Beginning codebase indexing process...`);
            const stats = await this.context.indexCodebase(absolutePath, (progress) => {
                // Update progress in snapshot manager using new method
                this.snapshotManager.setCodebaseIndexing(absolutePath, progress.percentage);

                // Save snapshot periodically (every 2 seconds to avoid too frequent saves)
                const currentTime = Date.now();
                if (currentTime - lastSaveTime >= 2000) { // 2 seconds = 2000ms
                    this.snapshotManager.saveCodebaseSnapshot();
                    lastSaveTime = currentTime;
                    console.log(`[BACKGROUND-INDEX] 💾 Saved progress snapshot at ${progress.percentage.toFixed(1)}%`);
                }

                console.log(`[BACKGROUND-INDEX] Progress: ${progress.phase} - ${progress.percentage}% (${progress.current}/${progress.total})`);
            }, false, customIgnorePatterns, customFileExtensions, requestSplitter, signal, {
                additionalIgnoreFiles: customIgnoreFiles,
                maxDepth: requestMaxDepth
            });
            console.log(`[BACKGROUND-INDEX] ✅ Indexing completed successfully! Files: ${stats.indexedFiles}, Chunks: ${stats.totalChunks}`);

            // Set codebase to indexed status with complete statistics
            this.snapshotManager.setCodebaseIndexed(absolutePath, stats, indexOptions);
            this.indexingStats = { indexedFiles: stats.indexedFiles, totalChunks: stats.totalChunks };

            // Save snapshot after updating codebase lists
            this.snapshotManager.saveCodebaseSnapshot();

            let message = `Background indexing completed for '${absolutePath}' using ${splitterType.toUpperCase()} splitter.\nIndexed ${stats.indexedFiles} files, ${stats.totalChunks} chunks.`;
            if (stats.status === 'limit_reached') {
                message += `\n⚠️  Warning: Indexing stopped because the chunk limit (450,000) was reached. The index may be incomplete.`;
            }

            console.log(`[BACKGROUND-INDEX] ${message}`);

        } catch (error: any) {
            // Cooperative cancel from clear_index — clear_index is responsible
            // for tearing down the snapshot/collection right after, so do not
            // overwrite the snapshot with an "indexfailed" entry that would
            // race the clear and leave a tombstone behind.
            if (error instanceof IndexAbortError) {
                console.log(`[BACKGROUND-INDEX] Indexing for ${absolutePath} was cancelled: ${error.message}`);
                return;
            }

            console.error(`[BACKGROUND-INDEX] Error during indexing for ${absolutePath}:`, error);

            // Get the last attempted progress
            const lastProgress = this.snapshotManager.getIndexingProgress(absolutePath);

            // Set codebase to failed status with error information
            const errorMessage = error.message || String(error);
            this.snapshotManager.setCodebaseIndexFailed(absolutePath, errorMessage, lastProgress, indexOptions);
            this.snapshotManager.saveCodebaseSnapshot();

            // Log error but don't crash MCP service - indexing errors are handled gracefully
            console.error(`[BACKGROUND-INDEX] Indexing failed for ${absolutePath}: ${errorMessage}`);
        }
    }

    public async handleTraceSymbol(args: any): Promise<any> {
        const validation = this.validateRequiredStringArgs("trace_symbol", args, ["path", "symbol"]);
        if (validation.error) {
            return validation.error;
        }

        const { path: codebasePath, symbol, startPath, startLine, endLine, maxFiles, maxReferences, includeTests } = args;
        if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(symbol.trim())) {
            return this.errorResponse("Error: trace_symbol argument 'symbol' must be a single identifier.");
        }
        if (startPath !== undefined && (typeof startPath !== "string" || startPath.trim().length === 0)) {
            return this.errorResponse("Error: trace_symbol argument 'startPath' must be a non-empty string when provided.");
        }
        const normalizedStartLine = this.normalizeOptionalTraceNumber("trace_symbol", "startLine", startLine);
        if (normalizedStartLine.error) {
            return normalizedStartLine.error;
        }
        const normalizedEndLine = this.normalizeOptionalTraceNumber("trace_symbol", "endLine", endLine);
        if (normalizedEndLine.error) {
            return normalizedEndLine.error;
        }
        if (normalizedStartLine.value !== undefined && normalizedEndLine.value !== undefined && normalizedEndLine.value < normalizedStartLine.value) {
            return this.errorResponse("Error: trace_symbol argument 'endLine' must be greater than or equal to 'startLine'.");
        }

        const normalizedMaxFiles = this.normalizeOptionalTraceNumber("trace_symbol", "maxFiles", maxFiles);
        if (normalizedMaxFiles.error) {
            return normalizedMaxFiles.error;
        }
        const normalizedMaxReferences = this.normalizeOptionalTraceNumber("trace_symbol", "maxReferences", maxReferences);
        if (normalizedMaxReferences.error) {
            return normalizedMaxReferences.error;
        }
        const normalizedIncludeTests = this.normalizeOptionalTraceBoolean("trace_symbol", "includeTests", includeTests);
        if (normalizedIncludeTests.error) {
            return normalizedIncludeTests.error;
        }

        try {
            const absolutePath = ensureAbsolutePath(codebasePath);
            if (!fs.existsSync(absolutePath)) {
                return this.errorResponse(`Error: Path '${absolutePath}' does not exist. Original input: '${codebasePath}'`);
            }

            const stat = fs.statSync(absolutePath);
            if (!stat.isDirectory()) {
                return this.errorResponse(`Error: Path '${absolutePath}' is not a directory`);
            }

            trackCodebasePath(absolutePath);

            const trace = await this.context.traceSymbol(absolutePath, symbol.trim(), {
                startPath: typeof startPath === "string" ? startPath.trim() : undefined,
                startLine: normalizedStartLine.value,
                endLine: normalizedEndLine.value,
                maxFiles: normalizedMaxFiles.value,
                maxReferences: normalizedMaxReferences.value,
                includeTests: normalizedIncludeTests.value
            });

            const sections = [
                this.formatSymbolTraceSection("Definitions", trace.definitions),
                this.formatSymbolTraceSection("References", trace.references),
                this.formatSymbolTraceSection("Imports", trace.imports),
                this.formatSymbolTraceSection("Exports", trace.exports),
                this.formatSymbolTraceSection("Related tests", trace.relatedTests)
            ];
            const warnings = trace.warnings.length > 0
                ? `\n\nWarnings:\n${trace.warnings.map((warning: string) => `- ${warning}`).join("\n")}`
                : "";
            const truncated = trace.truncated ? "\nTrace truncated by maxFiles or maxReferences." : "";

            return {
                content: [{
                    type: "text",
                    text: `Trace for symbol '${trace.symbol}' in codebase '${trace.codebasePath}'. Scanned ${trace.scannedFiles} files.${truncated}\n\n${sections.join("\n\n")}${warnings}`
                }]
            };
        } catch (error) {
            return this.errorResponse(`Error tracing symbol: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    public async handleSearchCode(args: any): Promise<any> {
        const validation = this.validateRequiredStringArgs("search_code", args, ["path", "query"]);
        if (validation.error) {
            return validation.error;
        }

        const { path: codebasePath, query, limit, extensionFilter, targetRole, includeRelated, includeTraceEvidence } = args;
        const normalizedLimit = this.normalizeOptionalSearchLimit(limit);
        if (normalizedLimit.error) {
            return normalizedLimit.error;
        }
        const normalizedTargetRole = this.normalizeOptionalSearchTargetRole(targetRole);
        if (normalizedTargetRole.error) {
            return normalizedTargetRole.error;
        }
        const normalizedIncludeRelated = this.normalizeOptionalIncludeRelated(includeRelated);
        if (normalizedIncludeRelated.error) {
            return normalizedIncludeRelated.error;
        }
        const normalizedIncludeTraceEvidence = this.normalizeOptionalIncludeTraceEvidence(includeTraceEvidence);
        if (normalizedIncludeTraceEvidence.error) {
            return normalizedIncludeTraceEvidence.error;
        }

        try {
            // Sync indexed codebases from cloud first
            await this.syncIndexedCodebasesFromCloud();

            // Force absolute path resolution - warn if relative path provided
            const absolutePath = ensureAbsolutePath(codebasePath);

            // Validate path exists
            if (!fs.existsSync(absolutePath)) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' does not exist. Original input: '${codebasePath}'`
                    }],
                    isError: true
                };
            }

            // Check if it's a directory
            const stat = fs.statSync(absolutePath);
            if (!stat.isDirectory()) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' is not a directory`
                    }],
                    isError: true
                };
            }

            trackCodebasePath(absolutePath);

            // Check if this codebase is indexed or being indexed
            const indexedCodebasePath = this.snapshotManager.findIndexedCodebasePath(absolutePath);
            const indexingCodebasePath = this.snapshotManager.findIndexingCodebasePath(absolutePath);
            const matchedCodebase = [indexedCodebasePath, indexingCodebasePath]
                .filter((codebase): codebase is string => codebase !== undefined)
                .sort((a, b) => b.length - a.length)[0];
            let searchCodebasePath = matchedCodebase || absolutePath;
            let isIndexed = indexedCodebasePath === searchCodebasePath;
            const isIndexing = indexingCodebasePath === searchCodebasePath;

            if (!isIndexed && !isIndexing) {
                // Fallback: check VectorDB directly in case snapshot is out of sync.
                // Only recover the snapshot when we can confirm a real row count —
                // writing 0/0+completed for an unverifiable collection poisons the
                // client into a force-reindex loop (Issue #295).
                const hasVectorIndex = await this.context.hasIndex(absolutePath);
                if (hasVectorIndex) {
                    const stats = await this.queryCollectionStats(absolutePath);
                    if (stats) {
                        console.warn(`[SEARCH] Snapshot missing but VectorDB has index for '${absolutePath}', recovering snapshot (rows=${stats.totalChunks})`);
                        this.snapshotManager.setCodebaseIndexed(absolutePath, { ...stats, status: 'completed' as const });
                        this.snapshotManager.saveCodebaseSnapshot();
                        searchCodebasePath = absolutePath;
                        isIndexed = true;
                        // Continue with search (don't return error)
                    } else {
                        return this.notIndexedResponse(absolutePath);
                    }
                } else {
                    return this.notIndexedResponse(absolutePath);
                }
            }

            // Show indexing status if codebase is being indexed
            let indexingStatusMessage = '';
            if (isIndexing) {
                indexingStatusMessage = `\n⚠️  **Indexing in Progress**: This codebase is currently being indexed in the background. Search results may be incomplete until indexing completes.`;
            }

            console.log(`[SEARCH] Searching in codebase: ${searchCodebasePath}`);
            console.log(`[SEARCH] Query: "${query}"`);
            console.log(`[SEARCH] Indexing status: ${isIndexing ? 'In Progress' : 'Completed'}`);

            // Log embedding provider information before search
            const embeddingProvider = this.context.getEmbedding();
            console.log(`[SEARCH] 🧠 Using embedding provider: ${embeddingProvider.getProvider()} for search`);
            console.log(`[SEARCH] 🔍 Generating embeddings for query using ${embeddingProvider.getProvider()}...`);

            // Build filter expression from extensionFilter list
            let filterExpr: string | undefined = undefined;
            if (Array.isArray(extensionFilter) && extensionFilter.length > 0) {
                const cleaned = extensionFilter
                    .filter((v: any) => typeof v === 'string')
                    .map((v: string) => v.trim())
                    .filter((v: string) => v.length > 0);
                const invalid = cleaned.filter((e: string) => !(e.startsWith('.') && e.length > 1 && !/\s/.test(e)));
                if (invalid.length > 0) {
                    return {
                        content: [{ type: 'text', text: `Error: Invalid file extensions in extensionFilter: ${JSON.stringify(invalid)}. Use proper extensions like '.ts', '.py'.` }],
                        isError: true
                    };
                }
                const quoted = cleaned.map((e: string) => `'${e}'`).join(', ');
                filterExpr = `fileExtension in [${quoted}]`;
            }

            const resultLimit = await this.resolveSearchResultLimit(normalizedLimit.limit, searchCodebasePath);
            const filenameQueryStatus = await analyzeFilenameLikeQuery({
                query,
                codebasePath: searchCodebasePath,
                getCollectionName: () => this.context.getCollectionName(searchCodebasePath),
                getVectorDatabase: () => this.context.getVectorDatabase()
            });

            // Search in the specified codebase
            const searchResults = await this.context.semanticSearch(
                searchCodebasePath,
                query,
                resultLimit,
                0.3,
                filterExpr,
                {
                    targetRole: normalizedTargetRole.targetRole,
                    includeRelated: normalizedIncludeRelated.includeRelated
                }
            );

            console.log(`[SEARCH] ✅ Search completed! Found ${searchResults.length} results using ${embeddingProvider.getProvider()} embeddings`);

            if (searchResults.length === 0) {
                // Check if collection was lost (indexed locally but missing in Milvus)
                if (isIndexed && !isIndexing) {
                    const collectionName = this.context.getCollectionName(searchCodebasePath);
                    const hasCollection = await this.context.getVectorDatabase().hasCollection(collectionName);
                    if (!hasCollection) {
                        return {
                            content: [{ type: "text", text: `Error: Index data for '${searchCodebasePath}' has been lost (collection not found in Milvus). Please re-index using index_codebase with force=true.` }],
                            isError: true
                        };
                    }
                }

                const filenameNotice = formatFilenameQueryNotice(filenameQueryStatus, false);
                let noResultsMessage = `No results found for query: "${query}" in codebase '${searchCodebasePath}'`;
                if (filenameNotice.length > 0) {
                    noResultsMessage = `${filenameNotice}\n\n${noResultsMessage}`;
                }
                if (searchCodebasePath !== absolutePath) {
                    noResultsMessage += `\nRequested path '${absolutePath}' is covered by indexed codebase '${searchCodebasePath}'.`;
                }
                if (isIndexing) {
                    noResultsMessage += `\n\nNote: This codebase is still being indexed. Try searching again after indexing completes, or the query may not match any indexed content.`;
                }
                return {
                    content: [{
                        type: "text",
                        text: noResultsMessage
                    }]
                };
            }

            // Format results
            const useFallbackMatchLabel = searchResultsAreFallbackMatches(filenameQueryStatus);
            const formattedResultsByGroup = new Map<string, string[]>();
            for (let index = 0; index < searchResults.length; index++) {
                const result: any = searchResults[index];
                const { location, warning } = this.formatSearchResultLocation(result);
                const scoreReason = this.formatSearchScoreReason(result);
                const sourceContext = this.formatSearchResultContext(result, searchCodebasePath);
                const codebaseInfo = path.basename(searchCodebasePath);
                const resultLabel = useFallbackMatchLabel ? "Fallback match" : "Source context";
                const warnings = [warning, sourceContext.warning].filter((value): value is string => typeof value === "string" && value.length > 0);
                const groupLabel = this.formatSearchResultGroupLabel(result.resultGroup);
                const traceEvidence = normalizedIncludeTraceEvidence.includeTraceEvidence === true
                    ? await this.formatSearchTraceEvidence(result, index, searchCodebasePath, sourceContext.context)
                    : this.formatSearchTraceFollowup(result, index, searchCodebasePath, sourceContext.context);

                const formattedResult = `${index + 1}. ${resultLabel} (${result.language}) [${codebaseInfo}]\n` +
                    `   Location: ${location}\n` +
                    warnings.map((value) => `   Warning: ${value}\n`).join('') +
                    `   Context source: ${sourceContext.source}\n` +
                    (scoreReason ? `   Match signals: ${scoreReason}\n` : '') +
                    traceEvidence +
                    `   Rank: ${index + 1}\n` +
                    `   Context: \n\`\`\`${result.language}\n${sourceContext.context}\n\`\`\`\n`;
                const groupResults = formattedResultsByGroup.get(groupLabel) ?? [];
                groupResults.push(formattedResult);
                formattedResultsByGroup.set(groupLabel, groupResults);
            }
            const formattedResults = [...formattedResultsByGroup.entries()]
                .map(([groupLabel, groupResults]) => `## ${groupLabel}\n\n${groupResults.join('\n')}`)
                .join('\n\n');

            const filenameNotice = formatFilenameQueryNotice(filenameQueryStatus, searchResults.length > 0);
            let resultMessage = useFallbackMatchLabel
                ? `Found ${searchResults.length} fallback matches for query: "${query}" in codebase '${searchCodebasePath}'${indexingStatusMessage}`
                : `Found ${searchResults.length} results for query: "${query}" in codebase '${searchCodebasePath}'${indexingStatusMessage}`;
            if (filenameNotice.length > 0) {
                resultMessage += `\n${filenameNotice}`;
            }
            if (searchCodebasePath !== absolutePath) {
                resultMessage += `\nRequested path '${absolutePath}' is covered by indexed codebase '${searchCodebasePath}'.`;
            }
            resultMessage += `\n\n${formattedResults}`;

            if (isIndexing) {
                resultMessage += `\n\n💡 **Tip**: This codebase is still being indexed. More results may become available as indexing progresses.`;
            }

            return {
                content: [{
                    type: "text",
                    text: resultMessage
                }]
            };
        } catch (error) {
            // Check if this is the collection limit error
            // Handle both direct string throws and Error objects containing the message
            const errorMessage = typeof error === 'string' ? error : (error instanceof Error ? error.message : String(error));

            if (errorMessage === COLLECTION_LIMIT_MESSAGE || errorMessage.includes(COLLECTION_LIMIT_MESSAGE)) {
                // Return the collection limit message as a successful response
                // This ensures LLM treats it as final answer, not as retryable error
                return {
                    content: [{
                        type: "text",
                        text: COLLECTION_LIMIT_MESSAGE
                    }]
                };
            }

            return {
                content: [{
                    type: "text",
                    text: `Error searching code: ${errorMessage} Please check if the codebase has been indexed first.`
                }],
                isError: true
            };
        }
    }

    public async handleClearIndex(args: any): Promise<any> {
        const validation = this.validateRequiredStringArgs("clear_index", args, ["path"]);
        if (validation.error) {
            return validation.error;
        }

        const { path: codebasePath } = args;

        try {
            // Force absolute path resolution - warn if relative path provided
            const absolutePath = ensureAbsolutePath(codebasePath);

            const indexedCodebases = this.snapshotManager.getIndexedCodebases();
            const indexingCodebases = this.snapshotManager.getIndexingCodebases();
            const isIndexed = indexedCodebases.includes(absolutePath);
            const isIndexing = indexingCodebases.includes(absolutePath);
            let hasVectorIndex = false;

            if (!isIndexed && !isIndexing) {
                hasVectorIndex = await this.context.hasIndex(absolutePath);
            }

            // clear_index must be able to clean up remote collection state after
            // the local directory was deleted. Only enforce filesystem checks
            // when the path still exists locally.
            const pathExists = fs.existsSync(absolutePath);
            if (pathExists && !fs.statSync(absolutePath).isDirectory()) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' is not a directory`
                    }],
                    isError: true
                };
            }

            if (!isIndexed && !isIndexing && !hasVectorIndex) {
                if (!pathExists) {
                    return {
                        content: [{
                            type: "text",
                            text: `Error: Path '${absolutePath}' does not exist. Original input: '${codebasePath}'`
                        }],
                        isError: true
                    };
                }
                if (indexedCodebases.length === 0 && indexingCodebases.length === 0) {
                    return {
                        content: [{
                            type: "text",
                            text: "No codebases are currently indexed or being indexed."
                        }]
                    };
                }
                return {
                    content: [{
                        type: "text",
                        text: `Error: Codebase '${absolutePath}' is not indexed or being indexed.`
                    }],
                    isError: true
                };
            }

            console.log(`[CLEAR] Clearing codebase: ${absolutePath}`);

            // Cancel any in-flight background indexing for this codebase and
            // wait for it to wind down before we drop the collection.
            // Otherwise the background task keeps embedding chunks and writes
            // them into the just-cleared collection (issue #199).
            const activeTask = this.indexingTasks.get(absolutePath);
            if (activeTask) {
                console.log(`[CLEAR] Cancelling in-flight background indexing for: ${absolutePath}`);
                activeTask.controller.abort();
                try {
                    await activeTask.promise;
                } catch (waitError: any) {
                    // startBackgroundIndexing already logs and never re-throws,
                    // so this catch only guards against future refactors.
                    console.warn(`[CLEAR] Background indexing wind-down reported: ${waitError?.message || waitError}`);
                }
                this.indexingTasks.delete(absolutePath);
            }

            try {
                await this.context.clearIndex(absolutePath);
                console.log(`[CLEAR] Successfully cleared index for: ${absolutePath}`);
            } catch (error: any) {
                const errorMsg = `Failed to clear ${absolutePath}: ${error.message}`;
                console.error(`[CLEAR] ${errorMsg}`);
                return {
                    content: [{
                        type: "text",
                        text: errorMsg
                    }],
                    isError: true
                };
            }

            // Completely remove the cleared codebase from snapshot
            this.snapshotManager.removeCodebaseCompletely(absolutePath);

            // Reset indexing stats if this was the active codebase
            this.indexingStats = null;

            // Save snapshot after clearing index
            this.snapshotManager.saveCodebaseSnapshot();

            let resultText = `Successfully cleared codebase '${absolutePath}'`;

            const remainingIndexed = this.snapshotManager.getIndexedCodebases().length;
            const remainingIndexing = this.snapshotManager.getIndexingCodebases().length;

            if (remainingIndexed > 0 || remainingIndexing > 0) {
                resultText += `\n${remainingIndexed} other indexed codebase(s) and ${remainingIndexing} indexing codebase(s) remain`;
            }

            return {
                content: [{
                    type: "text",
                    text: resultText
                }]
            };
        } catch (error) {
            // Check if this is the collection limit error
            // Handle both direct string throws and Error objects containing the message
            const errorMessage = typeof error === 'string' ? error : (error instanceof Error ? error.message : String(error));

            if (errorMessage === COLLECTION_LIMIT_MESSAGE || errorMessage.includes(COLLECTION_LIMIT_MESSAGE)) {
                // Return the collection limit message as a successful response
                // This ensures LLM treats it as final answer, not as retryable error
                return {
                    content: [{
                        type: "text",
                        text: COLLECTION_LIMIT_MESSAGE
                    }]
                };
            }

            return {
                content: [{
                    type: "text",
                    text: `Error clearing index: ${errorMessage}`
                }],
                isError: true
            };
        }
    }

    public async handleGetIndexingStatus(args: any): Promise<any> {
        const validation = this.validateRequiredStringArgs("get_indexing_status", args, ["path"]);
        if (validation.error) {
            return validation.error;
        }

        const { path: codebasePath } = args;

        try {
            // Force absolute path resolution
            const absolutePath = ensureAbsolutePath(codebasePath);

            // Validate path exists
            if (!fs.existsSync(absolutePath)) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' does not exist. Original input: '${codebasePath}'`
                    }],
                    isError: true
                };
            }

            // Check if it's a directory
            const stat = fs.statSync(absolutePath);
            if (!stat.isDirectory()) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' is not a directory`
                    }],
                    isError: true
                };
            }

            await this.syncIndexedCodebasesFromCloud();

            // Check indexing status using new status system
            const statusCodebasePath = this.snapshotManager.findTrackedCodebasePath(absolutePath) || absolutePath;
            const status = this.snapshotManager.getCodebaseStatus(statusCodebasePath);
            const info = this.snapshotManager.getCodebaseInfo(statusCodebasePath);

            let statusMessage = '';

            switch (status) {
                case 'indexed':
                    if (info && 'indexedFiles' in info) {
                        const indexedInfo = info as CodebaseInfoIndexed;
                        statusMessage = `✅ Codebase '${statusCodebasePath}' is fully indexed and ready for search.`;
                        statusMessage += `\n📊 Statistics: ${this.formatIndexedStatistics(statusCodebasePath, indexedInfo)}`;
                        statusMessage += `\n📅 Status: ${indexedInfo.indexStatus}`;
                        if (indexedInfo.syncWarning) {
                            statusMessage += `\n⚠️  Sync warning: ${indexedInfo.syncWarning}`;
                        }
                        statusMessage += `\n🕐 Last updated: ${new Date(indexedInfo.lastUpdated).toLocaleString()}`;
                    } else {
                        statusMessage = `✅ Codebase '${statusCodebasePath}' is fully indexed and ready for search.`;
                    }
                    break;

                case 'indexing':
                    if (info && 'indexingPercentage' in info) {
                        const indexingInfo = info as any;
                        const progressPercentage = indexingInfo.indexingPercentage || 0;
                        statusMessage = `🔄 Codebase '${statusCodebasePath}' is currently being indexed. Progress: ${progressPercentage.toFixed(1)}%`;

                        // Add more detailed status based on progress
                        if (progressPercentage < 10) {
                            statusMessage += ' (Preparing and scanning files...)';
                        } else if (progressPercentage < 100) {
                            statusMessage += ' (Processing files and generating embeddings...)';
                        }
                        statusMessage += `\n🕐 Last updated: ${new Date(indexingInfo.lastUpdated).toLocaleString()}`;
                    } else {
                        statusMessage = `🔄 Codebase '${statusCodebasePath}' is currently being indexed.`;
                    }
                    break;

                case 'indexfailed':
                    if (info && 'errorMessage' in info) {
                        const failedInfo = info as any;
                        statusMessage = `❌ Codebase '${statusCodebasePath}' indexing failed.`;
                        statusMessage += `\n🚨 Error: ${failedInfo.errorMessage}`;
                        if (failedInfo.lastAttemptedPercentage !== undefined) {
                            statusMessage += `\n📊 Failed at: ${failedInfo.lastAttemptedPercentage.toFixed(1)}% progress`;
                        }
                        statusMessage += `\n🕐 Failed at: ${new Date(failedInfo.lastUpdated).toLocaleString()}`;
                        statusMessage += `\n💡 You can retry indexing by running the index_codebase command again.`;
                    } else {
                        statusMessage = `❌ Codebase '${statusCodebasePath}' indexing failed. You can retry indexing.`;
                    }
                    break;

                case 'not_found':
                default:
                    statusMessage = `❌ Codebase '${absolutePath}' is not indexed. ${NOT_INDEXED_INDEXING_HINT}`;
                    break;
            }

            const pathInfo = codebasePath !== absolutePath
                ? `\nNote: Input path '${codebasePath}' was resolved to absolute path '${absolutePath}'`
                : '';
            const matchedPathInfo = statusCodebasePath !== absolutePath
                ? `\nRequested path '${absolutePath}' is covered by tracked codebase '${statusCodebasePath}'.`
                : '';

            return {
                content: [{
                    type: "text",
                    text: statusMessage + pathInfo + matchedPathInfo
                }]
            };

        } catch (error: any) {
            return {
                content: [{
                    type: "text",
                    text: `Error getting indexing status: ${error.message || error}`
                }],
                isError: true
            };
        }
    }
} 
