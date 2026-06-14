const PROXY_ENV_KEYS = [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'GRPC_PROXY',
    'NO_GRPC_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'no_proxy',
    'grpc_proxy',
    'no_grpc_proxy',
] as const;

type ProxyEnvKey = typeof PROXY_ENV_KEYS[number];
export type ProxyEnvSnapshot = Partial<Record<ProxyEnvKey, string>>;

const originalProxyEnv = captureProxyEnvironment();

function captureProxyEnvironment(): ProxyEnvSnapshot {
    const snapshot: ProxyEnvSnapshot = {};
    for (const key of PROXY_ENV_KEYS) {
        const value = process.env[key];
        if (value !== undefined) {
            snapshot[key] = value;
        }
    }
    return snapshot;
}

function applyProxyEnvironment(snapshot: ProxyEnvSnapshot): void {
    for (const key of PROXY_ENV_KEYS) {
        const value = snapshot[key];
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
}

export function applySystemProxyPolicy(useSystemProxy: boolean): ProxyEnvSnapshot {
    const previous = captureProxyEnvironment();
    applyProxyEnvironment(useSystemProxy ? originalProxyEnv : {});
    return previous;
}

export function restoreProxyEnvironment(snapshot: ProxyEnvSnapshot): void {
    applyProxyEnvironment(snapshot);
}

export async function withSystemProxyPolicy<T>(useSystemProxy: boolean, operation: () => Promise<T>): Promise<T> {
    const previous = applySystemProxyPolicy(useSystemProxy);
    try {
        return await operation();
    } finally {
        restoreProxyEnvironment(previous);
    }
}
