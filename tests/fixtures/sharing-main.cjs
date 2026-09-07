// Test-only entry point. Keeps connector substitution out of the shipped app.
globalThis.roFixtureRequire = require;
require('../../electron/main');
