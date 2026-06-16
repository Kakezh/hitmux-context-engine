import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    Context,
    MilvusVectorDatabase,
    type SemanticSearchResult,
} from "@hitmux/hitmux-context-engine-core";
import { createMcpConfig } from "../packages/mcp/src/config.js";
import { createEmbeddingInstance } from "../packages/mcp/src/embedding.js";

type CaseStatus = "completed" | "error" | "skipped";

interface ExpectedAnswer {
    primaryPaths: string[];
    acceptablePaths?: string[];
    primarySymbols?: string[];
    evidence?: string;
}

interface BenchmarkCase {
    id: string;
    question: string;
    expected: ExpectedAnswer;
}

interface BenchmarkProject {
    name: string;
    root: string;
    cases: BenchmarkCase[];
}

interface ResolvedBenchmarkProject extends BenchmarkProject {
    projectRoot: string;
}

interface BenchmarkFixture {
    name: string;
    workspaceRoot: string;
    projects: BenchmarkProject[];
}

interface CaseResult {
    runId: string;
    fixture: string;
    project: string;
    projectRoot: string;
    caseId: string;
    question: string;
    status: CaseStatus;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    suggestedScore: number;
    scoringReason: string;
    firstPrimaryRank: number | null;
    firstAcceptableRank: number | null;
    firstPrimarySymbolRank: number | null;
    firstAcceptableSymbolRank: number | null;
    symbolHitCount: number;
    needsManualReview: boolean;
    topResults: Array<{
        rank: number;
        path: string;
        score: number;
        lineRange: string;
        matched: "primary" | "acceptable" | "none";
        symbolHits: string[];
        hasSymbolHit: boolean;
    }>;
    error?: string;
}

interface RunnerOptions {
    casesPath: string;
    outDir: string;
    workspaceRoot?: string;
    run: boolean;
    limit: number;
    threshold: number;
    projects: Set<string>;
    retryErrors: boolean;
}

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CASES_PATH = path.join(SCRIPT_DIR, "test-hce-cases.json");
const DEFAULT_OUT_DIR = path.join(SCRIPT_DIR, "results", "test-hce");

function parseArgs(argv: string[]): RunnerOptions {
    const options: RunnerOptions = {
        casesPath: DEFAULT_CASES_PATH,
        outDir: DEFAULT_OUT_DIR,
        run: false,
        limit: 20,
        threshold: 0.3,
        projects: new Set(),
        retryErrors: false,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = argv[index + 1];

        if (arg === "--run") {
            options.run = true;
        } else if (arg === "--plan") {
            options.run = false;
        } else if (arg === "--cases" && next) {
            options.casesPath = path.resolve(next);
            index += 1;
        } else if (arg === "--out-dir" && next) {
            options.outDir = path.resolve(next);
            index += 1;
        } else if (arg === "--workspace-root" && next) {
            options.workspaceRoot = path.resolve(next);
            index += 1;
        } else if (arg === "--project" && next) {
            options.projects.add(next);
            index += 1;
        } else if (arg === "--limit" && next) {
            options.limit = parsePositiveInteger(next, "--limit");
            index += 1;
        } else if (arg === "--threshold" && next) {
            options.threshold = parseFiniteNumber(next, "--threshold");
            index += 1;
        } else if (arg === "--retry-errors") {
            options.retryErrors = true;
        } else if (arg === "--help" || arg === "-h") {
            printHelp();
            process.exit(0);
        } else {
            throw new Error(`Unknown or incomplete argument: ${arg}`);
        }
    }

    return options;
}

function printHelp(): void {
    console.log(`Usage:
  pnpm --dir packages/mcp exec tsx ../../benchmark/run-test-hce-search-quality.ts --plan
  pnpm --dir packages/mcp exec tsx ../../benchmark/run-test-hce-search-quality.ts --run

Options:
  --cases <path>           Case fixture path. Default: benchmark/test-hce-cases.json
  --out-dir <path>         Output directory. Default: benchmark/results/test-hce
  --workspace-root <path>  Override fixture workspaceRoot.
  --project <name>         Run one project. Repeatable.
  --limit <n>              Search result limit. Default: 20
  --threshold <n>          Search threshold. Default: 0.3
  --retry-errors           Re-run cases that have previous error records.
  --plan                   Validate and print serial execution plan. Default.
  --run                    Execute serial benchmark with resume.
`);
}

