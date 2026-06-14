const assert = require('node:assert/strict');
const test = require('node:test');
const { runBenchmark } = require('./build-benchmark.js');

test('runBenchmark sets a failing exit code when any build step fails', () => {
    let requestedExitCode;
    let savedResults;
    const results = runBenchmark({
        measure: (command, description) => ({
            success: command !== 'pnpm build:core',
            duration: 1,
            command,
            description
        }),
        save: (resultsToSave) => {
            savedResults = resultsToSave;
        },
        setExitCode: (code) => {
            requestedExitCode = code;
        }
    });

    assert.equal(requestedExitCode, 1);
    assert.equal(results.length, 3);
    assert.equal(savedResults, results);
});

test('runBenchmark leaves exit code unchanged when all build steps pass', () => {
    let requestedExitCode;
    const results = runBenchmark({
        measure: (command, description) => ({
            success: true,
            duration: 1,
            command,
            description
        }),
        save: () => {},
        setExitCode: (code) => {
            requestedExitCode = code;
        }
    });

    assert.equal(requestedExitCode, undefined);
    assert.equal(results.every(result => result.success), true);
});
