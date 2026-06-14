import * as fs from 'fs';
import * as path from 'path';
import {
    SymbolTraceEvidence,
    SymbolTraceOptions,
    SymbolTraceResult
} from '../types';
import { classifyFileRole } from './file-role';

interface TraceLineContext {
    enclosingSymbol?: string;
}

export interface TraceSymbolInput {
    codebasePath: string;
    symbol: string;
    options?: SymbolTraceOptions;
    files: string[];
    supportedExtensions: string[];
}

export async function traceSymbolInFiles(input: TraceSymbolInput): Promise<SymbolTraceResult> {
    const normalizedSymbol = input.symbol.trim();
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(normalizedSymbol)) {
        throw new Error('traceSymbol requires a valid identifier symbol.');
    }

    const traceOptions = normalizeSymbolTraceOptions(input.options ?? {});
    const startPath = normalizeTraceStartPath(input.codebasePath, traceOptions.startPath);
    const orderedFiles = orderTraceFiles(input.files, input.codebasePath, startPath);
    const filesToScan = orderedFiles.slice(0, traceOptions.maxFiles);
    const escapedSymbol = escapeRegExp(normalizedSymbol);
    const symbolRegex = new RegExp(`\\b${escapedSymbol}\\b`);
    const definitions: SymbolTraceEvidence[] = [];
    const references: SymbolTraceEvidence[] = [];
    const imports: SymbolTraceEvidence[] = [];
    const exports: SymbolTraceEvidence[] = [];
    const relatedTests: SymbolTraceEvidence[] = [];
    const warnings: string[] = [];
    const referenceCollectionLimit = Math.min(traceOptions.maxReferences * 4, 1000);
    let truncated = orderedFiles.length > filesToScan.length;

    for (const filePath of filesToScan) {
        let content: string;
        try {
            content = await fs.promises.readFile(filePath, 'utf-8');
        } catch (error) {
            warnings.push(`Unable to read ${path.relative(input.codebasePath, filePath).replace(/\\/g, '/')}: ${error instanceof Error ? error.message : String(error)}`);
            continue;
        }

        const relativePath = path.relative(input.codebasePath, filePath).replace(/\\/g, '/');
        const extension = path.posix.extname(relativePath);
        const fileRole = classifyFileRole(relativePath, extension, content);
        const localAliases = extractSymbolAliases(content, escapedSymbol);
        const lineMatchers = createTraceLineMatchers(escapedSymbol, localAliases);
        const lines = content.split(/\r?\n/);
        const lineContexts = extractTraceLineContexts(lines);

        for (let index = 0; index < lines.length; index++) {
            const line = lines[index];
            const preview = line.trim();
            if (preview.length === 0) {
                continue;
            }

            const lineNumber = index + 1;
            const isDefinition = isTraceDefinitionLine(line, escapedSymbol);
            const isImport = /\bimport\b/.test(line) && symbolRegex.test(line);
            const isExport = /\bexport\b/.test(line) && symbolRegex.test(line);
            const moduleSpecifier = isImport || isExport ? extractTraceModuleSpecifier(line) : undefined;
            const resolvedPath = moduleSpecifier
                ? resolveTraceModulePath(input.codebasePath, relativePath, moduleSpecifier, input.supportedExtensions)
                : undefined;
            const matchedReference = lineMatchers.find(matcher => matcher.regex.test(line));
            const lineContext = lineContexts[index] ?? {};
            const callTarget = matchedReference
                ? extractTraceCallTarget(line, normalizedSymbol, matchedReference.label)
                : undefined;

            if (isDefinition) {
                pushTraceEvidence(definitions, {
                    kind: 'definition',
                    relativePath,
                    line: lineNumber,
                    preview,
                    matchedText: normalizedSymbol,
                    enclosingSymbol: lineContext.enclosingSymbol
                }, traceOptions.maxReferences);
            }

            if (isImport) {
                pushTraceEvidence(imports, {
                    kind: 'import',
                    relativePath,
                    line: lineNumber,
                    preview,
                    matchedText: normalizedSymbol,
                    moduleSpecifier,
                    resolvedPath,
                    enclosingSymbol: lineContext.enclosingSymbol
                }, traceOptions.maxReferences);
            }

            if (isExport) {
                pushTraceEvidence(exports, {
                    kind: 'export',
                    relativePath,
                    line: lineNumber,
                    preview,
                    matchedText: normalizedSymbol,
                    moduleSpecifier,
                    resolvedPath,
                    enclosingSymbol: lineContext.enclosingSymbol
                }, traceOptions.maxReferences);
            }

            if (matchedReference && !isDefinition && !isImport && !isExport && !isTraceCommentOnlyLine(preview)) {
                const added = pushTraceEvidence(references, {
                    kind: 'reference',
                    relativePath,
                    line: lineNumber,
                    preview,
                    matchedText: matchedReference.label,
                    enclosingSymbol: lineContext.enclosingSymbol,
                    callTarget
                }, referenceCollectionLimit);
                truncated = truncated || !added;
            }

            if (
                traceOptions.includeTests &&
                fileRole === 'test' &&
                symbolRegex.test(line) &&
                !isTraceCommentOnlyLine(preview)
            ) {
                pushTraceEvidence(relatedTests, {
                    kind: 'related_test',
                    relativePath,
                    line: lineNumber,
                    preview,
                    matchedText: normalizedSymbol,
                    enclosingSymbol: lineContext.enclosingSymbol
                }, traceOptions.maxReferences);
            }
        }
    }

    const orderedReferences = orderTraceReferences(references, startPath, traceOptions);
    truncated = truncated || orderedReferences.length > traceOptions.maxReferences;

    return {
        symbol: normalizedSymbol,
        codebasePath: input.codebasePath,
        definitions,
        references: orderedReferences.slice(0, traceOptions.maxReferences),
        imports,
        exports,
        relatedTests,
        scannedFiles: filesToScan.length,
        truncated,
        warnings
    };
}

