import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
    Context,
    FileSynchronizer,
    IncrementalIndexTooLargeError,
    configManager,
} from "@hitmux/hitmux-context-engine-core";
import { SnapshotManager } from "./snapshot.js";
import type { RequestSplitterType } from "./config.js";
import {
    createRequestSplitter,
    resolveRequestSplitterType,
} from "./splitter.js";
import { queryCollectionStats } from "./collection-stats.js";
import { acquireMcpWriterLock, type McpWriterLock } from "./sync-lock.js";

const DEFAULT_INITIAL_SYNC_DELAY_MS = 5_000;
const DEFAULT_SYNC_INTERVAL_MS = 2 * 60 * 1000;
const MIN_SYNC_INTERVAL_MS = 1_000;

function isBackgroundSyncEnabled(): boolean {
    return configManager.getBoolean("backgroundSync") ?? true;
}

function isAutoIndexingEnabled(): boolean {
    return configManager.getBoolean("autoIndexing") ?? true;
}

function getBackgroundSyncIntervalMs(): number {
    const intervalMs = configManager.getNumber("syncIntervalMs");
    if (intervalMs === undefined) {
        return DEFAULT_SYNC_INTERVAL_MS;
    }

    if (!Number.isFinite(intervalMs) || intervalMs < MIN_SYNC_INTERVAL_MS) {
        console.warn(
            `[SYNC-DEBUG] Invalid config.syncIntervalMs value '${intervalMs}'. ` +
                `Falling back to ${DEFAULT_SYNC_INTERVAL_MS}ms.`,
        );
        return DEFAULT_SYNC_INTERVAL_MS;
    }

    return Math.floor(intervalMs);
}

function getSyncConcurrency(): number {
    const concurrency = configManager.getNumber("embeddingConcurrency");
    if (concurrency === undefined) {
        return 4;
    }

    if (!Number.isFinite(concurrency) || concurrency < 1) {
        console.warn(
            `[SYNC-DEBUG] Invalid config.embeddingConcurrency value '${concurrency}'. Falling back to 4.`,
        );
        return 4;
    }

    return Math.max(1, Math.floor(concurrency));
}

export interface CodebaseSyncStatus {
    codebasePath: string;
    phase: string;
    current: number;
    total: number;
    percentage: number;
    startedAtMs: number;
    updatedAtMs: number;
}

export class SyncManager {
    private context: Context;
    private snapshotManager: SnapshotManager;
    private isSyncing: boolean = false;
    private syncLock: McpWriterLock | null = null;
    private triggerWatcher: fs.FSWatcher | null = null;
    private triggerDebounceTimer: NodeJS.Timeout | null = null;
    private backgroundSyncTimer: NodeJS.Timeout | null = null;
    private backgroundSyncIntervalMs: number | null = null;
    private backgroundSyncEnabled: boolean = false;
    private syncStatuses: Map<string, CodebaseSyncStatus> = new Map();

    constructor(context: Context, snapshotManager: SnapshotManager) {
        this.context = context;
        this.snapshotManager = snapshotManager;
    }

    private acquireGlobalSyncLock(): boolean {
        if (this.syncLock) {
            return true;
        }

        this.syncLock = acquireMcpWriterLock("automatic sync");
        return this.syncLock !== null;
    }

    private releaseGlobalSyncLock(): void {
        if (this.syncLock) {
            this.syncLock.release();
            this.syncLock = null;
        }
    }

    public getSyncStatus(codebasePath: string): CodebaseSyncStatus | undefined {
        const status = this.syncStatuses.get(codebasePath);
        return status ? { ...status } : undefined;
    }

    private setCodebaseSyncStatus(
        codebasePath: string,
        status: Omit<CodebaseSyncStatus, "codebasePath">,
    ): void {
        this.syncStatuses.set(codebasePath, {
            codebasePath,
            ...status,
        });
    }

    private updateCodebaseSyncProgress(
        codebasePath: string,
        startedAtMs: number,
        progress: {
            phase: string;
            current: number;
            total: number;
            percentage: number;
        },
    ): void {
        this.setCodebaseSyncStatus(codebasePath, {
            phase: progress.phase,
            current: progress.current,
            total: progress.total,
            percentage: progress.percentage,
            startedAtMs,
            updatedAtMs: Date.now(),
        });
    }

