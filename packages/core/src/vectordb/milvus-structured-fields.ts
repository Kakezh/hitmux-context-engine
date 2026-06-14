import { VectorDocument, STRUCTURED_METADATA_FIELDS } from './types';

export const STRUCTURED_STRING_FIELD_DEFINITIONS = [
    { name: 'primarySymbol', description: 'Primary symbol or section identifier', maxLength: 512 },
    { name: 'symbolKind', description: 'Symbol kind from splitter metadata', maxLength: 64 },
    { name: 'chunkKind', description: 'Chunk kind from splitter metadata', maxLength: 64 },
    { name: 'fileRole', description: 'File role inferred from path and extension', maxLength: 64 },
    { name: 'basename', description: 'File basename without extension', maxLength: 255 },
    { name: 'pathSegment0', description: 'Path segment 0', maxLength: 255 },
    { name: 'pathSegment1', description: 'Path segment 1', maxLength: 255 },
    { name: 'pathSegment2', description: 'Path segment 2', maxLength: 255 },
    { name: 'pathSegment3', description: 'Path segment 3', maxLength: 255 },
    { name: 'pathSegment4', description: 'Path segment 4', maxLength: 255 },
] as const;

export function getStructuredFieldValue(document: VectorDocument, field: string): string | boolean {
    if (field === 'isDefinition') {
        return document.isDefinition === true;
    }

    const value = document[field as keyof VectorDocument];
    return typeof value === 'string' ? value : '';
}

export function createStructuredInsertRow(document: VectorDocument): Record<string, any> {
    const row: Record<string, any> = {
        id: document.id,
        vector: document.vector,
        content: document.content,
        relativePath: document.relativePath,
        startLine: document.startLine,
        endLine: document.endLine,
        fileExtension: document.fileExtension,
        metadata: JSON.stringify(document.metadata),
    };

    for (const field of STRUCTURED_METADATA_FIELDS) {
        row[field] = getStructuredFieldValue(document, field);
    }

    return row;
}

export function mergeStructuredMetadata(result: Record<string, any>, metadata: Record<string, any>): Record<string, any> {
    const merged = { ...metadata };
    for (const field of STRUCTURED_METADATA_FIELDS) {
        const value = result[field];
        if (typeof value === 'string' || typeof value === 'boolean') {
            merged[field] = value;
        }
    }
    return merged;
}

export function getStructuredDocumentFields(result: Record<string, any>): Partial<VectorDocument> {
    const fields: Partial<VectorDocument> = {};
    for (const field of STRUCTURED_METADATA_FIELDS) {
        const value = result[field];
        if (typeof value === 'string' || typeof value === 'boolean') {
            (fields as Record<string, string | boolean>)[field] = value;
        }
    }
    return fields;
}

export function createSchemaMismatchError(collectionName: string, detail: string): Error {
    return new Error(`Collection '${collectionName}' uses an unsupported search schema. ${detail} Reindex the codebase with force=true to create schema v2 metadata fields.`);
}

export function isMissingStructuredFieldMessage(message: string): boolean {
    return STRUCTURED_METADATA_FIELDS.some(field => message.includes(field))
        && /field|schema|output|not.*exist|not.*found|cannot.*find|undefined/i.test(message);
}

export function requireCurrentStructuredSchema(collectionName: string, description: string): void {
    const metadataLine = description
        .split(/\r?\n/)
        .find((line) => line.startsWith('hitmuxContext:'));
    if (!metadataLine) {
        throw createSchemaMismatchError(collectionName, 'Missing hitmuxContext collection metadata.');
    }

    let metadata: any;
    try {
        metadata = JSON.parse(metadataLine.slice('hitmuxContext:'.length));
    } catch {
        throw createSchemaMismatchError(collectionName, 'Invalid hitmuxContext collection metadata.');
    }

    const schemaVersion = metadata?.schemaVersion ?? 1;
    const metadataVersion = metadata?.metadataVersion ?? 1;
    if (schemaVersion !== 2 || metadataVersion !== 2) {
        throw createSchemaMismatchError(collectionName, `Indexed schemaVersion=${schemaVersion}, metadataVersion=${metadataVersion}; current schemaVersion=2, metadataVersion=2.`);
    }
}
