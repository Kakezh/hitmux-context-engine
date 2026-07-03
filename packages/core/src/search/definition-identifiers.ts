const IDENTIFIER = '[A-Za-z_$][A-Za-z0-9_$]*';
const C_IDENTIFIER = '[A-Za-z_][A-Za-z0-9_]*';
const HWS = '[^\\S\\r\\n]';

export const MAX_DEFINITION_SCAN_LINES = 2000;
export const MAX_DEFINITION_SCAN_CHARS = 256_000;
export const MAX_DEFINITION_IDENTIFIERS = 128;
export const MAX_DEFINITION_SCAN_LINE_LENGTH = 1000;

type DefinitionScanLimitReason = 'maxChars' | 'maxLines' | 'maxIdentifiers';
type DefinitionScanEventKind = 'limit' | 'slow';

export interface DefinitionIdentifierScanEvent {
    kind: DefinitionScanEventKind;
    reason?: DefinitionScanLimitReason;
    relativePath?: string;
    language?: string;
    fileExtension?: string;
    sourceStartLine?: number;
    sourceEndLine?: number;
    elapsedMs: number;
    scannedLines: number;
    scannedChars: number;
    identifierCount: number;
}

export interface ExtractDefinitionIdentifierOptions {
    language?: string;
    fileExtension?: string;
    relativePath?: string;
    maxLines?: number;
    maxChars?: number;
    maxIdentifiers?: number;
    slowScanMs?: number;
    sourceStartLine?: number;
    sourceEndLine?: number;
    onEvent?: (event: DefinitionIdentifierScanEvent) => void;
}

type LanguageFamily =
    | 'all'
    | 'c'
    | 'cmake'
    | 'go'
    | 'javaLike'
    | 'javascript'
    | 'markdown'
    | 'python'
    | 'rust'
    | 'toml'
    | 'none';

const TS_JS_DECLARATION_PATTERN = new RegExp(`^${HWS}*(?:export${HWS}+)?(?:default${HWS}+)?(?:abstract${HWS}+)?(?:async${HWS}+)?(?:class|interface|function|type|enum|const|let|var)${HWS}+(${IDENTIFIER})\\b`);
const PYTHON_DEFINITION_PATTERN = new RegExp(`^${HWS}*(?:(?:async)${HWS}+)?(?:def|class)${HWS}+(${C_IDENTIFIER})\\b`);
const GO_FUNCTION_PATTERN = new RegExp(`^${HWS}*func${HWS}+(?:\\([^\\r\\n)]+\\)${HWS}*)?(${C_IDENTIFIER})${HWS}*\\(`);
const RUST_FUNCTION_PATTERN = new RegExp(`^${HWS}*(?:pub(?:\\([^\\r\\n)]*\\))?${HWS}+)?(?:async${HWS}+)?fn${HWS}+(${C_IDENTIFIER})${HWS}*\\(`);
const RUST_TYPE_PATTERN = new RegExp(`^${HWS}*(?:pub(?:\\([^\\r\\n)]*\\))?${HWS}+)?(?:struct|enum|trait|mod)${HWS}+(${C_IDENTIFIER})\\b`);
const C_MACRO_PATTERN = new RegExp(`^${HWS}*#${HWS}*define${HWS}+(${C_IDENTIFIER})\\b`);
const C_TYPE_PATTERN = new RegExp(`^${HWS}*(?:typedef${HWS}+)?(?:struct|enum|union)${HWS}+(${C_IDENTIFIER})\\b`);
const FUNCTION_MACRO_PATTERN = /^[^\S\r\n]*(?:function|macro)[^\S\r\n]*\([^\S\r\n]*([A-Za-z_][A-Za-z0-9_]*)\b/i;
const SECTION_PATTERN = /^[^\S\r\n]*\[+[^\S\r\n]*([A-Za-z0-9_.-]+)[^\S\r\n]*\]+[^\S\r\n]*$/;
const MARKDOWN_HEADER_PATTERN = /^#{1,6}[^\S\r\n]+(.+?)[^\S\r\n]*#*[^\S\r\n]*$/;
const HANDLER_ASSIGNMENT_PATTERN = /\.(?:handler|callback|command|proc|function|fn)\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\b/gi;
const COMMAND_PATTERN = /^[^\S\r\n]*[A-Z][A-Z0-9_]*CMD[A-Z0-9_]*[^\S\r\n]*\([^)\r\n]*\b([A-Za-z_][A-Za-z0-9_]*(?:Command|Handler|Callback|Proc))\b[^)\r\n]*\)/;
const IDENTIFIER_PATTERN = new RegExp(`^${IDENTIFIER}$`);
const CONTROL_KEYWORDS = new Set([
    'catch',
    'do',
    'else',
    'for',
    'if',
    'new',
    'return',
    'switch',
    'throw',
    'while',
]);