    public async handleSyncIndex(): Promise<void> {
        const syncStartTime = Date.now();
        console.log(
            `[SYNC-DEBUG] handleSyncIndex() called at ${new Date().toISOString()}`,
        );

        if (!isAutoIndexingEnabled()) {
            console.log(
                "[SYNC-DEBUG] Automatic indexing is disabled via config.autoIndexing=false.",
            );
            return;
        }

        const indexedCodebases = this.snapshotManager.getIndexedCodebases();

        if (indexedCodebases.length === 0) {
            console.log("[SYNC-DEBUG] No codebases indexed. Skipping sync.");
            return;
        }

        console.log(
            `[SYNC-DEBUG] Found ${indexedCodebases.length} indexed codebases:`,
            indexedCodebases,
        );

        if (this.isSyncing) {
            console.log(
                "[SYNC-DEBUG] Index sync already in progress. Skipping.",
            );
            return;
        }

        if (!this.acquireGlobalSyncLock()) {
            return;
        }

        this.isSyncing = true;
        console.log(
            `[SYNC-DEBUG] Starting index sync for all ${indexedCodebases.length} codebases...`,
        );

        try {
            for (let i = 0; i < indexedCodebases.length; i++) {
                this.setCodebaseSyncStatus(indexedCodebases[i], {
                    phase: "Waiting for automatic sync...",
                    current: i,
                    total: indexedCodebases.length,
                    percentage: 0,
                    startedAtMs: syncStartTime,
                    updatedAtMs: Date.now(),
                });
            }

            const syncConcurrency = Math.min(
                getSyncConcurrency(),
                indexedCodebases.length,
            );
            console.log(
                `[SYNC-DEBUG] Running automatic sync with concurrency ${syncConcurrency}`,
            );
            const syncResults = await this.runCodebaseSyncsWithConcurrency(
                indexedCodebases,
                syncConcurrency,
            );
            const totalStats = syncResults.reduce(
                (total, stats) => ({
                    added: total.added + stats.added,
                    removed: total.removed + stats.removed,
                    modified: total.modified + stats.modified,
                }),
                { added: 0, removed: 0, modified: 0 },
            );

            const totalElapsed = Date.now() - syncStartTime;
            console.log(
                `[SYNC-DEBUG] Total sync stats across all codebases: Added: ${totalStats.added}, Removed: ${totalStats.removed}, Modified: ${totalStats.modified}`,
            );
            console.log(
                `[SYNC-DEBUG] Index sync completed for all codebases in ${totalElapsed}ms`,
            );
            console.log(
                `[SYNC] Index sync completed for all codebases. Total changes - Added: ${totalStats.added}, Removed: ${totalStats.removed}, Modified: ${totalStats.modified}`,
            );
        } catch (error: any) {
            const totalElapsed = Date.now() - syncStartTime;
            console.error(
                `[SYNC-DEBUG] Error during index sync after ${totalElapsed}ms:`,
                error,
            );
            console.error(`[SYNC-DEBUG] Error stack:`, error.stack);
        } finally {
            this.isSyncing = false;
            this.syncStatuses.clear();
            this.releaseGlobalSyncLock();
            const totalElapsed = Date.now() - syncStartTime;
            console.log(
                `[SYNC-DEBUG] handleSyncIndex() finished at ${new Date().toISOString()}, total duration: ${totalElapsed}ms`,
            );
        }
    }

    private async runCodebaseSyncsWithConcurrency(
        indexedCodebases: string[],
        concurrency: number,
    ): Promise<Array<{ added: number; removed: number; modified: number }>> {
        const results: Array<{ added: number; removed: number; modified: number }> =
            new Array(indexedCodebases.length);
        let nextIndex = 0;

        const runWorker = async (): Promise<void> => {
            while (nextIndex < indexedCodebases.length) {
                const index = nextIndex;
                nextIndex += 1;
                results[index] = await this.syncCodebase(
                    indexedCodebases[index],
                    index,
                    indexedCodebases.length,
                );
            }
        };

        await Promise.all(
            Array.from({ length: concurrency }, () => runWorker()),
        );
        return results;
    }

