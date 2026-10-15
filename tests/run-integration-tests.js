/**
 * Runs runIntegrationTests() from src/Tests.gs against the in-memory Sheets
 * mock in tests/mock-gas.js. This exercises the real sheet read/write code
 * paths (setup, migration, team creation, staff sheets, imports, undo, views)
 * without Google. It complements — does not replace — running the same
 * function in a real spreadsheet copy.
 *
 * Usage:  node tests/run-integration-tests.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { makeGlobals } = require('./mock-gas');

const SRC = path.join(__dirname, '..', 'src');
const { globals } = makeGlobals('Europe/Stockholm');
const context = vm.createContext(globals);
fs.readdirSync(SRC).filter((f) => f.endsWith('.gs')).sort().forEach((f) => {
  vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), context, { filename: f });
});
const result = vm.runInContext('runIntegrationTests()', context);
process.exit(result.failed ? 1 : 0);
