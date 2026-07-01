import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { Context } from './context';
import { Embedding, EmbeddingVector } from './embedding';
import { CodeChunk, Splitter } from './splitter';
import { VectorDatabase, VectorDocument, VectorSearchResult, SearchOptions, HybridSearchRequest, HybridSearchResult, HybridSearchOptions, InsertOptions } from './vectordb';

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
                endLine: Math.max(1, code.split('\n').length),
                language,
                filePath,
            },
        }];
    }

    setChunkSize(): void { }

    setChunkOverlap(): void { }
}

class InMemoryVectorDatabase implements VectorDatabase {
    private readonly collections = new Set<string>();
    private readonly descriptions = new Map<string, string>();
    private readonly documents = new Map<string, VectorDocument[]>();

    async createCollection(collectionName: string, _dimension: number, description?: string): Promise<void> {
        this.collections.add(collectionName);
        this.documents.set(collectionName, []);
        if (description) {
            this.descriptions.set(collectionName, description);
        }
    }

    async createHybridCollection(collectionName: string, dimension: number, description?: string): Promise<void> {
        await this.createCollection(collectionName, dimension, description);
    }

    async ensureHybridCollectionReady(): Promise<void> { }

    async dropCollection(collectionName: string): Promise<void> {
        this.collections.delete(collectionName);
        this.descriptions.delete(collectionName);
        this.documents.delete(collectionName);
    }

    async hasCollection(collectionName: string): Promise<boolean> {
        return this.collections.has(collectionName);
    }

    async listCollections(): Promise<string[]> {
        return [...this.collections];
    }

    async insert(collectionName: string, documents: VectorDocument[], _options?: InsertOptions): Promise<void> {
        const existing = this.documents.get(collectionName) ?? [];
        existing.push(...documents);
        this.documents.set(collectionName, existing);
    }

    async insertHybrid(collectionName: string, documents: VectorDocument[], options?: InsertOptions): Promise<void> {
        await this.insert(collectionName, documents, options);
    }

    async search(collectionName: string, _queryVector: number[], options?: SearchOptions): Promise<VectorSearchResult[]> {
        const limit = options?.topK ?? 5;
        const documents = this.getDocuments(collectionName);
        return documents
            .filter(document => document.relativePath.endsWith('.kt') || document.relativePath.endsWith('.swift'))
            .slice(0, limit)
            .map((document, index) => ({
                document,
                score: 0.99 - index * 0.01,
            }));
    }

    async hybridSearch(
        collectionName: string,
        _searchRequests: HybridSearchRequest[],
        options?: HybridSearchOptions
    ): Promise<HybridSearchResult[]> {
        return this.search(collectionName, [], { topK: options?.limit });
    }

    async delete(collectionName: string, ids: string[]): Promise<void> {
        this.documents.set(
            collectionName,
            this.getDocuments(collectionName).filter(document => !ids.includes(document.id))
        );
    }

