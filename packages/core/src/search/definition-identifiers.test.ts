import { extractDefinitionIdentifiers } from './definition-identifiers';

describe('extractDefinitionIdentifiers', () => {
    it('extracts definition symbols from C, CMake, TOML, Rust, and Go content', () => {
        const content = [
            'static void lrangeCommand(client *c) {',
            '    replyToClient(c);',
            '}',
            '#define CMD_ARG(name) name',
            'struct serverCommandTable { int argc; };',
            '{ .handler = lrangeCommand },',
            'MAKE_CMD("xread", "Reads streams", xreadCommand, -4)',
            'function(register_valkey_sources)',
            'endfunction()',
            'macro(add_tls_module)',
            'endmacro()',
            '[dependency-groups]',
            '[tool.ruff.lint]',
            'pub(crate) enum SearchMode { Exact }',
            'pub trait SearchProvider {}',
            'pub mod planner;',
            'func init() {}',
        ].join('\n');

        expect(extractDefinitionIdentifiers(content)).toEqual(expect.arrayContaining([
            'lrangeCommand',
            'CMD_ARG',
            'serverCommandTable',
            'xreadCommand',
            'register_valkey_sources',
            'add_tls_module',
            'dependency-groups',
            'tool.ruff.lint',
            'lint',
            'SearchMode',
            'SearchProvider',
            'planner',
            'init',
        ]));
    });

    it('does not treat comments, string literals, or generic calls as definitions', () => {
        const content = [
            '// export function CommentedOut() {}',
            '# def python_comment():',
            '# TODO update docs',
            'const text = "function StringOnly() {}";',
            'logger.info("struct NotAType { int value; }");',
            'console.log(".handler = FakeHandler");',
            'const raw = `.callback = FakeCallback`;',
            'foo bar GenericCall(',
            'if (condition) {',
            '    runTask();',
            '}',
        ].join('\n');

        expect(extractDefinitionIdentifiers(content)).not.toEqual(expect.arrayContaining([
            'CommentedOut',
            'python_comment',
            'def python_comment():',
            'TODO update docs',
            'StringOnly',
            'NotAType',
            'FakeHandler',
            'FakeCallback',
            'GenericCall',
            'condition',
            'runTask',
        ]));
    });

    it('keeps Go startup files from triggering cross-line regex backtracking', () => {
        const flagLines = Array.from({ length: 120 }, (_, index) =>
            `\tflag.StringVar(&option${index}, "option-${index}", "", "option ${index}")`
        );
        const content = [
            'package main',
            '',
            'import (',
            '\t"context"',
            '\t"flag"',
            '\t"fmt"',
            '\t"os"',
            ')',
            '',
            'func init() {',
            '\tsetupLogger()',
            '}',
            '',
            'func shouldStartServer(commandMode, tuiMode, standalone bool) bool {',
            '\tif commandMode || (tuiMode && !standalone) {',
            '\t\treturn false',
            '\t}',
            '\treturn true',
            '}',
            '',
            'func main() {',
            '\tvar commandMode bool',
            '\tvar tuiMode bool',
            '\tvar standalone bool',
            ...flagLines,
            '\tif shouldStartServer(commandMode, tuiMode, standalone) {',
            '\t\tfmt.Println(os.Args)',
            '\t}',
            '}',
        ].join('\n');

        const startedAt = Date.now();
        const identifiers = extractDefinitionIdentifiers(content);

        expect(Date.now() - startedAt).toBeLessThan(100);
        expect(identifiers).toEqual(expect.arrayContaining([
            'init',
            'shouldStartServer',
            'main',
        ]));
    });

    it('bounds scanning time for long non-definition lines', () => {
        const longGenericCall = `${'VeryLongType '.repeat(4000)}notAFunctionCallWithoutTerminator`;
        const content = [
            longGenericCall,
            'func stillFound() {}',
        ].join('\n');

        const startedAt = Date.now();
        const identifiers = extractDefinitionIdentifiers(content);

        expect(Date.now() - startedAt).toBeLessThan(100);
        expect(identifiers).toEqual(expect.arrayContaining(['stillFound']));
    });

    it('does not backtrack on prose lines with parenthesized notes', () => {
        const content = [
            'The documentation content in this repository may be quite extensive. The current statistics for the `docs/` directory (the following data may not be updated in real time):',
            'public String stillFound() {',
            '    return "ok";',
            '}',
        ].join('\n');

        const startedAt = Date.now();
        const identifiers = extractDefinitionIdentifiers(content);

        expect(Date.now() - startedAt).toBeLessThan(100);
        expect(identifiers).toEqual(expect.arrayContaining(['stillFound']));
    });

    it('keeps Markdown prose bounded without running broad method rules', () => {
        const content = [
            '# Recovery Notes',
            'The documentation content in this repository may be quite extensive. The current statistics for the `docs/` directory (the following data may not be updated in real time):',
            '| Command | Description |',
            '| --- | --- |',
            `| ${'very-long-column-value '.repeat(1000)} | https://example.test/${'nested/path/'.repeat(500)} |`,
            'public String notMarkdownCode() {',
            '普通中文说明（包含很多括号（但不是代码定义））'.repeat(500),
        ].join('\n');

        const startedAt = Date.now();
        const identifiers = extractDefinitionIdentifiers(content, {
            language: 'markdown',
            fileExtension: '.md',
            relativePath: 'README.md',
        });

        expect(Date.now() - startedAt).toBeLessThan(100);
        expect(identifiers).toEqual(expect.arrayContaining(['Recovery Notes']));
        expect(identifiers).not.toEqual(expect.arrayContaining(['notMarkdownCode']));
    });

    it('extracts definitions from fenced Markdown code without scanning prose as Java-like code', () => {
        const content = [
            '# API Notes',
            'The current plan (updated);',
            '',
            '```java',
            'public String getName() { return ""; }',
            '```',
            '',
            '```csharp',
            'public string BuildName() { return ""; }',
            '```',
        ].join('\n');

        const identifiers = extractDefinitionIdentifiers(content, {
            language: 'markdown',
            fileExtension: '.md',
        });

        expect(identifiers).toEqual(expect.arrayContaining(['API Notes', 'getName', 'BuildName']));
        expect(identifiers).not.toEqual(expect.arrayContaining(['plan']));
    });

    it('bounds scanning for minified JavaScript, JSON schema, long URLs, and long prose', () => {
        const events: unknown[] = [];
        const minifiedJs = `function foundAtStart(){return 1};${'var x=(x||0)+1;'.repeat(30000)}`;
        const jsonSchema = `{"type":"object","properties":{${Array.from({ length: 5000 }, (_, index) => `"field${index}":{"type":"string"}`).join(',')}}}`;
        const prose = `${'This is a long prose sentence with parenthesized notes (not a method definition). '.repeat(5000)} https://example.test/${'a/'.repeat(5000)}`;
        const content = [minifiedJs, jsonSchema, prose].join('\n');

        const startedAt = Date.now();
        const identifiers = extractDefinitionIdentifiers(content, {
            language: 'javascript',
            fileExtension: '.js',
            relativePath: 'package/preprocessed/cli.original.readable.js',
            onEvent: event => events.push(event),
        });

        expect(Date.now() - startedAt).toBeLessThan(100);
        expect(identifiers).toEqual(expect.arrayContaining(['foundAtStart']));
        expect(identifiers.length).toBeLessThanOrEqual(128);
        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'limit', reason: 'maxChars' }),
        ]));
    });

    it('preserves supported language positives while applying language-specific rules', () => {
        expect(extractDefinitionIdentifiers('export function renderPanel() {}', { language: 'typescript', fileExtension: '.ts' })).toContain('renderPanel');
        expect(extractDefinitionIdentifiers('async def load_user():\n    pass', { language: 'python', fileExtension: '.py' })).toContain('load_user');
        expect(extractDefinitionIdentifiers('func (s *Server) ServeHTTP() {}', { language: 'go', fileExtension: '.go' })).toContain('ServeHTTP');
        expect(extractDefinitionIdentifiers('pub(crate) fn build_index() {}', { language: 'rust', fileExtension: '.rs' })).toContain('build_index');
        expect(extractDefinitionIdentifiers('public string BuildName() { return ""; }', { language: 'csharp', fileExtension: '.cs' })).toContain('BuildName');
        expect(extractDefinitionIdentifiers('public String getName() { return ""; }', { language: 'java', fileExtension: '.java' })).toContain('getName');
        expect(extractDefinitionIdentifiers('function(add_core_sources)', { language: 'cmake', relativePath: 'CMakeLists.txt' })).toContain('add_core_sources');
        expect(extractDefinitionIdentifiers('[tool.ruff.lint]', { language: 'toml', fileExtension: '.toml' })).toEqual(expect.arrayContaining(['tool.ruff.lint', 'lint']));
    });

    it('does not treat Java-like statements or prose as definitions', () => {
        const javaIdentifiers = extractDefinitionIdentifiers([
            'return render(value);',
            'yield return BuildName(input);',
            'if (ready) {',
            'builder.withName(value);',
            'public String getName() { return ""; }',
        ].join('\n'), {
            language: 'java',
            fileExtension: '.java',
        });
        const fallbackIdentifiers = extractDefinitionIdentifiers('The current plan (updated);');

        expect(javaIdentifiers).toEqual(expect.arrayContaining(['getName']));
        expect(javaIdentifiers).not.toEqual(expect.arrayContaining(['render', 'BuildName', 'ready', 'withName']));
        expect(fallbackIdentifiers).not.toEqual(expect.arrayContaining(['plan']));
    });

    it('does not extract identifiers from data-only formats', () => {
        const content = JSON.stringify({
            script: 'function FakeFunction() {}',
            handler: '.handler = FakeHandler',
            struct: 'struct FakeType { int value; }',
        });

        expect(extractDefinitionIdentifiers(content, {
            language: 'json',
            fileExtension: '.json',
            relativePath: 'package.json',
        })).toEqual([]);
    });

    it('enforces caller-supplied scan budgets and identifier caps', () => {
        const content = Array.from({ length: 20 }, (_, index) => `export const value${index} = ${index};`).join('\n');
        const events: unknown[] = [];

        const identifiers = extractDefinitionIdentifiers(content, {
            language: 'typescript',
            fileExtension: '.ts',
            maxLines: 10,
            maxIdentifiers: 5,
            onEvent: event => events.push(event),
        });

        expect(identifiers).toHaveLength(5);
        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'limit', reason: 'maxIdentifiers' }),
        ]));
    });
});
