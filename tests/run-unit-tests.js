/**
 * Runs the pure unit tests defined in src/Tests.gs (runUnitTests) under Node.js,
 * without a Google environment. Only service-free code paths are exercised.
 *
 * Usage:  node tests/run-unit-tests.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src');
const FILES = ['Schema.gs', 'Utils.gs', 'SheetStore.gs', 'ConfigService.gs', 'ImportMappingService.gs',
  'TeamTypeService.gs', 'TeamService.gs', 'StaffFieldService.gs', 'StaffService.gs', 'ScheduleService.gs', 'DashboardService.gs',
  'QuinyxParser.gs', 'ValidationService.gs', 'AuditService.gs', 'ImportService.gs', 'Main.gs', 'Tests.gs'];

// Minimal stand-in for the one Utilities function pure code may touch.
const Utilities = {
  formatDate(d, tz, fmt) {
    const p = (n) => String(n).padStart(2, '0');
    return fmt.replace('yyyy', d.getUTCFullYear()).replace('MM', p(d.getUTCMonth() + 1)).replace('dd', p(d.getUTCDate()))
      .replace('HH', p(d.getUTCHours())).replace('mm', p(d.getUTCMinutes())).replace('ss', p(d.getUTCSeconds()));
  }
};

const context = vm.createContext({ console, Utilities });
for (const f of FILES) {
  vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), context, { filename: f });
}
const result = vm.runInContext('runUnitTests()', context);
process.exit(result.failed ? 1 : 0);