    async query(collectionName: string, filter: string, _outputFields: string[], limit: number = 100): Promise<Record<string, unknown>[]> {
        const documents = this.getDocuments(collectionName);
        const exactPath = this.matchQuotedValue(filter, /relativePath == "((?:\\"|[^"])*)"/);
        const exactBasename = this.matchQuotedValue(filter, /basename == "((?:\\"|[^"])*)"/);
        const exactExtension = this.matchQuotedValue(filter, /fileExtension == "((?:\\"|[^"])*)"/);
        const exactPrimarySymbols = [...filter.matchAll(/primarySymbol == "((?:\\"|[^"])*)"/g)]
            .map(match => this.unescapeFilterString(match[1]));

        return documents
            .filter(document => {
                if (exactPath) {
                    return document.relativePath === exactPath;
                }

                if (exactBasename && exactExtension) {
                    return document.basename === exactBasename && document.fileExtension === exactExtension;
                }

                if (exactPrimarySymbols.length > 0) {
                    return exactPrimarySymbols.includes(document.primarySymbol ?? '');
                }

                return false;
            })
            .slice(0, limit)
            .map(document => ({
                ...document,
                metadata: JSON.stringify(document.metadata),
            }));
    }

    async getCollectionDescription(collectionName: string): Promise<string> {
        const description = this.descriptions.get(collectionName);
        if (!description) {
            throw new Error(`Collection ${collectionName} does not exist`);
        }
        return description;
    }

    async checkCollectionLimit(): Promise<boolean> {
        return true;
    }

    async getCollectionRowCount(collectionName: string): Promise<number> {
        return this.getDocuments(collectionName).length;
    }

    getAllDocuments(): VectorDocument[] {
        return [...this.documents.values()].flat();
    }

    private getDocuments(collectionName: string): VectorDocument[] {
        return this.documents.get(collectionName) ?? [];
    }

    private matchQuotedValue(filter: string, pattern: RegExp): string | undefined {
        const match = filter.match(pattern);
        return match ? this.unescapeFilterString(match[1]) : undefined;
    }

    private unescapeFilterString(value: string): string {
        return value.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
}

describe('OpenClaw preflight retrieval smoke', () => {
    let tempRoot: string;
    let originalHome: string | undefined;

    beforeEach(async () => {
        tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hitmux-context-engine-openclaw-smoke-'));
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

    it('indexes common repo and mobile files and retrieves them with targetRole=all strong anchors', async () => {
        const project = path.join(tempRoot, 'fixture');
        await fs.mkdir(path.join(project, 'app', 'src', 'main', 'java'), { recursive: true });
        await fs.mkdir(path.join(project, 'ios'), { recursive: true });
        await fs.writeFile(path.join(project, 'app', 'src', 'main', 'AndroidManifest.xml'), '<manifest package="com.hitmux.openclaw"><application /></manifest>\n');
        await fs.writeFile(path.join(project, 'settings.gradle.kts'), 'pluginManagement { repositories { google() } }\n');
        await fs.writeFile(path.join(project, 'package.json'), '{"name":"openclaw-fixture","scripts":{"test":"vitest"}}\n');
        await fs.writeFile(path.join(project, 'AGENTS.md'), '# Agent guidance\nUse targetRole=all for repository-wide retrieval.\n');
        await fs.writeFile(path.join(project, 'app', 'src', 'main', 'java', 'OpenClawController.kt'), 'class OpenClawController { fun start() {} }\n');
        await fs.writeFile(path.join(project, 'ios', 'OpenClawView.swift'), 'final class OpenClawView {}\n');
        await fs.writeFile(path.join(project, 'package-lock.json'), '{}\n');
        await fs.writeFile(path.join(project, 'schema.generated.json'), '{}\n');

        const vectorDatabase = new InMemoryVectorDatabase();
        const context = new Context({
            hybridMode: false,
            embedding: new TestEmbedding(),
            vectorDatabase,
            codeSplitter: new OneChunkSplitter(),
        });

        await context.indexCodebase(project);

        const indexedPaths = vectorDatabase.getAllDocuments()
            .map(document => document.relativePath)
            .sort();
        expect(indexedPaths).toEqual([
            'AGENTS.md',
            'app/src/main/AndroidManifest.xml',
            'app/src/main/java/OpenClawController.kt',
            'ios/OpenClawView.swift',
            'package.json',
            'settings.gradle.kts',
        ]);

        await expectTopResult(context, project, 'AndroidManifest.xml', 'app/src/main/AndroidManifest.xml');
        await expectTopResult(context, project, 'settings.gradle.kts', 'settings.gradle.kts');
        await expectTopResult(context, project, 'package.json', 'package.json');
        await expectTopResult(context, project, 'AGENTS.md', 'AGENTS.md');
        await expectTopResult(context, project, 'app/src/main/AndroidManifest.xml', 'app/src/main/AndroidManifest.xml');
    });
});

async function expectTopResult(context: Context, project: string, query: string, expectedPath: string): Promise<void> {
    const results = await context.semanticSearch(project, query, 5, 0.3, undefined, {
        targetRole: 'all',
    });

    expect(results[0]).toMatchObject({
        relativePath: expectedPath,
        isPrimary: true,
    });
    expect(results[0].scoreReasons).toEqual(expect.arrayContaining(['exact_filename']));
}

async function writeConfig(homeDir: string, config: Record<string, unknown>): Promise<void> {
    const configDir = path.join(homeDir, '.hitmux-context-engine');
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