    private async syncCodebase(
        codebasePath: string,
        index: number,
        totalCodebases: number,
    ): Promise<{ added: number; removed: number; modified: number }> {
        const codebaseStartTime = Date.now();

        console.log(
            `[SYNC-DEBUG] [${index + 1}/${totalCodebases}] Starting sync for codebase: '${codebasePath}'`,
        );

        try {
            const pathExists = fs.existsSync(codebasePath);
            console.log(`[SYNC-DEBUG] Codebase path exists: ${pathExists}`);

            if (!pathExists) {
                console.warn(
                    `[SYNC-DEBUG] Codebase path '${codebasePath}' no longer exists. Skipping sync.`,
                );
                this.syncStatuses.delete(codebasePath);
                return { added: 0, removed: 0, modified: 0 };
            }
        } catch (pathError: any) {
            console.error(
                `[SYNC-DEBUG] Error checking codebase path '${codebasePath}':`,
                pathError,
            );
            this.syncStatuses.delete(codebasePath);
            return { added: 0, removed: 0, modified: 0 };
        }

        try {
            console.log(
                `[SYNC-DEBUG] Calling context.reindexByChange() for '${codebasePath}'`,
            );
            this.setCodebaseSyncStatus(codebasePath, {
                phase: "Checking for file changes...",
                current: 0,
                total: 100,
                percentage: 0,
                startedAtMs: codebaseStartTime,
                updatedAtMs: Date.now(),
            });
            const codebaseInfo = this.snapshotManager.getCodebaseInfo(codebasePath);
            const requestSplitterType: RequestSplitterType =
                resolveRequestSplitterType(codebaseInfo?.requestSplitter);
            const requestIgnorePatterns = codebaseInfo?.requestIgnorePatterns || [];
            const requestCustomExtensions =
                codebaseInfo?.requestCustomExtensions || [];
            const requestIgnoreFiles = codebaseInfo?.requestIgnoreFiles || [];
            const requestMaxDepth = codebaseInfo?.requestMaxDepth;
            const stats = await this.context.reindexByChange(
                codebasePath,
                (progress) =>
                    this.updateCodebaseSyncProgress(
                        codebasePath,
                        codebaseStartTime,
                        progress,
                    ),
                requestIgnorePatterns,
                requestCustomExtensions,
                createRequestSplitter(requestSplitterType),
                requestIgnoreFiles,
                requestMaxDepth,
            );
            const codebaseElapsed = Date.now() - codebaseStartTime;

            console.log(`[SYNC-DEBUG] Reindex stats for '${codebasePath}':`, stats);
            console.log(
                `[SYNC-DEBUG] Codebase sync completed in ${codebaseElapsed}ms`,
            );

            if (stats.added > 0 || stats.removed > 0 || stats.modified > 0) {
                const collectionStats = await queryCollectionStats(
                    this.context,
                    codebasePath,
                    "SYNC-STATS",
                );
                if (collectionStats) {
                    this.snapshotManager.setCodebaseIndexed(codebasePath, {
                        ...collectionStats,
                        status: "completed",
                    });
                    this.snapshotManager.saveCodebaseSnapshot();
                } else {
                    this.snapshotManager.clearCodebaseSyncWarning(codebasePath);
                    this.snapshotManager.saveCodebaseSnapshot();
                }
                console.log(
                    `[SYNC] Sync complete for '${codebasePath}'. Added: ${stats.added}, Removed: ${stats.removed}, Modified: ${stats.modified} (${codebaseElapsed}ms)`,
                );
            } else {
                const previousInfo =
                    this.snapshotManager.getCodebaseInfo(codebasePath);
                const hadSyncWarning =
                    previousInfo?.status === "indexed" &&
                    typeof previousInfo.syncWarning === "string";
                this.snapshotManager.clearCodebaseSyncWarning(codebasePath);
                if (hadSyncWarning) {
                    this.snapshotManager.saveCodebaseSnapshot();
                }
                console.log(
                    `[SYNC] No changes detected for '${codebasePath}' (${codebaseElapsed}ms)`,
                );
            }

            return stats;
        } catch (error: any) {
            const codebaseElapsed = Date.now() - codebaseStartTime;
            if (error instanceof IncrementalIndexTooLargeError) {
                const warning = `Automatic incremental indexing paused: detected ${error.effectiveLines} effective lines across ${error.changedFiles} added/modified file(s), exceeding the ${error.threshold} line limit. Check whether this is a large batch of files that should be added to .hceignore. If the files should be indexed, review the change set and run index_codebase with incremental=true from MCP.`;
                console.warn(`[SYNC] ${warning}`);
                this.snapshotManager.setCodebaseSyncWarning(codebasePath, warning);
                this.snapshotManager.saveCodebaseSnapshot();
                return { added: 0, removed: 0, modified: 0 };
            }

            console.error(
                `[SYNC-DEBUG] Error syncing codebase '${codebasePath}' after ${codebaseElapsed}ms:`,
                error,
            );
            console.error(`[SYNC-DEBUG] Error stack:`, error.stack);

            if (error.message.includes("Failed to query Milvus")) {
                await FileSynchronizer.deleteSnapshot(codebasePath);
            }

            if (error.code) {
                console.error(`[SYNC-DEBUG] Error code: ${error.code}`);
            }
            if (error.errno) {
                console.error(`[SYNC-DEBUG] Error errno: ${error.errno}`);
            }

            return { added: 0, removed: 0, modified: 0 };
        } finally {
            this.syncStatuses.delete(codebasePath);
        }
    }

