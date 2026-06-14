import assert from 'node:assert/strict';
import test from 'node:test';

import { applySystemProxyPolicy, restoreProxyEnvironment, withSystemProxyPolicy } from './proxy-env';

const TEST_PROXY_KEYS = ['http_proxy', 'https_proxy', 'grpc_proxy', 'no_proxy'] as const;

function captureTestProxyEnv(): Partial<Record<typeof TEST_PROXY_KEYS[number], string>> {
    const snapshot: Partial<Record<typeof TEST_PROXY_KEYS[number], string>> = {};
    for (const key of TEST_PROXY_KEYS) {
        const value = process.env[key];
        if (value !== undefined) {
            snapshot[key] = value;
        }
    }
    return snapshot;
}

function restoreTestProxyEnv(snapshot: Partial<Record<typeof TEST_PROXY_KEYS[number], string>>): void {
    for (const key of TEST_PROXY_KEYS) {
        const value = snapshot[key];
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
}

function setProxyEnv(): void {
    process.env.http_proxy = 'http://127.0.0.1:7890';
    process.env.https_proxy = 'http://127.0.0.1:7890';
    process.env.grpc_proxy = 'http://127.0.0.1:7890';
    process.env.no_proxy = 'localhost,127.0.0.1';
}

test('applySystemProxyPolicy clears proxy environment when disabled', () => {
    const original = captureTestProxyEnv();
    setProxyEnv();
    const previous = applySystemProxyPolicy(false);

    try {
        assert.equal(process.env.http_proxy, undefined);
        assert.equal(process.env.https_proxy, undefined);
        assert.equal(process.env.grpc_proxy, undefined);
        assert.equal(process.env.no_proxy, undefined);
    } finally {
        restoreProxyEnvironment(previous);
        restoreTestProxyEnv(original);
    }
});

test('withSystemProxyPolicy restores the previous proxy environment', async () => {
    const original = captureTestProxyEnv();
    setProxyEnv();
    const before = {
        http_proxy: process.env.http_proxy,
        https_proxy: process.env.https_proxy,
        grpc_proxy: process.env.grpc_proxy,
        no_proxy: process.env.no_proxy,
    };

    try {
        await withSystemProxyPolicy(false, async () => {
            assert.equal(process.env.http_proxy, undefined);
            assert.equal(process.env.https_proxy, undefined);
            assert.equal(process.env.grpc_proxy, undefined);
            assert.equal(process.env.no_proxy, undefined);
        });

        assert.deepEqual({
            http_proxy: process.env.http_proxy,
            https_proxy: process.env.https_proxy,
            grpc_proxy: process.env.grpc_proxy,
            no_proxy: process.env.no_proxy,
        }, before);
    } finally {
        restoreTestProxyEnv(original);
    }
});