function normalizeSymbolTraceOptions(options: SymbolTraceOptions): Required<SymbolTraceOptions> {
    const maxFiles = Number.isFinite(options.maxFiles) && (options.maxFiles ?? 0) > 0
        ? Math.min(Math.floor(options.maxFiles ?? 0), 2000)
        : 1000;
    const maxReferences = Number.isFinite(options.maxReferences) && (options.maxReferences ?? 0) > 0
        ? Math.min(Math.floor(options.maxReferences ?? 0), 200)
        : 40;
    const startLine = Number.isFinite(options.startLine) && (options.startLine ?? 0) > 0
        ? Math.floor(options.startLine ?? 0)
        : 0;
    const endLine = Number.isFinite(options.endLine) && (options.endLine ?? 0) >= startLine && startLine > 0
        ? Math.floor(options.endLine ?? 0)
        : 0;

    return {
        startPath: typeof options.startPath === 'string' ? options.startPath : '',
        startLine,
        endLine,
        maxFiles,
        maxReferences,
        includeTests: options.includeTests !== false
    };
}

function normalizeTraceStartPath(codebasePath: string, startPath: string): string {
    if (startPath.trim().length === 0) {
        return '';
    }

    const absoluteStartPath = path.isAbsolute(startPath)
        ? path.normalize(startPath)
        : path.resolve(codebasePath, startPath);
    const relativePath = path.relative(codebasePath, absoluteStartPath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        return '';
    }

    return relativePath.replace(/\\/g, '/');
}

function orderTraceFiles(files: string[], codebasePath: string, startPath: string): string[] {
    return [...files].sort((a, b) => {
        const relativeA = path.relative(codebasePath, a).replace(/\\/g, '/');
        const relativeB = path.relative(codebasePath, b).replace(/\\/g, '/');
        const priorityA = startPath.length > 0 && relativeA === startPath ? 0 : 1;
        const priorityB = startPath.length > 0 && relativeB === startPath ? 0 : 1;
        return priorityA - priorityB || relativeA.localeCompare(relativeB);
    });
}

function extractSymbolAliases(content: string, escapedSymbol: string): string[] {
    const aliases = new Set<string>();
    const aliasPatterns = [
        new RegExp(`\\b([A-Za-z_$][A-Za-z0-9_$]*)\\s*:\\s*${escapedSymbol}\\b`, 'g'),
        new RegExp(`\\b(?:const|let|var)\\s+([A-Za-z_$][A-Za-z0-9_$]*)\\s*=\\s*new\\s+${escapedSymbol}\\b`, 'g'),
        new RegExp(`\\bthis\\.([A-Za-z_$][A-Za-z0-9_$]*)\\s*=\\s*new\\s+${escapedSymbol}\\b`, 'g')
    ];

    for (const pattern of aliasPatterns) {
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(content)) !== null) {
            aliases.add(match[1]);
        }
    }

    return [...aliases];
}

