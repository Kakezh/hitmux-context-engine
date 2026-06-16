import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { Context, ExistingCollectionFullIndexError } from './context';
import { Embedding, EmbeddingVector } from './embedding';
import { Splitter, CodeChunk } from './splitter';
import { VectorDatabase } from './vectordb';

class TestEmbedding extends Embedding {
    protected maxTokens = 8192;

    async detectDimension(): Promise<number> {
        return 3;
    }

    async embed(_text: string): Promise<EmbeddingVector> {
        return { vector: [1, 0, 0], dimension: 3 };
    }

    async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
        return texts.map(() => ({ vector: [1, 0, 0], dimension: 3 }));
    }

    getDimension(): number {
        return 3;
    }

    getProvider(): string {
        return 'test';
    }
}

class OneChunkSplitter implements Splitter {
    async split(code: string, language: string, filePath?: string): Promise<CodeChunk[]> {
        return [{
            content: code,
            metadata: {
                startLine: 1,
                endLine: 1,
                language,
                filePath,
            },
        }];
    }

    setChunkSize(): void { }
    setChunkOverlap(): void { }
}

class SlowTrackingEmbedding extends TestEmbedding {
    public activeRequests = 0;
    public maxActiveRequests = 0;

    async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
        this.activeRequests += 1;
        this.maxActiveRequests = Math.max(this.maxActiveRequests, this.activeRequests);
        try {
            await sleep(25);
            return texts.map(() => ({ vector: [1, 0, 0], dimension: 3 }));
        } finally {
            this.activeRequests -= 1;
        }
    }
}

const createVectorDatabase = (): jest.Mocked<VectorDatabase> => ({
    createCollection: jest.fn().mockResolvedValue(undefined),
    createHybridCollection: jest.fn().mockResolvedValue(undefined),
    ensureHybridCollectionReady: jest.fn().mockResolvedValue(undefined),
    dropCollection: jest.fn().mockResolvedValue(undefined),
    hasCollection: jest.fn().mockResolvedValue(false),
    listCollections: jest.fn().mockResolvedValue([]),
    insert: jest.fn().mockResolvedValue(undefined),
    insertHybrid: jest.fn().mockResolvedValue(undefined),
    search: jest.fn().mockResolvedValue([]),
    hybridSearch: jest.fn().mockResolvedValue([]),
    delete: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue([]),
    getCollectionDescription: jest.fn().mockResolvedValue(''),
    checkCollectionLimit: jest.fn().mockResolvedValue(true),
    getCollectionRowCount: jest.fn().mockResolvedValue(-1),
});