export function extractDefinitionIdentifiers(content: string, options: ExtractDefinitionIdentifierOptions = {}): string[] {
    const startedAt = getMonotonicMs();
    const maxLines = positiveIntegerOrDefault(options.maxLines, MAX_DEFINITION_SCAN_LINES);
    const maxChars = positiveIntegerOrDefault(options.maxChars, MAX_DEFINITION_SCAN_CHARS);
    const maxIdentifiers = positiveIntegerOrDefault(options.maxIdentifiers, MAX_DEFINITION_IDENTIFIERS);
    const family = classifyDefinitionLanguage(options);
    const identifiers = new Set<string>();
    const scannedContent = content.length > maxChars ? content.slice(0, maxChars) : content;
    const lines = scannedContent.split(/\r?\n/);
    let scannedLines = 0;
    let scannedChars = 0;
    let markdownFenceFamily: LanguageFamily | undefined;
    let limitReason: DefinitionScanLimitReason | undefined = content.length > maxChars ? 'maxChars' : undefined;

    const add = (value: string | undefined): boolean => {
        const trimmed = value?.trim();
        if (!trimmed || trimmed.length > 512) {
            return true;
        }

        identifiers.add(trimmed);
        if (identifiers.size >= maxIdentifiers) {
            limitReason = limitReason ?? 'maxIdentifiers';
            return false;
        }
        return true;
    };

    for (const rawLine of lines) {
        if (scannedLines >= maxLines) {
            limitReason = limitReason ?? 'maxLines';
            break;
        }

        scannedLines += 1;
        scannedChars += rawLine.length + 1;
        const isLongLine = rawLine.length > MAX_DEFINITION_SCAN_LINE_LENGTH;
        const line = isLongLine ? rawLine.slice(0, MAX_DEFINITION_SCAN_LINE_LENGTH) : rawLine;
        if (family === 'markdown') {
            const fenceFamily = getMarkdownFenceFamily(line);
            if (fenceFamily) {
                markdownFenceFamily = markdownFenceFamily ? undefined : fenceFamily;
                continue;
            }
        }

        const lineFamily = markdownFenceFamily ?? family;
        if (!extractFromLine(line, lineFamily, isLongLine, add)) {
            break;
        }
    }

    if (!limitReason && lines.length > maxLines) {
        limitReason = 'maxLines';
    }

    const elapsedMs = getMonotonicMs() - startedAt;
    if (limitReason) {
        options.onEvent?.(createScanEvent('limit', options, elapsedMs, scannedLines, scannedChars, identifiers.size, limitReason));
    }
    if (options.slowScanMs !== undefined && elapsedMs >= options.slowScanMs) {
        options.onEvent?.(createScanEvent('slow', options, elapsedMs, scannedLines, scannedChars, identifiers.size));
    }

    return [...identifiers];
}

function extractFromLine(
    line: string,
    family: LanguageFamily,
    isLongLine: boolean,
    add: (value: string | undefined) => boolean
): boolean {
    const trimmed = line.trimStart();
    if (trimmed.length === 0) {
        return true;
    }

    if (shouldRunMarkdownRules(family)) {
        const headerMatch = MARKDOWN_HEADER_PATTERN.exec(line);
        if (headerMatch && !add(headerMatch[1])) {
            return false;
        }
    }

    if (family === 'markdown' && !isExplicitMarkdownCodeLine(trimmed)) {
        return true;
    }

    if (isCommentLine(trimmed) && !trimmed.startsWith('#define')) {
        return true;
    }

    if (shouldRunJavascriptRules(family) && !addFirstMatch(TS_JS_DECLARATION_PATTERN, line, add)) {
        return false;
    }
    if (shouldRunPythonRules(family) && !addFirstMatch(PYTHON_DEFINITION_PATTERN, line, add)) {
        return false;
    }
    if (shouldRunGoRules(family) && line.includes('(') && !addFirstMatch(GO_FUNCTION_PATTERN, line, add)) {
        return false;
    }
    if (shouldRunRustRules(family)) {
        if (line.includes('(') && !addFirstMatch(RUST_FUNCTION_PATTERN, line, add)) {
            return false;
        }
        if (!addFirstMatch(RUST_TYPE_PATTERN, line, add)) {
            return false;
        }
    }
    if (shouldRunCRules(family)) {
        if (!addFirstMatch(C_MACRO_PATTERN, line, add)) {
            return false;
        }
        if (!addFirstMatch(C_TYPE_PATTERN, line, add)) {
            return false;
        }
        if (!isLongLine && !add(extractCFunctionName(line))) {
            return false;
        }
    }
    if (shouldRunJavaLikeRules(family) && !isLongLine && !add(extractJavaLikeMethodName(line, family === 'all'))) {
        return false;
    }
    if (shouldRunCMakeRules(family) && !addFirstMatch(FUNCTION_MACRO_PATTERN, line, add)) {
        return false;
    }
    if (shouldRunTomlRules(family)) {
        const sectionMatch = SECTION_PATTERN.exec(line);
        if (sectionMatch) {
            if (!add(sectionMatch[1])) {
                return false;
            }
            const leaf = sectionMatch[1].split('.').filter(Boolean).at(-1);
            if (!add(leaf)) {
                return false;
            }
        }
    }

    if (!isLongLine && shouldRunHandlerRules(family)) {
        HANDLER_ASSIGNMENT_PATTERN.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = HANDLER_ASSIGNMENT_PATTERN.exec(line)) !== null) {
            if (!isCodeAssignmentMatch(line, match.index)) {
                continue;
            }
            if (!add(match[1])) {
                return false;
            }
        }

        match = COMMAND_PATTERN.exec(line);
        if (match && !add(match[1])) {
            return false;
        }
    }

    return true;
}