    public startBackgroundSync(): void {
        console.log("[SYNC-DEBUG] startBackgroundSync() called");

        if (!isAutoIndexingEnabled()) {
            console.log(
                "[SYNC-DEBUG] Automatic indexing is disabled via config.autoIndexing=false.",
            );
            return;
        }

        // Set up the trigger file watcher first, independent of polling.
        this.setupTriggerWatcher();

        if (!isBackgroundSyncEnabled()) {
            console.log(
                "[SYNC-DEBUG] Background sync is disabled via config.backgroundSync=false.",
            );
            return;
        }

        if (this.backgroundSyncEnabled) {
            console.log(
                "[SYNC-DEBUG] Background sync polling is already active, skipping re-init",
            );
            return;
        }

        const syncIntervalMs = getBackgroundSyncIntervalMs();
        this.backgroundSyncIntervalMs = syncIntervalMs;
        this.backgroundSyncEnabled = true;

        // Execute initial sync immediately after a short delay to let server initialize
        console.log(
            `[SYNC-DEBUG] Scheduling initial sync in ${DEFAULT_INITIAL_SYNC_DELAY_MS}ms...`,
        );
        this.scheduleBackgroundSync(DEFAULT_INITIAL_SYNC_DELAY_MS, "initial");

        // Periodically check for file changes and update the index. The next
        // timer is scheduled only after the current sync attempt settles, so
        // a long sync cannot queue or overlap with another periodic sync.
        console.log(
            `[SYNC-DEBUG] Background sync will repeat every ${syncIntervalMs}ms after each completed run`,
        );

        console.log(
            "[SYNC-DEBUG] Background sync setup complete. Timer ID:",
            this.backgroundSyncTimer,
        );
    }

    private scheduleBackgroundSync(
        delayMs: number,
        reason: "initial" | "periodic",
    ): void {
        this.backgroundSyncTimer = setTimeout(async () => {
            this.backgroundSyncTimer = null;
            const label =
                reason === "initial"
                    ? "initial sync after server startup"
                    : "scheduled periodic sync";
            console.log(`[SYNC-DEBUG] Executing ${label}`);

            try {
                await this.handleSyncIndex();
            } catch (error) {
                const errorMessage =
                    error instanceof Error ? error.message : String(error);
                if (errorMessage.includes("Failed to query collection")) {
                    console.log(
                        "[SYNC-DEBUG] Collection not yet established, this is expected for new cluster users. Will retry on next sync cycle.",
                    );
                } else {
                    console.error(
                        `[SYNC-DEBUG] ${reason === "initial" ? "Initial" : "Periodic"} sync failed with unexpected error:`,
                        error,
                    );
                }
            } finally {
                if (
                    this.backgroundSyncEnabled &&
                    this.backgroundSyncIntervalMs !== null
                ) {
                    this.scheduleBackgroundSync(
                        this.backgroundSyncIntervalMs,
                        "periodic",
                    );
                }
            }
        }, delayMs);
    }

    public stopBackgroundSync(): void {
        this.backgroundSyncEnabled = false;
        this.backgroundSyncIntervalMs = null;
        if (this.backgroundSyncTimer) {
            clearTimeout(this.backgroundSyncTimer);
            this.backgroundSyncTimer = null;
        }
    }