describe('Context indexing lifecycle', () => {
    let tempRoot: string;
    let originalHome: string | undefined;

    beforeEach(async () => {
        tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hitmux-context-engine-indexing-lifecycle-'));
        const homeDir = path.join(tempRoot, 'home');
        await fs.mkdir(homeDir, { recursive: true });
        originalHome = process.env.HOME;
        process.env.HOME = homeDir;
        await writeConfig(homeDir, { hybridMode: false });
    });

    afterEach(async () => {
        if (originalHome === undefined) {
            delete process.env.HOME;
        } else {
            process.env.HOME = originalHome;
        }
        await fs.rm(tempRoot, { recursive: true, force: true });
    });

    async function createProject(): Promise<string> {
        const project = path.join(tempRoot, 'project');
        await fs.mkdir(project);
        await fs.writeFile(path.join(project, 'index.ts'), 'export const value = 1;');
        return project;
    }

    it('rejects ordinary full indexing when the collection already exists', async () => {
        const project = await createProject();
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.hasCollection.mockResolvedValue(true);
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
            codeSplitter: new OneChunkSplitter(),
        });

        await expect(context.indexCodebase(project)).rejects.toBeInstanceOf(ExistingCollectionFullIndexError);
        expect(vectorDatabase.dropCollection).not.toHaveBeenCalled();
        expect(vectorDatabase.createCollection).not.toHaveBeenCalled();
        expect(vectorDatabase.insert).not.toHaveBeenCalled();
    });

    it('allows force reindexing to replace an existing collection', async () => {
        const project = await createProject();
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.hasCollection.mockResolvedValue(true);
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
            codeSplitter: new OneChunkSplitter(),
        });

        await expect(context.indexCodebase(project, undefined, true)).resolves.toMatchObject({
            indexedFiles: 1,
            totalChunks: 1,
            status: 'completed',
        });
        expect(vectorDatabase.dropCollection).toHaveBeenCalledWith(context.getCollectionName(project));
        expect(vectorDatabase.createCollection).toHaveBeenCalled();
        expect(vectorDatabase.insert).toHaveBeenCalled();
    });

    it('weights full indexing progress by file size instead of file count', async () => {
        const project = path.join(tempRoot, 'weighted-progress-project');
        await fs.mkdir(project);
        const smallFile = path.join(project, 'small.ts');
        const largeFile = path.join(project, 'large.ts');
        await fs.writeFile(smallFile, 'x');
        await fs.writeFile(largeFile, 'x'.repeat(10_000));

        const vectorDatabase = createVectorDatabase();
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
            codeSplitter: new OneChunkSplitter(),
        });
        const getCodeFilesSpy = jest
            .spyOn(context as unknown as { getCodeFiles: () => Promise<string[]> }, 'getCodeFiles')
            .mockResolvedValue([smallFile, largeFile]);
        const progress: Array<{ phase: string; current: number; total: number; percentage: number }> = [];

        try {
            await context.indexCodebase(project, update => progress.push(update));
        } finally {
            getCodeFilesSpy.mockRestore();
        }

        const firstFileComplete = progress.find(update => update.phase === 'Processing files (1/2)...');
        expect(firstFileComplete?.percentage).toBeLessThan(20);
        expect(progress.some(update => update.percentage === 95)).toBe(true);
        expect(progress.at(-1)?.percentage).toBe(100);
    });

    it('limits concurrent embedding batches across parallel index operations', async () => {
        const firstProject = await createProjectWithFiles(tempRoot, 'project-a', 3);
        const secondProject = await createProjectWithFiles(tempRoot, 'project-b', 3);
        await writeProjectConfig(firstProject, {
            embeddingBatchSize: 1,
            embeddingConcurrency: 2
        });
        await writeProjectConfig(secondProject, {
            embeddingBatchSize: 1,
            embeddingConcurrency: 2
        });
        const embedding = new SlowTrackingEmbedding();
        const context = new Context({
            hybridMode: false,
            embedding,
            vectorDatabase: createVectorDatabase(),
            codeSplitter: new OneChunkSplitter(),
        });

        const processFileList = (context as unknown as {
            processFileList: (
                filePaths: string[],
                codebasePath: string,
                onFileProcessed?: (filePath: string, fileIndex: number, totalFiles: number) => void,
                splitter?: Splitter
            ) => Promise<unknown>;
        }).processFileList.bind(context);
        const firstFiles = await listProjectFiles(firstProject);
        const secondFiles = await listProjectFiles(secondProject);

        await Promise.all([
            processFileList(firstFiles, firstProject, undefined, new OneChunkSplitter()),
            processFileList(secondFiles, secondProject, undefined, new OneChunkSplitter())
        ]);

        expect(embedding.maxActiveRequests).toBeGreaterThan(1);
        expect(embedding.maxActiveRequests).toBeLessThanOrEqual(2);
    });
});

async function createProjectWithFiles(root: string, name: string, count: number): Promise<string> {
    const project = path.join(root, name);
    await fs.mkdir(project, { recursive: true });
    for (let i = 0; i < count; i++) {
        await fs.writeFile(path.join(project, `file-${i}.ts`), `export const value${i} = ${i};`);
    }
    return project;
}

async function listProjectFiles(project: string): Promise<string[]> {
    const entries = await fs.readdir(project, { withFileTypes: true });
    return entries
        .filter(entry => entry.isFile())
        .map(entry => path.join(project, entry.name));
}

async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeConfig(homeDir: string, config: Record<string, unknown>): Promise<void> {
    const configDir = path.join(homeDir, '.hitmux-context-engine');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(path.join(configDir, 'config.conf'), stringifyConf(config), 'utf-8');
}

async function writeProjectConfig(projectRoot: string, config: Record<string, unknown>): Promise<void> {
    const configDir = path.join(projectRoot, '.hitmux-context-engine');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(path.join(configDir, 'config.conf'), stringifyConf(config), 'utf-8');
}

function stringifyConf(config: Record<string, unknown>): string {
    return Object.entries(config)
        .flatMap(([key, value]) => Array.isArray(value)
            ? value.map(item => `${key} = ${String(item)}`)
            : [`${key} = ${String(value)}`])
        .join('\n') + '\n';
}
