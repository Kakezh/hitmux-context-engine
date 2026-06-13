import {
    classifyFileRole,
    inferFileRoleIntent,
    isFileRoleExplicitlyRequested,
} from './file-role';

describe('file role classification and intent', () => {
    it('does not treat standalone config as explicit config intent', () => {
        const intent = inferFileRoleIntent('TowerRegistry config');

        expect(intent.preferredRoles.has('config')).toBe(false);
        expect(isFileRoleExplicitlyRequested('config', intent, 'src/config/towers.ts')).toBe(false);
        expect(isFileRoleExplicitlyRequested('implementation', intent, 'src/towers/towerRegistry.ts')).toBe(true);
    });

    it('treats config file wording and config extensions as explicit config intent', () => {
        const configFileIntent = inferFileRoleIntent('TowerRegistry config file');
        const jsonIntent = inferFileRoleIntent('TowerRegistry .json');

        expect(configFileIntent.preferredRoles.has('config')).toBe(true);
        expect(jsonIntent.preferredRoles.has('config')).toBe(true);
        expect(jsonIntent.explicitExtensions.has('.json')).toBe(true);
        expect(isFileRoleExplicitlyRequested('config', configFileIntent, 'src/config/towers.ts')).toBe(true);
        expect(isFileRoleExplicitlyRequested('config', jsonIntent, 'src/config/towers.json')).toBe(true);
    });

    it('classifies test docs style config and generated roles independently of query wording', () => {
        expect(classifyFileRole('src/towers/towerRegistry.test.ts')).toBe('test');
        expect(classifyFileRole('docs/towers/README.md')).toBe('docs');
        expect(classifyFileRole('src/styles/index.less')).toBe('style');
        expect(classifyFileRole('src/towers/config/factory.ts')).toBe('config');
        expect(classifyFileRole('src/generated/towers.ts')).toBe('generated');
        expect(classifyFileRole('src/towers/towerRegistry.ts')).toBe('implementation');
    });

    it('recognizes common multi-language test file naming patterns', () => {
        expect(classifyFileRole('src/rooms/roomRegistry.spec.ts')).toBe('test');
        expect(classifyFileRole('server/rooms/room_registry_test.go')).toBe('test');
        expect(classifyFileRole('python/test_room_registry.py')).toBe('test');
        expect(classifyFileRole('python/room_registry_test.py')).toBe('test');
        expect(classifyFileRole('src/RoomRegistryTest.java')).toBe('test');
        expect(classifyFileRole('src/RoomRegistryTests.cs')).toBe('test');
        expect(classifyFileRole('lib/room_registry_spec.rb')).toBe('test');
    });

    it('classifies pure module index files as barrel exports', () => {
        expect(classifyFileRole(
            'src/towers/index.ts',
            '.ts',
            [
                "export { TowerRegistry } from './towerRegistry';",
                "export type { TowerDefinition } from './types';",
            ].join('\n')
        )).toBe('barrel');

        expect(classifyFileRole(
            'src/game/__init__.py',
            '.py',
            [
                'from .entity_manager import EntityManager',
                "__all__ = ['EntityManager']",
            ].join('\n')
        )).toBe('barrel');
    });

    it('keeps module index files with real implementation as implementation owners', () => {
        expect(classifyFileRole(
            'src/towers/index.ts',
            '.ts',
            [
                'export class TowerRegistry {',
                '    register(): void {}',
                '}',
            ].join('\n')
        )).toBe('implementation');

        expect(classifyFileRole(
            'src/game/__init__.py',
            '.py',
            [
                'class EntityManager:',
                '    pass',
            ].join('\n')
        )).toBe('implementation');
    });

    it('recognizes conventional runtime entrypoint filenames', () => {
        expect(classifyFileRole('src/main.ts', '.ts', 'bootstrap();')).toBe('entrypoint');
        expect(classifyFileRole('server/app.py', '.py', 'create_app()')).toBe('entrypoint');
    });
});
