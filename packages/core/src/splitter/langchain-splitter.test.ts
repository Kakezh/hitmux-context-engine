import { LangChainCodeSplitter } from './langchain-splitter';

describe('LangChainCodeSplitter fallback line estimation', () => {
    it('locates repeated generic chunks after the previous match', () => {
        const splitter = new LangChainCodeSplitter() as unknown as {
            estimateLines(chunk: string, originalCode: string, searchOffset: number): {
                start: number;
                end: number;
                nextSearchOffset: number;
            };
        };
        const code = [
            'repeat();',
            'middle();',
            'repeat();',
            'done();',
        ].join('\n');

        const first = splitter.estimateLines('repeat();', code, 0);
        const second = splitter.estimateLines('repeat();', code, first.nextSearchOffset);

        expect(first).toMatchObject({ start: 1, end: 1 });
        expect(second).toMatchObject({ start: 3, end: 3 });
    });

    it('produces line-bounded generic chunks for config and mobile build formats', async () => {
        const splitter = new LangChainCodeSplitter(80, 10);
        const samples = [
            { language: 'json', filePath: 'package.json', content: '{\n  "name": "fixture",\n  "scripts": { "test": "vitest" }\n}\n' },
            { language: 'yaml', filePath: 'settings.yaml', content: 'android:\n  namespace: com.hitmux.fixture\n' },
            { language: 'xml', filePath: 'AndroidManifest.xml', content: '<manifest package="com.hitmux.fixture">\n  <application />\n</manifest>\n' },
            { language: 'plist', filePath: 'Info.plist', content: '<plist>\n  <dict>\n    <key>CFBundleName</key>\n  </dict>\n</plist>\n' },
            { language: 'gradle', filePath: 'build.gradle', content: 'plugins {\n  id "com.android.application"\n}\n' },
            { language: 'kotlin', filePath: 'settings.gradle.kts', content: 'pluginManagement {\n  repositories { google() }\n}\n' },
        ];

        for (const sample of samples) {
            const chunks = await splitter.split(sample.content, sample.language, sample.filePath);

            expect(chunks.length).toBeGreaterThan(0);
            for (const chunk of chunks) {
                expect(chunk.content.trim().length).toBeGreaterThan(0);
                expect(chunk.metadata.language).toBe(sample.language);
                expect(chunk.metadata.filePath).toBe(sample.filePath);
                expect(chunk.metadata.startLine).toBeGreaterThanOrEqual(1);
                expect(chunk.metadata.endLine).toBeGreaterThanOrEqual(chunk.metadata.startLine);
            }
        }
    });
});
