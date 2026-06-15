import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { configManager } from "@hitmux/hitmux-context-engine-core";

const DEFAULT_SYNC_LOCK_STALE_MS = 10 * 60 * 1000;

interface WriterLockOwner {
    pid?: number;
    token?: string;
    acquiredAt?: string;
    heartbeatAt?: string;
    label?: string;
    recoveredStaleLock?: boolean;
}

export class McpWriterLock {
    private heartbeatTimer: NodeJS.Timeout | null = null;

    constructor(
        private readonly lockPath: string,
        private readonly token: string,
        private readonly staleMs: number
    ) {}

    public startHeartbeat(): void {
        if (this.heartbeatTimer) {
            return;
        }

        const intervalMs = Math.max(1, Math.min(Math.floor(this.staleMs / 3), 30_000));
        this.heartbeatTimer = setInterval(() => {
            const owner = readWriterLockOwner(this.lockPath);
            if (!owner?.token || owner.token !== this.token) {
                this.stopHeartbeat();
                return;
            }

            try {
                writeWriterLockOwner(this.lockPath, owner);
            } catch (error: any) {
                console.warn(`[SYNC-DEBUG] Failed to heartbeat MCP writer lock: ${error?.message || String(error)}`);
            }
        }, intervalMs);
        this.heartbeatTimer.unref?.();
    }

    public release(): void {
        try {
            this.stopHeartbeat();
            const ownerPath = path.join(this.lockPath, "owner.json");
            if (fs.existsSync(ownerPath)) {
                const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8")) as WriterLockOwner;
                if (owner.token && owner.token !== this.token) {
                    console.warn(`[SYNC-DEBUG] MCP writer lock is owned by another process. Skipping release: ${this.lockPath}`);
                    return;
                }
            }
            fs.rmSync(this.lockPath, { recursive: true, force: true });
            console.log(`[SYNC-DEBUG] Released MCP writer lock: ${this.lockPath}`);
        } catch (error: any) {
            console.warn(`[SYNC-DEBUG] Failed to release MCP writer lock: ${error?.message || String(error)}`);
        }
    }

    private stopHeartbeat(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }
}

export function getMcpWriterLockPath(): string {
    return path.join(os.homedir(), ".hitmux-context-engine", "mcp-sync.lock");
}

export function acquireMcpWriterLock(label: string): McpWriterLock | null {
    const lockPath = getMcpWriterLockPath();
    const staleMs = getWriterLockStaleMs();
    const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });

    try {
        fs.mkdirSync(lockPath);
        writeWriterLockOwner(lockPath, {
            pid: process.pid,
            token,
            acquiredAt: new Date().toISOString(),
            label
        });
        console.log(`[SYNC-DEBUG] Acquired MCP writer lock for ${label}: ${lockPath}`);
        const lock = new McpWriterLock(lockPath, token, staleMs);
        lock.startHeartbeat();
        return lock;
    } catch (error: any) {
        if (error?.code !== "EEXIST") {
            console.warn(`[SYNC-DEBUG] Failed to acquire MCP writer lock for ${label}: ${error?.message || String(error)}`);
            return null;
        }

        try {
            const lastOwnerUpdateMs = getWriterLockLastUpdateMs(lockPath);
            if (Date.now() - lastOwnerUpdateMs > staleMs) {
                const stalePath = `${lockPath}.stale-${process.pid}-${Date.now()}`;
                console.warn(`[SYNC-DEBUG] Reclaiming stale MCP writer lock: ${lockPath}`);
                fs.renameSync(lockPath, stalePath);
                fs.rmSync(stalePath, { recursive: true, force: true });
                fs.mkdirSync(lockPath);
                writeWriterLockOwner(lockPath, {
                    pid: process.pid,
                    token,
                    acquiredAt: new Date().toISOString(),
                    label,
                    recoveredStaleLock: true
                });
                console.log(`[SYNC-DEBUG] Acquired MCP writer lock after stale cleanup for ${label}: ${lockPath}`);
                const lock = new McpWriterLock(lockPath, token, staleMs);
                lock.startHeartbeat();
                return lock;
            }
        } catch (statError: any) {
            console.warn(`[SYNC-DEBUG] Could not inspect MCP writer lock for ${label}: ${statError?.message || String(statError)}`);
        }

        console.log(`[SYNC-DEBUG] Another MCP process is already writing index state. Skipping ${label}.`);
        return null;
    }
}

export function formatMcpWriterLockBusyMessage(action: string): string {
    return `Another MCP process is already indexing, clearing, or syncing index state. Please retry ${action} after the current write operation finishes.`;
}

function getWriterLockStaleMs(): number {
    const value = configManager.getNumber("syncLockStaleMs");
    if (value === undefined) {
        return DEFAULT_SYNC_LOCK_STALE_MS;
    }

    if (!Number.isFinite(value) || value <= 0) {
        console.warn(`[SYNC-DEBUG] Invalid config.syncLockStaleMs value '${value}'. Falling back to ${DEFAULT_SYNC_LOCK_STALE_MS}ms.`);
        return DEFAULT_SYNC_LOCK_STALE_MS;
    }

    return Math.floor(value);
}

function readWriterLockOwner(lockPath: string): WriterLockOwner | undefined {
    try {
        return JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8")) as WriterLockOwner;
    } catch {
        return undefined;
    }
}

function writeWriterLockOwner(lockPath: string, owner: WriterLockOwner): void {
    const now = new Date();
    fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({
        ...owner,
        heartbeatAt: now.toISOString()
    }, null, 2));
    fs.utimesSync(lockPath, now, now);
}

function getWriterLockLastUpdateMs(lockPath: string): number {
    const owner = readWriterLockOwner(lockPath);
    const heartbeatMs = owner?.heartbeatAt ? Date.parse(owner.heartbeatAt) : NaN;
    if (Number.isFinite(heartbeatMs)) {
        return heartbeatMs;
    }

    const acquiredMs = owner?.acquiredAt ? Date.parse(owner.acquiredAt) : NaN;
    if (Number.isFinite(acquiredMs)) {
        return acquiredMs;
    }

    return fs.statSync(lockPath).mtimeMs;
}