function extractTraceLineContexts(lines: string[]): TraceLineContext[] {
    const contexts: TraceLineContext[] = [];
    let braceDepth = 0;
    let currentClass: { name: string; depth: number } | undefined;
    let currentScope: { name: string; depth: number } | undefined;

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        const trimmed = line.trim();

        while (currentScope && braceDepth < currentScope.depth) {
            currentScope = undefined;
        }
        while (currentClass && braceDepth < currentClass.depth) {
            currentClass = undefined;
        }

        const classMatch = trimmed.match(/\b(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/);
        if (classMatch) {
            currentClass = { name: classMatch[1], depth: braceDepth + 1 };
        }

        const functionName = extractTraceEnclosingFunctionName(trimmed);
        if (functionName) {
            currentScope = {
                name: currentClass ? `${currentClass.name}.${functionName}` : functionName,
                depth: braceDepth + 1
            };
        }

        contexts[index] = {
            enclosingSymbol: currentScope?.name ?? currentClass?.name
        };

        braceDepth += countTraceBraceDelta(line);
        if (braceDepth < 0) {
            braceDepth = 0;
        }
    }

    return contexts;
}

function orderTraceReferences(
    references: SymbolTraceEvidence[],
    startPath: string,
    options: Required<SymbolTraceOptions>
): SymbolTraceEvidence[] {
    return [...references].sort((a, b) => {
        const rangePriority = Number(isPreferredTraceReference(b, startPath, options))
            - Number(isPreferredTraceReference(a, startPath, options));
        if (rangePriority !== 0) {
            return rangePriority;
        }

        const pathPriority = Number(startPath.length > 0 && b.relativePath === startPath)
            - Number(startPath.length > 0 && a.relativePath === startPath);
        if (pathPriority !== 0) {
            return pathPriority;
        }

        const callPriority = Number(Boolean(b.callTarget)) - Number(Boolean(a.callTarget));
        if (callPriority !== 0) {
            return callPriority;
        }

        const callerPriority = Number(Boolean(b.enclosingSymbol)) - Number(Boolean(a.enclosingSymbol));
        if (callerPriority !== 0) {
            return callerPriority;
        }

        return a.relativePath.localeCompare(b.relativePath) || a.line - b.line;
    });
}

function isPreferredTraceReference(
    reference: SymbolTraceEvidence,
    startPath: string,
    options: Required<SymbolTraceOptions>
): boolean {
    return startPath.length > 0
        && reference.relativePath === startPath
        && options.startLine > 0
        && options.endLine > 0
        && reference.line >= options.startLine
        && reference.line <= options.endLine;
}

function extractTraceEnclosingFunctionName(trimmedLine: string): string | undefined {
    const patterns = [
        /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/,
        /\b(?:async\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*[:=]\s*(?:async\s*)?\([^)]*\)\s*=>/,
        /^(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+|async\s+|override\s+|abstract\s+)*([A-Za-z_$][A-Za-z0-9_$]*)\s*\([^)]*\)\s*(?::\s*[^=]+)?\s*\{/
    ];

    for (const pattern of patterns) {
        const match = trimmedLine.match(pattern);
        if (match?.[1] && !isUnhelpfulTraceScopeName(match[1])) {
            return match[1];
        }
    }

    return undefined;
}

function isUnhelpfulTraceScopeName(name: string): boolean {
    return new Set(['if', 'for', 'while', 'switch', 'catch', 'function']).has(name);
}

