/**
 * Runs the pure unit tests defined in src/Tests.gs (runUnitTests) under Node.js,
 * without a Google environment. Only service-free code paths are exercised.
 * Every .gs file in src/ is loaded (load order does not matter by design).
 *
 * Usage:  node tests/run-unit-tests.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src');

// Minimal stand-in for the one Utilities function pure code may touch.
const Utilities = {
  formatDate(d, tz, fmt) {
    const p = (n) => String(n).padStart(2, '0');
    return fmt.replace('yyyy', d.getUTCFullYear()).replace('MM', p(d.getUTCMonth() + 1)).replace('dd', p(d.getUTCDate()))
      .replace('HH', p(d.getUTCHours())).replace('mm', p(d.getUTCMinutes())).replace('ss', p(d.getUTCSeconds()));
  }
};

const context = vm.createContext({ console, Utilities });
fs.readdirSync(SRC).filter((f) => f.endsWith('.gs')).sort().forEach((f) => {
  vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), context, { filename: f });
});
const result = vm.runInContext('runUnitTests()', context);

// Requirement (v1.1.1 #32): setup/migrations must never create (duplicate) triggers.
// Static check: no source file may create triggers at all.
const triggerUse = fs.readdirSync(SRC).filter((f) => /\.(gs|html)$/.test(f))
  .filter((f) => /ScriptApp\s*\.\s*newTrigger/.test(fs.readFileSync(path.join(SRC, f), 'utf8')));
console.log(triggerUse.length ? '  FAIL trigger creation found in: ' + triggerUse.join(', ') : '  PASS no source file creates triggers (ScriptApp.newTrigger)');

process.exit(result.failed || triggerUse.length ? 1 : 0);
