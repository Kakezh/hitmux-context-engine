import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export type EmbeddingProviderName = 'OpenAI' | 'VoyageAI' | 'Gemini' | 'Ollama' | 'OpenRouter';

export interface HitmuxConfig {
    mcpServerName?: string;
    mcpServerVersion?: string;
    embeddingProvider?: EmbeddingProviderName;
    embeddingModel?: string;
    embeddingBatchSize?: number;
    embeddingConcurrency?: number;
    openaiApiKey?: string;
    openaiBaseUrl?: string;
    voyageaiApiKey?: string;
    geminiApiKey?: string;
    geminiBaseUrl?: string;
    openrouterApiKey?: string;
    ollamaModel?: string;
    ollamaHost?: string;
    milvusAddress?: string;
    milvusToken?: string;
    milvusUseRestful?: boolean;
    milvusCollectionLimitCheckTimeoutMs?: number;
    zillizBaseUrl?: string;
    collectionNameOverride?: string;
    codebaseIdentityMode?: 'path' | 'gitRemote' | 'global' | 'custom';
    codebaseIdentity?: string;
    globalCollectionName?: string;
    gitRemoteName?: string;
    hybridMode?: boolean;
    searchTimeoutMs?: number;
    customExtensions?: string[];
    customIgnorePatterns?: string[];
    merkleSnapshotMaxBytes?: number;
    autoIndexing?: boolean;
    interactiveIndexing?: boolean;
    backgroundSync?: boolean;
    syncIntervalMs?: number;
    syncLockStaleMs?: number;
    triggerWatcher?: boolean;
    splitterType?: string;
    searchTopK?: number;
    searchThreshold?: number;
}

export type HitmuxConfigKey = keyof HitmuxConfig;

export interface ConfigReadError {
    path: string;
    message: string;
}

export class ConfigManager {
    getConfigFilePath(): string {
        return this.getGlobalConfigFilePath();
    }

    getGlobalConfigFilePath(): string {
        return path.join(os.homedir(), '.hitmux-context-engine', 'config.conf');
    }

    getProjectConfigFilePath(projectRoot: string = process.cwd()): string {
        return path.join(projectRoot, '.hitmux-context-engine', 'config.conf');
    }

    getAll(): HitmuxConfig {
        return {
            ...this.readConfigFile(this.getGlobalConfigFilePath()),
            ...this.readConfigFile(this.getProjectConfigFilePath())
        };
    }

    getReadErrors(projectRoot: string = process.cwd()): ConfigReadError[] {
        return [
            this.validateConfigFile(this.getGlobalConfigFilePath()),
            this.validateConfigFile(this.getProjectConfigFilePath(projectRoot))
        ].filter((error): error is ConfigReadError => error !== null);
    }