function addFirstMatch(pattern: RegExp, line: string, add: (value: string | undefined) => boolean): boolean {
    const match = pattern.exec(line);
    return match ? add(match[1]) : true;
}

function extractCFunctionName(line: string): string | undefined {
    const trimmed = line.trim();
    if (!trimmed.includes('(') || !trimmed.includes('{')) {
        return undefined;
    }

    const openParenIndex = trimmed.indexOf('(');
    const openBraceIndex = trimmed.indexOf('{');
    if (openParenIndex <= 0 || openBraceIndex <= openParenIndex) {
        return undefined;
    }

    const beforeParen = trimmed.slice(0, openParenIndex).trim();
    if (beforeParen.length === 0 || beforeParen.length > 240 || /["'`]/.test(beforeParen)) {
        return undefined;
    }

    const identifiers = beforeParen.match(/[A-Za-z_][A-Za-z0-9_]*/g) || [];
    const functionName = identifiers.at(-1);
    if (!functionName || identifiers.length < 2 || isControlKeyword(functionName)) {
        return undefined;
    }
    return functionName;
}

function extractJavaLikeMethodName(line: string, strict: boolean): string | undefined {
    const trimmed = line.trim();
    if (!trimmed.includes('(')) {
        return undefined;
    }
    if (!trimmed.includes('{') && !trimmed.endsWith(';')) {
        return undefined;
    }

    const openParenIndex = trimmed.indexOf('(');
    if (openParenIndex <= 0) {
        return undefined;
    }

    const beforeParen = trimmed.slice(0, openParenIndex).trim();
    if (beforeParen.length === 0 || beforeParen.length > 240 || /["'`|]/.test(beforeParen)) {
        return undefined;
    }

    const tokens = beforeParen.split(/\s+/).filter(Boolean);
    const methodName = tokens.at(-1);
    if (!methodName || !IDENTIFIER_PATTERN.test(methodName) || isControlKeyword(methodName) || tokens.length < 2) {
        return undefined;
    }

    const hasModifier = /\b(?:public|private|protected|internal|static|final|abstract|override|virtual|async|sealed|synchronized)\b/.test(beforeParen);
    const hasTypeSyntax = /[<>\[\].,?&*]/.test(beforeParen);
    if (strict && !hasModifier && !hasTypeSyntax) {
        return undefined;
    }
    return hasModifier || hasTypeSyntax || tokens.length <= 3 ? methodName : undefined;
}

function isCodeAssignmentMatch(line: string, matchIndex: number): boolean {
    const beforeMatch = line.slice(0, matchIndex);
    if (/["'`]/.test(beforeMatch)) {
        return false;
    }

    const trimmedPrefix = beforeMatch.trim();
    return trimmedPrefix.length === 0
        || trimmedPrefix.endsWith('{')
        || trimmedPrefix.endsWith(',')
        || /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(trimmedPrefix);
}

function classifyDefinitionLanguage(options: ExtractDefinitionIdentifierOptions): LanguageFamily {
    const language = options.language?.trim().toLowerCase();
    const extension = options.fileExtension?.trim().toLowerCase();
    const relativePath = options.relativePath?.trim().toLowerCase();
    const pathExtension = relativePath?.match(/(\.[a-z0-9_+-]+)$/)?.[1];
    const effectiveExtension = extension || pathExtension;
    const fileName = relativePath?.split(/[\\/]/).at(-1);
    const hasHints = Boolean(language || effectiveExtension || fileName);

    if (!hasHints) {
        return 'all';
    }
    if (language === 'markdown' || language === 'md' || effectiveExtension === '.md' || effectiveExtension === '.markdown' || effectiveExtension === '.mdx') {
        return 'markdown';
    }
    if (language === 'toml' || effectiveExtension === '.toml' || fileName === 'pyproject.toml' || fileName === 'cargo.toml') {
        return 'toml';
    }
    if (language === 'cmake' || effectiveExtension === '.cmake' || fileName === 'cmakelists.txt') {
        return 'cmake';
    }
    if (['typescript', 'tsx', 'javascript', 'jsx', 'js'].includes(language || '') || ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(effectiveExtension || '')) {
        return 'javascript';
    }
    if (language === 'python' || effectiveExtension === '.py') {
        return 'python';
    }
    if (language === 'go' || effectiveExtension === '.go') {
        return 'go';
    }
    if (language === 'rust' || effectiveExtension === '.rs') {
        return 'rust';
    }
    if (['c', 'cpp', 'c++', 'objective-c'].includes(language || '') || ['.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh', '.m', '.mm'].includes(effectiveExtension || '')) {
        return 'c';
    }
    if (['java', 'csharp', 'kotlin', 'scala'].includes(language || '') || ['.java', '.cs', '.kt', '.kts', '.scala'].includes(effectiveExtension || '')) {
        return 'javaLike';
    }
    if (['json', 'yaml', 'yml', 'xml', 'plist'].includes(language || '') || ['.json', '.yaml', '.yml', '.xml', '.plist'].includes(effectiveExtension || '')) {
        return 'none';
    }
    return 'all';
}

function shouldRunJavascriptRules(family: LanguageFamily): boolean {
    return family === 'all' || family === 'javascript' || family === 'markdown';
}

function shouldRunPythonRules(family: LanguageFamily): boolean {
    return family === 'all' || family === 'python' || family === 'markdown';
}

function shouldRunGoRules(family: LanguageFamily): boolean {
    return family === 'all' || family === 'go' || family === 'markdown';
}

function shouldRunRustRules(family: LanguageFamily): boolean {
    return family === 'all' || family === 'rust' || family === 'markdown';
}

function shouldRunCRules(family: LanguageFamily): boolean {
    return family === 'all' || family === 'c' || family === 'markdown';
}

function shouldRunJavaLikeRules(family: LanguageFamily): boolean {
    return family === 'all' || family === 'javaLike';
}

function shouldRunCMakeRules(family: LanguageFamily): boolean {
    return family === 'all' || family === 'cmake' || family === 'markdown';
}

function shouldRunTomlRules(family: LanguageFamily): boolean {
    return family === 'all' || family === 'toml';
}

function shouldRunMarkdownRules(family: LanguageFamily): boolean {
    return family === 'markdown';
}

function shouldRunHandlerRules(family: LanguageFamily): boolean {
    return ['all', 'c', 'go', 'javascript', 'rust'].includes(family);
}

function isExplicitMarkdownCodeLine(trimmed: string): boolean {
    return /^(?:export\s+|default\s+|abstract\s+|async\s+|class\s+|interface\s+|function\s+|type\s+|enum\s+|const\s+|let\s+|var\s+|def\s+|func\s+|pub\s+|fn\s+|struct\s+|trait\s+|mod\s+|#\s*define\b|typedef\s+|function\s*\(|macro\s*\()/.test(trimmed);
}

function getMarkdownFenceFamily(line: string): LanguageFamily | undefined {
    const match = /^[^\S\r\n]*(?:```|~~~)[^\S\r\n]*([A-Za-z0-9_+#.-]*)/.exec(line);
    if (!match) {
        return undefined;
    }

    return classifyDefinitionLanguage({
        language: match[1] || undefined,
    });
}

function isCommentLine(trimmed: string): boolean {
    return trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('# ');
}

function isControlKeyword(value: string): boolean {
    return CONTROL_KEYWORDS.has(value.toLowerCase());
}

function positiveIntegerOrDefault(value: number | undefined, fallback: number): number {
    return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function createScanEvent(
    kind: DefinitionScanEventKind,
    options: ExtractDefinitionIdentifierOptions,
    elapsedMs: number,
    scannedLines: number,
    scannedChars: number,
    identifierCount: number,
    reason?: DefinitionScanLimitReason
): DefinitionIdentifierScanEvent {
    return {
        kind,
        reason,
        relativePath: options.relativePath,
        language: options.language,
        fileExtension: options.fileExtension,
        sourceStartLine: options.sourceStartLine,
        sourceEndLine: options.sourceEndLine,
        elapsedMs,
        scannedLines,
        scannedChars,
        identifierCount,
    };
}

function getMonotonicMs(): number {
    return Number(process.hrtime.bigint()) / 1_000_000;
}