function countTraceBraceDelta(line: string): number {
    let delta = 0;
    let quote: string | undefined;
    let escaped = false;
    for (const char of line) {
        if (quote) {
            if (escaped) {
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (char === quote) {
                quote = undefined;
            }
            continue;
        }

        if (char === '"' || char === "'" || char === '`') {
            quote = char;
        } else if (char === '{') {
            delta += 1;
        } else if (char === '}') {
            delta -= 1;
        }
    }

    return delta;
}

function extractTraceCallTarget(line: string, symbol: string, matchedLabel: string): string | undefined {
    const escapedLabel = escapeRegExp(matchedLabel);
    const memberCall = line.match(new RegExp(`(?:\\bthis\\.)?\\b${escapedLabel}\\b\\.([A-Za-z_$][A-Za-z0-9_$]*)\\s*\\(`));
    if (memberCall?.[1]) {
        return `${symbol}.${memberCall[1]}`;
    }

    const directCall = line.match(new RegExp(`\\b${escapeRegExp(symbol)}\\s*\\(`));
    if (directCall) {
        return symbol;
    }

    return undefined;
}

function extractTraceModuleSpecifier(line: string): string | undefined {
    const fromMatch = line.match(/\b(?:import|export)\b[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/);
    if (fromMatch?.[1]) {
        return fromMatch[1];
    }

    const sideEffectImportMatch = line.match(/\bimport\s*['"]([^'"]+)['"]/);
    return sideEffectImportMatch?.[1];
}

function resolveTraceModulePath(
    codebasePath: string,
    importerRelativePath: string,
    moduleSpecifier: string,
    supportedExtensions: string[]
): string | undefined {
    if (!moduleSpecifier.startsWith('.') && !moduleSpecifier.startsWith('/')) {
        return undefined;
    }

    const importerAbsolutePath = path.resolve(codebasePath, importerRelativePath);
    const importerDir = path.dirname(importerAbsolutePath);
    const absoluteBase = moduleSpecifier.startsWith('/')
        ? path.resolve(codebasePath, moduleSpecifier.replace(/^\/+/, ''))
        : path.resolve(importerDir, moduleSpecifier);
    const relativeBase = path.relative(codebasePath, absoluteBase);
    if (relativeBase.startsWith('..') || path.isAbsolute(relativeBase)) {
        return undefined;
    }

    for (const candidate of getTraceModulePathCandidates(absoluteBase, supportedExtensions)) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            return path.relative(codebasePath, candidate).replace(/\\/g, '/');
        }
    }

    return undefined;
}

function getTraceModulePathCandidates(absoluteBase: string, supportedExtensions: string[]): string[] {
    const candidates = new Set<string>();
    const existingExtension = path.extname(absoluteBase);
    const extensions = getTraceModuleExtensions(supportedExtensions);

    candidates.add(absoluteBase);
    if (existingExtension.length === 0) {
        for (const extension of extensions) {
            candidates.add(`${absoluteBase}${extension}`);
        }
    }

    for (const extension of extensions) {
        candidates.add(path.join(absoluteBase, `index${extension}`));
    }

    return [...candidates];
}

function getTraceModuleExtensions(supportedExtensions: string[]): string[] {
    const commonExtensions = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'];
    return [...new Set([...supportedExtensions, ...commonExtensions])];
}

function createTraceLineMatchers(escapedSymbol: string, aliases: string[]): Array<{ regex: RegExp; label: string }> {
    return [
        { regex: new RegExp(`\\b${escapedSymbol}\\b`), label: escapedSymbol.replace(/\\/g, '') },
        ...aliases.map(alias => ({
            regex: new RegExp(`(?:\\bthis\\.)?\\b${escapeRegExp(alias)}\\b`),
            label: alias
        }))
    ];
}

function isTraceDefinitionLine(line: string, escapedSymbol: string): boolean {
    const definitionPatterns = [
        new RegExp(`\\b(?:export\\s+)?(?:default\\s+)?(?:abstract\\s+)?(?:class|interface|function|type|enum|const|let|var)\\s+${escapedSymbol}\\b`),
        new RegExp(`^\\s*(?:public\\s+|private\\s+|protected\\s+|static\\s+|readonly\\s+|async\\s+|override\\s+|abstract\\s+)*${escapedSymbol}\\s*\\(`),
        new RegExp(`\\b(?:async\\s+)?def\\s+${escapedSymbol}\\s*\\(`),
        new RegExp(`\\bfunc\\s+(?:\\([^)]+\\)\\s*)?${escapedSymbol}\\s*\\(`),
        new RegExp(`\\b(?:pub(?:\\([^)]*\\))?\\s+)?(?:async\\s+)?fn\\s+${escapedSymbol}\\s*\\(`),
        new RegExp(`\\b(?:pub(?:\\([^)]*\\))?\\s+)?(?:struct|enum|trait|mod)\\s+${escapedSymbol}\\b`)
    ];

    return definitionPatterns.some(pattern => pattern.test(line));
}

function isTraceCommentOnlyLine(preview: string): boolean {
    return preview.startsWith('//')
        || preview.startsWith('*')
        || preview.startsWith('/*')
        || preview.startsWith('#')
        || preview.startsWith('<!--');
}

function pushTraceEvidence(
    evidence: SymbolTraceEvidence[],
    item: SymbolTraceEvidence,
    limit: number
): boolean {
    if (evidence.length >= limit) {
        return false;
    }

    evidence.push(item);
    return true;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