function parsePositiveInteger(value: string, name: string): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`${name} must be a positive integer`);
    }
    return parsed;
}

function parseFiniteNumber(value: string, name: string): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        throw new Error(`${name} must be a finite number`);
    }
    if (name === "--threshold" && (parsed < 0 || parsed > 1)) {
        throw new Error(`${name} must be between 0 and 1`);
    }
    return parsed;
}

function readFixture(casesPath: string): BenchmarkFixture {
    const parsed = JSON.parse(fs.readFileSync(casesPath, "utf8")) as BenchmarkFixture;
    if (!parsed.name || !parsed.workspaceRoot || !Array.isArray(parsed.projects)) {
        throw new Error(`Invalid benchmark fixture: ${casesPath}`);
    }
    return parsed;
}

function resolveWorkspaceRoot(fixture: BenchmarkFixture, options: RunnerOptions): string {
    return path.resolve(options.workspaceRoot ?? fixture.workspaceRoot);
}

function resolveProjectRoot(project: BenchmarkProject, fixture: BenchmarkFixture, workspaceRoot: string): string {
    if (!path.isAbsolute(project.root)) {
        return path.resolve(workspaceRoot, project.root);
    }

    const fixtureWorkspaceRoot = path.resolve(fixture.workspaceRoot);
    const absoluteProjectRoot = path.resolve(project.root);
    if (workspaceRoot !== fixtureWorkspaceRoot && isPathInside(absoluteProjectRoot, fixtureWorkspaceRoot)) {
        return path.resolve(workspaceRoot, path.relative(fixtureWorkspaceRoot, absoluteProjectRoot));
    }

    return absoluteProjectRoot;
}

function validateFixture(fixture: BenchmarkFixture, options: RunnerOptions): ResolvedBenchmarkProject[] {
    const workspaceRoot = resolveWorkspaceRoot(fixture, options);
    const selectedProjects = fixture.projects.filter((project) =>
        options.projects.size === 0 || options.projects.has(project.name)
    );

    if (selectedProjects.length === 0) {
        throw new Error("No projects selected.");
    }

    const seenCaseKeys = new Set<string>();
    const resolvedProjects: ResolvedBenchmarkProject[] = [];
    for (const project of selectedProjects) {
        const projectRoot = resolveProjectRoot(project, fixture, workspaceRoot);
        if (projectRoot === workspaceRoot) {
            throw new Error(`Project root must be a concrete project, not workspaceRoot: ${project.name} -> ${projectRoot}`);
        }
        if (!isPathInside(projectRoot, workspaceRoot)) {
            throw new Error(`Project root is outside workspaceRoot: ${project.name} -> ${projectRoot}`);
        }
        if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
            throw new Error(`Project root does not exist: ${project.name} -> ${projectRoot}`);
        }
        if (!Array.isArray(project.cases)) {
            throw new Error(`Project cases must be an array: ${project.name}`);
        }

        for (const benchmarkCase of project.cases) {
            if (!benchmarkCase.id || !benchmarkCase.question) {
                throw new Error(`Invalid case in ${project.name}: ${JSON.stringify(benchmarkCase)}`);
            }
            if (!Array.isArray(benchmarkCase.expected?.primaryPaths) || benchmarkCase.expected.primaryPaths.length === 0) {
                throw new Error(`Case ${project.name}/${benchmarkCase.id} must define at least one expected.primaryPaths entry`);
            }
            const caseKey = `${project.name}/${benchmarkCase.id}`;
            if (seenCaseKeys.has(caseKey)) {
                throw new Error(`Duplicate case id: ${caseKey}`);
            }
            seenCaseKeys.add(caseKey);
        }

        resolvedProjects.push({ ...project, projectRoot });
    }

    return resolvedProjects;
}