    private validateConfigFile(configPath: string): ConfigReadError | null {
        try {
            if (!fs.existsSync(configPath)) {
                return null;
            }

            const content = fs.readFileSync(configPath, 'utf-8').trim();
            if (!content) {
                return null;
            }

            const parsed = parseConfConfig(content);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                return {
                    path: configPath,
                    message: 'expected conf key-value fields'
                };
            }

            return null;
        } catch (error) {
            return {
                path: configPath,
                message: error instanceof Error ? error.message : String(error)
            };
        }
    }

    private readConfigFile(configPath: string): HitmuxConfig {
        try {
            if (!fs.existsSync(configPath)) {
                return {};
            }

            const content = fs.readFileSync(configPath, 'utf-8').trim();
            if (!content) {
                return {};
            }

            const parsed = parseConfConfig(content);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                console.warn(`[ConfigManager] Ignoring ${configPath}: expected conf key-value fields.`);
                return {};
            }

            return parsed as HitmuxConfig;
        } catch (error) {
            console.warn(`[ConfigManager] Failed to read ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
            return {};
        }
    }

    get<T extends HitmuxConfigKey>(key: T): HitmuxConfig[T] | undefined {
        const value = this.getAll()[key];
        return value === null ? undefined : value;
    }

    getString(key: HitmuxConfigKey): string | undefined {
        const value = this.get(key);
        if (typeof value === 'string') {
            const trimmed = value.trim();
            return trimmed.length > 0 ? trimmed : undefined;
        }
        return undefined;
    }

    getNumber(key: HitmuxConfigKey): number | undefined {
        const value = this.get(key);
        if (typeof value === 'number' && Number.isFinite(value)) {
            return value;
        }
        if (typeof value === 'string' && value.trim().length > 0) {
            const parsed = Number(value);
            return Number.isFinite(parsed) ? parsed : undefined;
        }
        return undefined;
    }

    getBoolean(key: HitmuxConfigKey): boolean | undefined {
        const value = this.get(key);
        if (typeof value === 'boolean') {
            return value;
        }
        if (typeof value === 'string') {
            switch (value.trim().toLowerCase()) {
                case '1':
                case 'true':
                case 'yes':
                case 'on':
                    return true;
                case '0':
                case 'false':
                case 'no':
                case 'off':
                    return false;
            }
        }
        return undefined;
    }

    getStringArray(key: HitmuxConfigKey): string[] {
        const value = this.get(key);
        if (Array.isArray(value)) {
            return value
                .map(item => typeof item === 'string' ? item.trim() : '')
                .filter(item => item.length > 0);
        }
        if (typeof value === 'string') {
            return value
                .split(',')
                .map(item => item.trim())
                .filter(item => item.length > 0);
        }
        return [];
    }

    set<T extends HitmuxConfigKey>(key: T, value: HitmuxConfig[T]): void {
        const configPath = this.getGlobalConfigFilePath();
        const configDir = path.dirname(configPath);
        fs.mkdirSync(configDir, { recursive: true });

        const config = this.getAll();
        config[key] = value;
        fs.writeFileSync(configPath, formatConfConfig(config), 'utf-8');
    }
}

export const configManager = new ConfigManager();

const ARRAY_CONFIG_KEYS = new Set<HitmuxConfigKey>([
    'customExtensions',
    'customIgnorePatterns'
]);

function parseConfConfig(input: string): HitmuxConfig {
    const config: Record<string, unknown> = {};
    const lines = input.split(/\r?\n/);

    for (const [index, rawLine] of lines.entries()) {
        const line = stripConfComment(rawLine).trim();
        if (!line) {
            continue;
        }

        const separatorIndex = line.indexOf('=');
        if (separatorIndex < 1) {
            throw new Error(`Invalid config line ${index + 1}: expected "field = value"`);
        }

        const key = line.slice(0, separatorIndex).trim() as HitmuxConfigKey;
        const rawValue = line.slice(separatorIndex + 1).trim();
        if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key)) {
            throw new Error(`Invalid config line ${index + 1}: invalid field name "${key}"`);
        }

        if (ARRAY_CONFIG_KEYS.has(key)) {
            const values = parseConfArrayValue(rawValue);
            const previous = config[key];
            config[key] = Array.isArray(previous) ? [...previous, ...values] : values;
            continue;
        }

        config[key] = parseConfScalarValue(rawValue);
    }

    return config as HitmuxConfig;
}

function stripConfComment(input: string): string {
    let output = '';
    let inString = false;
    let quote: '"' | "'" | null = null;
    let escaped = false;

    for (let i = 0; i < input.length; i++) {
        const current = input[i];

        if (inString) {
            output += current;
            if (escaped) {
                escaped = false;
            } else if (current === '\\') {
                escaped = true;
            } else if (current === quote) {
                inString = false;
                quote = null;
            }
            continue;
        }

        if (current === '"' || current === "'") {
            inString = true;
            quote = current;
            output += current;
            continue;
        }

        if (current === '#') {
            break;
        }

        output += current;
    }

    return output;
}

function parseConfArrayValue(rawValue: string): string[] {
    const value = unquoteConfValue(rawValue).trim();
    if (!value) {
        return [];
    }

    return value
        .split(/\s+/)
        .map(item => item.trim())
        .filter(item => item.length > 0);
}

function parseConfScalarValue(rawValue: string): string | number | boolean | undefined {
    const value = unquoteConfValue(rawValue).trim();
    if (!value) {
        return undefined;
    }

    const lowerValue = value.toLowerCase();
    if (lowerValue === 'true') {
        return true;
    }
    if (lowerValue === 'false') {
        return false;
    }

    const numberValue = Number(value);
    if (Number.isFinite(numberValue) && value === String(numberValue)) {
        return numberValue;
    }

    return value;
}

function unquoteConfValue(rawValue: string): string {
    if (rawValue.length < 2) {
        return rawValue;
    }

    const quote = rawValue[0];
    if ((quote !== '"' && quote !== "'") || rawValue[rawValue.length - 1] !== quote) {
        return rawValue;
    }

    return rawValue
        .slice(1, -1)
        .replace(/\\(["'\\#])/g, '$1');
}

function formatConfConfig(config: HitmuxConfig): string {
    const lines: string[] = [];
    for (const [key, value] of Object.entries(config)) {
        if (value === undefined || value === null) {
            continue;
        }

        if (Array.isArray(value)) {
            for (const item of value) {
                lines.push(`${key} = ${formatConfValue(item)}`);
            }
            continue;
        }

        lines.push(`${key} = ${formatConfValue(value)}`);
    }

    return `${lines.join('\n')}\n`;
}

function formatConfValue(value: string | number | boolean): string {
    if (typeof value !== 'string') {
        return String(value);
    }

    if (!value || /(^\s|\s$|#)/.test(value)) {
        return `"${value.replace(/(["\\#])/g, '\\$1')}"`;
    }

    return value;
}