    /**
     * Read config.triggerWatcher. Default ON — the watcher is cheap and only
     * fires when an external process explicitly touches the trigger file. Users who want
     * zero filesystem watching (e.g. read-only filesystems, sandboxed envs) can disable it.
     */
    private isTriggerWatcherEnabled(): boolean {
        return configManager.getBoolean("triggerWatcher") ?? true;
    }

    /**
     * Watch for trigger file changes to enable instant re-index.
     * Claude Code PostToolUse hooks can touch ~/.hitmux-context-engine/.sync-trigger
     * after Write/Edit operations to trigger immediate re-indexing.
     */
    private setupTriggerWatcher(): void {
        if (!this.isTriggerWatcherEnabled()) {
            console.log(
                "[SYNC-DEBUG] Trigger watcher disabled via config.triggerWatcher=false",
            );
            return;
        }

        // Guard against double-initialization (hot reload, repeated test setup).
        if (this.triggerWatcher) {
            console.log(
                "[SYNC-DEBUG] Trigger watcher already active, skipping re-init",
            );
            return;
        }

        const contextDir = path.join(os.homedir(), ".hitmux-context-engine");
        const triggerFile = ".sync-trigger";
        const triggerPath = path.join(contextDir, triggerFile);

        try {
            // Ensure context dir exists before watching (snapshot manager
            // also creates it, but be defensive in case watcher starts first).
            fs.mkdirSync(contextDir, { recursive: true });

            // Pass encoding so `filename` is consistently a string across platforms
            // (default can be Buffer on some Node builds).
            const watcher = fs.watch(
                contextDir,
                { encoding: "utf8" },
                (_event, filename) => {
                    // With encoding: 'utf8', filename is `string | null`. null happens on
                    // some platforms when the underlying event lacks a name; treat as no-op.
                    if (
                        typeof filename !== "string" ||
                        filename !== triggerFile
                    )
                        return;

                    if (this.triggerDebounceTimer)
                        clearTimeout(this.triggerDebounceTimer);
                    this.triggerDebounceTimer = setTimeout(() => {
                        console.log(
                            "[SYNC] Trigger file detected, starting instant re-index...",
                        );
                        // Fire-and-forget with explicit catch so an unhandled rejection
                        // can't crash the process from inside the setTimeout callback.
                        void this.handleSyncIndex().catch((error) => {
                            const errorMessage =
                                error instanceof Error
                                    ? error.message
                                    : String(error);
                            if (
                                errorMessage.includes(
                                    "Failed to query collection",
                                )
                            ) {
                                console.log(
                                    "[SYNC-DEBUG] Collection not yet established during trigger sync; will retry on next cycle.",
                                );
                            } else {
                                console.error(
                                    "[SYNC-DEBUG] Triggered sync failed with unexpected error:",
                                    error,
                                );
                            }
                        });
                    }, 2000);
                },
            );

            // fs.watch can emit `error` asynchronously (e.g. dir deleted, fs unmounted).
            // Without a listener this would crash the process.
            watcher.on("error", (err) => {
                console.warn(
                    "[SYNC-DEBUG] Trigger watcher error:",
                    err instanceof Error ? err.message : String(err),
                );
                this.stopTriggerWatcher();
            });

            this.triggerWatcher = watcher;
            console.log(
                `[SYNC-DEBUG] Trigger watcher active on ${triggerPath}`,
            );
        } catch (error) {
            if (error instanceof Error) {
                console.warn(
                    "[SYNC-DEBUG] Could not set up trigger watcher:",
                    error.message,
                );
                if (error.stack) console.warn(error.stack);
            } else {
                console.warn(
                    "[SYNC-DEBUG] Could not set up trigger watcher:",
                    String(error),
                );
            }
        }
    }

    /** Stop the watcher (idempotent). Useful for tests or graceful shutdown. */
    public stopTriggerWatcher(): void {
        if (this.triggerDebounceTimer) {
            clearTimeout(this.triggerDebounceTimer);
            this.triggerDebounceTimer = null;
        }
        if (this.triggerWatcher) {
            try {
                this.triggerWatcher.close();
            } catch {
                /* already closed */
            }
            this.triggerWatcher = null;
        }
    }
}
