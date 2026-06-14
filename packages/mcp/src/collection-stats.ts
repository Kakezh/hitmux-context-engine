export interface CollectionStats {
    indexedFiles: number;
    totalChunks: number;
    statsSource: "collection_row_count";
}

interface CollectionStatsContext {
    getCollectionName(codebasePath: string): string;
    getVectorDatabase(): {
        getCollectionRowCount(collectionName: string): Promise<number>;
        query(collectionName: string, filter: string, outputFields: string[], limit: number): Promise<Array<{ relativePath?: unknown }>>;
    };
}

async function queryIndexedFileCount(
    context: CollectionStatsContext,
    collectionName: string,
    rowCount: number,
    logPrefix: string
): Promise<number | undefined> {
    try {
        const rows = await context.getVectorDatabase().query(collectionName, "", ["relativePath"], rowCount);
        const filePaths = new Set<string>();

        for (const row of rows) {
            if (typeof row.relativePath === "string" && row.relativePath.length > 0) {
                filePaths.add(row.relativePath);
            }
        }

        if (filePaths.size > 0) {
            return filePaths.size;
        }
    } catch (error) {
        console.warn(`[${logPrefix}] Failed to query distinct indexed files for '${collectionName}':`, error);
    }

    return undefined;
}

export async function queryCollectionStats(
    context: CollectionStatsContext,
    codebasePath: string,
    logPrefix = "SNAPSHOT-RECOVERY"
): Promise<CollectionStats | null> {
    try {
        const statsContext = context as any;
        if (typeof statsContext.getCollectionName !== "function" || typeof statsContext.getVectorDatabase !== "function") {
            return null;
        }
        const collectionName = context.getCollectionName(codebasePath);
        const vectorDatabase = context.getVectorDatabase();
        if (typeof vectorDatabase?.getCollectionRowCount !== "function") {
            return null;
        }
        const rowCount = await vectorDatabase.getCollectionRowCount(collectionName);
        if (rowCount < 0) {
            console.warn(`[${logPrefix}] Row count unknown for '${codebasePath}', skipping snapshot stats update`);
            return null;
        }
        if (rowCount === 0) {
            console.warn(`[${logPrefix}] Collection '${collectionName}' is empty; skipping snapshot stats update`);
            return null;
        }

        const indexedFiles = await queryIndexedFileCount(context, collectionName, rowCount, logPrefix);
        return { indexedFiles: indexedFiles ?? 0, totalChunks: rowCount, statsSource: "collection_row_count" };
    } catch (error) {
        console.warn(`[${logPrefix}] Failed to query stats for '${codebasePath}':`, error);
        return null;
    }
}
