import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { Context } from './context';

async function withTempProject(run: (projectRoot: string) => Promise<void>): Promise<void> {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'hitmux-context-engine-trace-'));
    const projectRoot = path.join(tempRoot, 'repo');
    try {
        await mkdir(projectRoot, { recursive: true });
        await run(projectRoot);
    } finally {
        await rm(tempRoot, { recursive: true, force: true });
    }
}

function createContext(): Context {
    return new Context({
        vectorDatabase: {} as any,
        supportedExtensions: ['.ts']
    });
}

describe('Context traceSymbol', () => {
    it('finds definitions, facade references, imports, exports, and related tests', async () => {
        await withTempProject(async (projectRoot) => {
            await mkdir(path.join(projectRoot, 'src/game/entities'), { recursive: true });
            await mkdir(path.join(projectRoot, 'src/game'), { recursive: true });

            await writeFile(path.join(projectRoot, 'src/game/entities/entityManager.ts'), [
                'export class EntityManager {',
                '    addTower(tower: TowerLike): void {}',
                '    removeMonster(monster: MonsterLike): void {}',
                '}',
                '',
                'export interface TowerLike {}',
                'export interface MonsterLike {}'
            ].join('\n'));
            await writeFile(path.join(projectRoot, 'src/game/entities/entityManager.test.ts'), [
                "import { EntityManager } from './entityManager';",
                '',
                "test('EntityManager updates entities', () => {",
                '    expect(new EntityManager()).toBeTruthy();',
                '});'
            ].join('\n'));
            await writeFile(path.join(projectRoot, 'src/game/entities/index.ts'), [
                "export { EntityManager } from './entityManager';"
            ].join('\n'));
            await writeFile(path.join(projectRoot, 'src/game/world.ts'), [
                "import { EntityManager } from './entities';",
                '',
                'export class World {',
                '    private readonly _entityManager: EntityManager;',
                '',
                '    constructor() {',
                '        this._entityManager = new EntityManager();',
                '    }',
                '',
                '    addTower(tower: TowerLike): void {',
                '        this._entityManager.addTower(tower);',
                '    }',
                '}',
                '',
                'interface TowerLike {}'
            ].join('\n'));

            const trace = await createContext().traceSymbol(projectRoot, 'EntityManager', {
                startPath: 'src/game/world.ts'
            });

            expect(trace.definitions).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    relativePath: 'src/game/entities/entityManager.ts',
                    line: 1,
                    kind: 'definition'
                })
            ]));
            expect(trace.imports).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    relativePath: 'src/game/world.ts',
                    line: 1,
                    kind: 'import',
                    moduleSpecifier: './entities',
                    resolvedPath: 'src/game/entities/index.ts'
                })
            ]));
            expect(trace.exports).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    relativePath: 'src/game/entities/index.ts',
                    line: 1,
                    kind: 'export',
                    moduleSpecifier: './entityManager',
                    resolvedPath: 'src/game/entities/entityManager.ts'
                })
            ]));
            expect(trace.references).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    relativePath: 'src/game/world.ts',
                    line: 11,
                    matchedText: '_entityManager',
                    enclosingSymbol: 'World.addTower',
                    callTarget: 'EntityManager.addTower'
                })
            ]));
            expect(trace.relatedTests).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    relativePath: 'src/game/entities/entityManager.test.ts',
                    kind: 'related_test'
                })
            ]));
            expect(trace.truncated).toBe(false);
        });
    });

    it('rejects non-identifier symbols', async () => {
        await withTempProject(async (projectRoot) => {
            await expect(createContext().traceSymbol(projectRoot, '../EntityManager')).rejects.toThrow('valid identifier');
        });
    });
});