function isPathInside(childPath: string, parentPath: string): boolean {
    const relative = path.relative(parentPath, childPath);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function readResultRecords(resultsPath: string): CaseResult[] {
    if (!fs.existsSync(resultsPath)) {
        return [];
    }

    const records: CaseResult[] = [];
    const lines = fs.readFileSync(resultsPath, "utf8").split(/\r?\n/).filter(Boolean);
    for (const [index, line] of lines.entries()) {
        try {
            records.push(JSON.parse(line) as CaseResult);
        } catch (error) {
            throw new Error(
                `Invalid JSONL record in ${resultsPath}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }
    return records;
}

function getLatestResults(resultsPath: string): Map<string, CaseResult> {
    const latest = new Map<string, CaseResult>();
    for (const result of readResultRecords(resultsPath)) {
        latest.set(resultKey(result.project, result.caseId), result);
    }
    return latest;
}

function readCompletedKeys(resultsPath: string, retryErrors: boolean): Set<string> {
    const completed = new Set<string>();
    for (const result of getLatestResults(resultsPath).values()) {
        if (result.status === "completed" || (!retryErrors && result.status === "error")) {
            completed.add(resultKey(result.project, result.caseId));
        }
    }
    return completed;
}

function resultKey(projectName: string, caseId: string): string {
    return `${projectName}/${caseId}`;
}

function appendJsonl(filePath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

function writeJson(filePath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function normalizeRelativePath(projectRoot: string, resultPath: string): string {
    const absolute = path.isAbsolute(resultPath) ? resultPath : path.join(projectRoot, resultPath);
    return path.relative(projectRoot, absolute).split(path.sep).join("/");
}

function normalizeExpectedPath(value: string): string {
    return value.replaceAll("\\", "/").replace(/^\.?\//, "");
}

function formatLineRange(result: SemanticSearchResult): string {
    if (
        Number.isInteger(result.startLine) &&
        Number.isInteger(result.endLine) &&
        result.startLine > 0 &&
        result.endLine >= result.startLine
    ) {
        return `${result.startLine}-${result.endLine}`;
    }

    return "unknown";
}

function getSymbolAliases(symbol: string): string[] {
    const trimmed = symbol.trim();
    if (!trimmed) {
        return [];
    }

    const aliases = new Set<string>([trimmed]);
    const symbolParts = trimmed.split(/::|\./);
    const unqualified = symbolParts[symbolParts.length - 1];
    if (unqualified && unqualified.length >= 4) {
        aliases.add(unqualified);
    }

    return [...aliases];
}

function contentContainsSymbol(content: string, symbol: string): boolean {
    for (const alias of getSymbolAliases(symbol)) {
        if (alias.includes(".") || alias.includes(":")) {
            if (content.includes(alias)) {
                return true;
            }
            continue;
        }

        const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (new RegExp(`\\b${escaped}\\b`).test(content)) {
            return true;
        }
    }

    return false;
}

function getSymbolHits(result: SemanticSearchResult, benchmarkCase: BenchmarkCase): string[] {
    const symbols = benchmarkCase.expected.primarySymbols ?? [];
    if (symbols.length === 0) {
        return [];
    }

    return symbols.filter((symbol) => contentContainsSymbol(result.content, symbol));
}

function hasRequiredSymbolHit(result: SemanticSearchResult, benchmarkCase: BenchmarkCase): boolean {
    const symbols = benchmarkCase.expected.primarySymbols ?? [];
    return symbols.length === 0 || getSymbolHits(result, benchmarkCase).length > 0;
}

function scoreResult(
    projectRoot: string,
    benchmarkCase: BenchmarkCase,
    results: SemanticSearchResult[]
): Pick<CaseResult, "suggestedScore" | "scoringReason" | "firstPrimaryRank" | "firstAcceptableRank" | "firstPrimarySymbolRank" | "firstAcceptableSymbolRank" | "symbolHitCount" | "needsManualReview" | "topResults"> {
    const primaryPaths = new Set(benchmarkCase.expected.primaryPaths.map(normalizeExpectedPath));
    const acceptablePaths = new Set((benchmarkCase.expected.acceptablePaths ?? []).map(normalizeExpectedPath));
    let firstPrimaryRank: number | null = null;
    let firstAcceptableRank: number | null = null;
    let firstPrimarySymbolRank: number | null = null;
    let firstAcceptableSymbolRank: number | null = null;
    let symbolHitCount = 0;

    const topResults = results.map((result, index) => {
        const relativePath = normalizeRelativePath(projectRoot, result.relativePath);
        const rank = index + 1;
        const symbolHits = getSymbolHits(result, benchmarkCase);
        const hasSymbolHit = hasRequiredSymbolHit(result, benchmarkCase);
        if (symbolHits.length > 0) {
            symbolHitCount += 1;
        }
        let matched: "primary" | "acceptable" | "none" = "none";
        if (primaryPaths.has(relativePath)) {
            matched = "primary";
            firstPrimaryRank ??= rank;
            if (hasSymbolHit) {
                firstPrimarySymbolRank ??= rank;
            }
        } else if (acceptablePaths.has(relativePath)) {
            matched = "acceptable";
            firstAcceptableRank ??= rank;
            if (hasSymbolHit) {
                firstAcceptableSymbolRank ??= rank;
            }
        }

        return {
            rank,
            path: relativePath,
            score: result.score,
            lineRange: formatLineRange(result),
            matched,
            symbolHits,
            hasSymbolHit,
        };
    });

    const reviewFields = {
        firstPrimaryRank,
        firstAcceptableRank,
        firstPrimarySymbolRank,
        firstAcceptableSymbolRank,
        symbolHitCount,
        needsManualReview: false,
        topResults,
    };

    if (firstPrimarySymbolRank !== null && firstPrimarySymbolRank <= 3) {
        return {
            suggestedScore: 5,
            scoringReason: "primary path ranked in top 3 with expected symbol in snippet",
            ...reviewFields,
        };
    }
    if (
        (firstPrimarySymbolRank !== null && firstPrimarySymbolRank <= 5) ||
        (firstPrimaryRank !== null && firstPrimaryRank <= 3) ||
        (firstAcceptableSymbolRank !== null && firstAcceptableSymbolRank <= 3)
    ) {
        return {
            suggestedScore: 4,
            scoringReason: "strong expected hit: primary path top 5 with symbol, primary path top 3 without symbol, or acceptable path top 3 with symbol",
            ...reviewFields,
            needsManualReview: firstPrimarySymbolRank === null,
        };
    }
    if (
        (firstPrimarySymbolRank !== null && firstPrimarySymbolRank <= 10) ||
        (firstAcceptableSymbolRank !== null && firstAcceptableSymbolRank <= 5) ||
        (firstPrimaryRank !== null && firstPrimaryRank <= 5)
    ) {
        return {
            suggestedScore: 3,
            scoringReason: "partial expected hit: primary symbol top 10, acceptable symbol top 5, or primary path top 5 without symbol",
            ...reviewFields,
            needsManualReview: firstPrimarySymbolRank === null,
        };
    }
    if (
        (firstAcceptableSymbolRank !== null && firstAcceptableSymbolRank <= 10) ||
        (firstAcceptableRank !== null && firstAcceptableRank <= 5) ||
        (firstPrimaryRank !== null && firstPrimaryRank <= 10)
    ) {
        return {
            suggestedScore: 2,
            scoringReason: "weak expected hit: acceptable symbol top 10, acceptable path top 5, or primary path top 10 without symbol",
            ...reviewFields,
            needsManualReview: true,
        };
    }
    if (results.length > 0) {
        return {
            suggestedScore: 1,
            scoringReason: "non-empty result without expected path hit",
            ...reviewFields,
            needsManualReview: true,
        };
    }

    return {
        suggestedScore: 0,
        scoringReason: "empty result",
        ...reviewFields,
    };
}

async function runCase(
    context: Context,
    fixture: BenchmarkFixture,
    runId: string,
    project: ResolvedBenchmarkProject,
    benchmarkCase: BenchmarkCase,
    options: RunnerOptions
): Promise<CaseResult> {
    const projectRoot = project.projectRoot;
    const startedAtDate = new Date();
    const startedAt = startedAtDate.toISOString();

    try {
        const results = await context.semanticSearch(
            projectRoot,
            benchmarkCase.question,
            options.limit,
            options.threshold
        );
        const finishedAtDate = new Date();
        const scoring = scoreResult(projectRoot, benchmarkCase, results);

        return {
            runId,
            fixture: fixture.name,
            project: project.name,
            projectRoot,
            caseId: benchmarkCase.id,
            question: benchmarkCase.question,
            status: "completed",
            startedAt,
            finishedAt: finishedAtDate.toISOString(),
            durationMs: finishedAtDate.getTime() - startedAtDate.getTime(),
            ...scoring,
        };
    } catch (error) {
        const finishedAtDate = new Date();
        return {
            runId,
            fixture: fixture.name,
            project: project.name,
            projectRoot,
            caseId: benchmarkCase.id,
            question: benchmarkCase.question,
            status: "error",
            startedAt,
            finishedAt: finishedAtDate.toISOString(),
            durationMs: finishedAtDate.getTime() - startedAtDate.getTime(),
            suggestedScore: 0,
            scoringReason: "search failed",
            firstPrimaryRank: null,
            firstAcceptableRank: null,
            firstPrimarySymbolRank: null,
            firstAcceptableSymbolRank: null,
            symbolHitCount: 0,
            needsManualReview: true,
            topResults: [],
            error: error instanceof Error ? error.stack || error.message : String(error),
        };
    }
}

function writeReport(resultsPath: string, reportPath: string): void {
    const results = Array.from(getLatestResults(resultsPath).values());
    const byProject = new Map<string, {
        total: number;
        completed: number;
        errors: number;
        suggestedScore: number;
        primaryTop3: number;
        primaryTop5: number;
        primarySymbolTop3: number;
        primarySymbolTop5: number;
        expectedTop10: number;
        manualReview: number;
    }>();

    for (const result of results) {
        const summary = byProject.get(result.project) ?? {
            total: 0,
            completed: 0,
            errors: 0,
            suggestedScore: 0,
            primaryTop3: 0,
            primaryTop5: 0,
            primarySymbolTop3: 0,
            primarySymbolTop5: 0,
            expectedTop10: 0,
            manualReview: 0,
        };
        summary.total += 1;
        if (result.status === "completed") {
            summary.completed += 1;
            summary.suggestedScore += result.suggestedScore;
            if (result.firstPrimaryRank !== null && result.firstPrimaryRank <= 3) {
                summary.primaryTop3 += 1;
            }
            if (result.firstPrimaryRank !== null && result.firstPrimaryRank <= 5) {
                summary.primaryTop5 += 1;
            }
            if (result.firstPrimarySymbolRank !== null && result.firstPrimarySymbolRank <= 3) {
                summary.primarySymbolTop3 += 1;
            }
            if (result.firstPrimarySymbolRank !== null && result.firstPrimarySymbolRank <= 5) {
                summary.primarySymbolTop5 += 1;
            }
            if (
                (result.firstPrimaryRank !== null && result.firstPrimaryRank <= 10) ||
                (result.firstAcceptableRank !== null && result.firstAcceptableRank <= 10)
            ) {
                summary.expectedTop10 += 1;
            }
            if (result.needsManualReview) {
                summary.manualReview += 1;
            }
        } else if (result.status === "error") {
            summary.errors += 1;
        }
        byProject.set(result.project, summary);
    }

    writeJson(reportPath, {
        generatedAt: new Date().toISOString(),
        resultsPath,
        projects: Array.from(byProject.entries()).map(([project, summary]) => ({
            project,
            ...summary,
            maxScore: summary.total * 5,
        })),
    });
}

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2));
    const fixture = readFixture(options.casesPath);
    const projects = validateFixture(fixture, options);
    const totalCases = projects.reduce((total, project) => total + project.cases.length, 0);
    const resultsPath = path.join(options.outDir, "results.jsonl");
    const statePath = path.join(options.outDir, "state.json");
    const reportPath = path.join(options.outDir, "report.json");
    const completedKeys = readCompletedKeys(resultsPath, options.retryErrors);
    const selectedCaseKeys = new Set(
        projects.flatMap((project) => project.cases.map((benchmarkCase) => resultKey(project.name, benchmarkCase.id)))
    );
    const recordedSelectedCases = [...completedKeys].filter((key) => selectedCaseKeys.has(key)).length;
    const pendingCases = projects.reduce(
        (total, project) => total + project.cases.filter((benchmarkCase) => !completedKeys.has(resultKey(project.name, benchmarkCase.id))).length,
        0
    );

    console.log(`Fixture: ${fixture.name}`);
    console.log(`Projects: ${projects.length}`);
    console.log(`Cases: ${totalCases}`);
    console.log(`Already recorded: ${recordedSelectedCases}`);
    console.log(`Pending: ${pendingCases}`);
    console.log(`Mode: ${options.run ? "run" : "plan"}`);

    for (const project of projects) {
        const pendingInProject = project.cases.filter((benchmarkCase) => !completedKeys.has(resultKey(project.name, benchmarkCase.id))).length;
        console.log(`- ${project.name}: ${project.projectRoot} (${project.cases.length} cases, ${pendingInProject} pending)`);
    }

    if (!options.run) {
        return;
    }
    if (totalCases === 0) {
        throw new Error("No benchmark cases defined. Refusing to run an empty benchmark.");
    }
    const runId = new Date().toISOString().replaceAll(":", "-");
    if (pendingCases === 0) {
        writeJson(statePath, {
            runId,
            status: "completed",
            updatedAt: new Date().toISOString(),
            note: "No pending cases.",
        });
        writeReport(resultsPath, reportPath);
        console.log("No pending cases.");
        console.log(`Wrote report to ${reportPath}`);
        return;
    }

    const config = createMcpConfig();
    const embedding = createEmbeddingInstance(config);
    const vectorDatabase = new MilvusVectorDatabase({
        address: config.milvusAddress,
        ...(config.milvusToken && { token: config.milvusToken }),
        useSystemProxy: config.databaseUseSystemProxy,
    });
    const context = new Context({
        embedding,
        vectorDatabase,
        collectionNameOverride: config.collectionNameOverride,
        collectionIdentity: {
            mode: config.codebaseIdentityMode,
            customIdentity: config.codebaseIdentity,
            globalName: config.globalCollectionName,
            gitRemoteName: config.gitRemoteName,
        },
    });

    for (const project of projects) {
        for (const benchmarkCase of project.cases) {
            const key = resultKey(project.name, benchmarkCase.id);
            if (completedKeys.has(key)) {
                continue;
            }

            writeJson(statePath, {
                runId,
                status: "running",
                project: project.name,
                caseId: benchmarkCase.id,
                updatedAt: new Date().toISOString(),
            });
            console.log(`Running ${key}`);
            const result = await runCase(context, fixture, runId, project, benchmarkCase, options);
            appendJsonl(resultsPath, result);
            completedKeys.add(key);
        }
    }

    writeJson(statePath, {
        runId,
        status: "completed",
        updatedAt: new Date().toISOString(),
    });
    writeReport(resultsPath, reportPath);
    console.log(`Wrote results to ${resultsPath}`);
    console.log(`Wrote report to ${reportPath}`);
}

main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
});
