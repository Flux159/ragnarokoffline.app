const { defineConfig } = require('@playwright/test');
const path = require('node:path');

module.exports = defineConfig({
    testDir: './tests/e2e', testMatch: '*.spec.cjs', workers: 1,
    timeout: 120000, expect: { timeout: 20000 },
    outputDir: path.join('artifacts', 'issue-6', process.env.RO_E2E_BUILD || 'local', 'playwright'),
    reporter: [['list']],
    // Authentication happens before manually starting a trace. Never record
    // account/password fill actions in a trace or automatically launch a VM.
    use: { baseURL: 'http://127.0.0.1:3338', viewport: { width: 1440, height: 900 }, trace: 'off', screenshot: 'off' },
});
