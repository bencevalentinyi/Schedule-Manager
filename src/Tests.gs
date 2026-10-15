/**
 * Tests.gs
 * - runUnitTests(): pure tests of parsing, normalization, mapping, keys and the
 *   import planner. No spreadsheet access; safe to run anywhere (also used by
 *   tests/run-unit-tests.js under Node.js).
 * - runIntegrationTests(): end-to-end tests against the real spreadsheet. They
 *   create and delete "ZZ Test" teams and records, so they only run in a blank
 *   spreadsheet or when _CONFIG TEST_MODE = TRUE. Never run them in production.
 *
 * Run from the Apps Script editor: select the function and click Run; results
 * are printed to the execution log.
 */

/* ------------------------------------------------------------------------ */
/* Mini test framework                                                       */
/* ------------------------------------------------------------------------ */

function assert_(cond, msg) {
  if (!cond) throw new Error('Assertion failed: ' + msg);
}

function assertEq_(actual, expected, msg) {
  var a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error((msg ? msg + ': ' : '') + 'expected ' + b + ' but got ' + a);
}

function assertThrows_(fn, code, msg) {
  try { fn(); } catch (e) {
    if (code && e.code !== code) throw new Error((msg || 'assertThrows') + ': expected code ' + code + ' but got ' + (e.code || e.message));
    return e;
  }
  throw new Error((msg || 'assertThrows') + ': expected an error');
}

function runTestList_(title, tests) {
  var results = tests.map(function (t) {
    try { t[1](); return { name: t[0], ok: true }; }
    catch (e) { return { name: t[0], ok: false, error: e.message }; }
  });
  var failed = results.filter(function (r) { return !r.ok; });
  console.log(title + ': ' + (results.length - failed.length) + '/' + results.length + ' passed');
  results.forEach(function (r) { console.log((r.ok ? '  PASS ' : '  FAIL ') + r.name + (r.ok ? '' : ' — ' + r.error)); });
  return { total: results.length, failed: failed.length, results: results };
}

/* ------------------------------------------------------------------------ */
/* Unit tests (pure)                                                         */
/* ------------------------------------------------------------------------ */

var TEST_CFG_ = { MAX_SHIFT_HOURS: '16', MIN_SHIFT_MINUTES: '15', NAME_MATCH_STRATEGY: 'EXACT_FLAGGED', STRIP_LEADING_ZEROS: 'FALSE' };

var CSV_BASIC_ = [
  'Employee ID,Employee Name,Date,Start Time,End Time,Break,Activity',
  'E1,Ann Lee,2026-10-15,08:00,16:30,30,Phone',
  'E2,Bob Ray,2026-10-15,09:00,17:00,0:45,Chat'
].join('\n');

function testTeams_() {
  return [
    { teamId: 'TEAM_001', teamName: 'Alpha', importAliases: 'A-Team, Section 1', status: 'READY' },
    { teamId: 'TEAM_002', teamName: 'Beta', importAliases: '', status: 'READY' }
  ];
}

function testStaff_() {
  return {
    TEAM_001: buildStaffIndex_([
      { employeeId: 'E1', employeeName: 'Ann Lee', active: true },
      { employeeId: 'E2', employeeName: 'Bob Ray', active: true },
      { employeeId: 'E3', employeeName: 'Cy Moe', active: false }
    ]),
    TEAM_002: buildStaffIndex_([{ employeeId: 'E7', employeeName: 'Dee Fox', active: true }])
  };
}

/** Builds a plan from CSV text with auto-mapping and test fixtures. */
function planFromCsv_(csv, overrides) {
  var table = trimTable_(parseCsv_(csv, detectDelimiter_(csv)));
  var headers = buildHeaders_(table[0]);
  var auto = autoMapHeaders_(headers, buildSynonymIndex_(DEFAULT_SYNONYMS));
  var staff = testStaff_();
  var input = {
    table: table, headerRow: 0, fieldMap: auto.fieldMap, options: { dateOrder: 'AUTO', breakUnit: 'MINUTES' },
    teamMode: 'EXPLICIT', teamId: 'TEAM_001', strategy: 'UPDATE', allowPartial: false,
    teams: testTeams_(), profileOptions: {}, existing: [],
    getStaffIndex: function (id) { return staff[id] || null; }, cfg: TEST_CFG_
  };
  Object.keys(overrides || {}).forEach(function (k) { input[k] = overrides[k]; });
  return buildImportPlan_(input);
}

/** Applies plan actions to an in-memory record list (mirrors applyActionsToData_). */
function applyPlanInMemory_(existing, plan, importId) {
  var byKey = {};
  var out = existing.map(function (r) { var c = JSON.parse(JSON.stringify(r)); byKey[c.recordKey] = c; return c; });
  plan.actions.forEach(function (a) {
    if (a.type === 'INSERT') {
      var rec = JSON.parse(JSON.stringify(a.record));
      rec.createdImportId = importId; rec.lastImportId = importId;
      out.push(rec); byKey[rec.recordKey] = rec;
    } else if (a.type === 'UPDATE') {
      var u = JSON.parse(JSON.stringify(a.record));
      u.lastImportId = importId;
      Object.keys(u).forEach(function (k) { byKey[a.key][k] = u[k]; });
    } else if (a.type === 'REMOVE') {
      byKey[a.key].recordStatus = RECORD_STATUS.REMOVED;
      byKey[a.key].lastImportId = importId;
    }
  });
  return out;
}

function unitTests_() {
  return [
    ['CSV: quoted fields, escaped quotes, embedded newline, CRLF', function () {
      var t = parseCsv_('a,b,c\r\n"x, y","say ""hi""","line1\nline2"\r\n1,,3', ',');
      assertEq_(t, [['a', 'b', 'c'], ['x, y', 'say "hi"', 'line1\nline2'], ['1', '', '3']]);
    }],
    ['CSV: unterminated quote is an error', function () {
      assertThrows_(function () { parseCsv_('a,"b\n1,2', ','); }, 'PARSE');
    }],
    ['Delimiter detection: semicolon with commas inside values', function () {
      assertEq_(detectDelimiter_('Name;Start;End\n"Lee, Ann";08:00;16:00\n"Ray, Bob";09:00;17:00'), ';');
      assertEq_(detectDelimiter_('a\tb\tc\n1\t2\t3'), '\t');
    }],
    ['trimTable_ removes trailing blanks and pads rows', function () {
      assertEq_(trimTable_([[' a ', 'b', ''], ['1'], ['', '', ''], []]), [['a', 'b'], ['1', '']]);
    }],
    ['Header detection skips title rows', function () {
      var table = [['Schedule export', '', ''], ['Generated 2026-10-15', '', ''], ['Employee ID', 'Start', 'End'], ['E1', '08:00', '16:00']];
      assertEq_(detectHeaderRow_(table, buildSynonymIndex_(DEFAULT_SYNONYMS)), 2);
    }],
    ['buildHeaders_ makes labels unique and non-empty', function () {
      assertEq_(buildHeaders_(['Name', '', 'name', 'Name']), ['Name', 'Column 2', 'name (2)', 'Name (3)']);
    }],
    ['Auto-map: different column order maps the same fields', function () {
      var idx = buildSynonymIndex_(DEFAULT_SYNONYMS);
      var a = autoMapHeaders_(['Employee ID', 'Date', 'Start Time', 'End Time'], idx).fieldMap;
      var b = autoMapHeaders_(['End Time', 'Start Time', 'Employee ID', 'Date'], idx).fieldMap;
      assertEq_(a.employeeId, 'Employee ID'); assertEq_(b.start, 'Start Time'); assertEq_(b.end, 'End Time'); assertEq_(b.date, 'Date');
    }],
    ['Auto-map: two candidate columns are flagged ambiguous, not guessed', function () {
      var r = autoMapHeaders_(['Employee ID', 'Employee Number', 'Start', 'End'], buildSynonymIndex_(DEFAULT_SYNONYMS));
      assert_(!r.fieldMap.employeeId, 'employeeId must stay unmapped');
      assertEq_(r.ambiguous[0].field, 'employeeId');
    }],
    ['Mapping validation: missing end column is fatal', function () {
      var rep = validateMapping_({ employeeId: 0, start: 1 });
      assert_(rep.fatal.some(function (m) { return /Shift End/.test(m); }), 'fatal about Shift End');
    }],
    ['resolveFieldMap_ reports profile columns missing from the file', function () {
      var r = resolveFieldMap_({ employeeId: 'Emp No', start: 'From' }, ['From', 'To']);
      assertEq_(r.columns, { start: 0 });
      assertEq_(r.missing, [{ field: 'employeeId', header: 'Emp No' }]);
    }],
    ['Dates: ISO, month names, weekday prefix, compact, serial', function () {
      assertEq_(parseDateValue_('2026-10-15', 'DMY').date, '2026-10-15');
      assertEq_(parseDateValue_('Thu 15 Oct 2026', 'DMY').date, '2026-10-15');
      assertEq_(parseDateValue_('October 15, 2026', 'DMY').date, '2026-10-15');
      assertEq_(parseDateValue_('20261015', 'DMY').date, '2026-10-15');
      assertEq_(parseDateValue_('46310', 'DMY').date, '2026-10-15');
      assertEq_(parseDateValue_('15.10.26', 'DMY').date, '2026-10-15');
    }],
    ['Dates: DMY vs MDY and invalid calendar dates', function () {
      assertEq_(parseDateValue_('03/04/2026', 'DMY').date, '2026-04-03');
      assertEq_(parseDateValue_('03/04/2026', 'MDY').date, '2026-03-04');
      assert_(parseDateValue_('31/02/2026', 'DMY').error, '31 Feb must be invalid');
      assert_(parseDateValue_('not a date', 'DMY').error, 'garbage must be invalid');
    }],
    ['Date order detection: DMY, MDY, ambiguous, conflict', function () {
      assertEq_(detectDateOrder_(['13/10/2026', '01/10/2026']).order, 'DMY');
      assertEq_(detectDateOrder_(['10/13/2026']).order, 'MDY');
      assertEq_(detectDateOrder_(['03/04/2026']).order, 'AMBIGUOUS');
      assertEq_(detectDateOrder_(['13/10/2026', '10/13/2026']).order, 'CONFLICT');
      assertEq_(detectDateOrder_(['2026-10-15', '08:00']).order, 'NONE');
    }],
    ['Times: 24h, dots, seconds, am/pm, compact, 24:00, invalid', function () {
      assertEq_(parseTime_('08:00'), 480); assertEq_(parseTime_('8.30'), 510); assertEq_(parseTime_('08:00:59'), 480);
      assertEq_(parseTime_('2:30 PM'), 870); assertEq_(parseTime_('12am'), 0); assertEq_(parseTime_('0800'), 480);
      assertEq_(parseTime_('24:00'), 1440); assertEq_(parseTime_('25:00'), null); assertEq_(parseTime_('8:5'), null);
    }],
    ['Durations: minutes, h:mm, units, hours unit', function () {
      assertEq_(parseDuration_('30', 'MINUTES').minutes, 30); assertEq_(parseDuration_('0:45').minutes, 45);
      assertEq_(parseDuration_('00:30:00').minutes, 30); assertEq_(parseDuration_('1h 15m').minutes, 75);
      assertEq_(parseDuration_('0.5', 'HOURS').minutes, 30); assertEq_(parseDuration_('1,5h').minutes, 90);
      assert_(parseDuration_('abc').error, 'garbage must be an error');
    }],
    ['Date-time values with T, seconds and Z suffix', function () {
      var v = parseDateTimeValue_('2026-10-15T22:00:00Z', 'DMY');
      assertEq_([v.date, v.minutes, v.tz], ['2026-10-15', 1320, true]);
    }],
    ['Normalize: basic shift with break', function () {
      var r = normalizeRow_(['E1', 'Ann', '2026-10-15', '08:00', '16:30', '30'], ['id', 'n', 'd', 's', 'e', 'b'],
        { employeeId: 0, employeeName: 1, date: 2, start: 3, end: 4, breakMinutes: 5 },
        { dateOrder: 'DMY', breakUnit: 'MINUTES', maxShiftMinutes: 960, minShiftMinutes: 15 });
      assertEq_(r.errors, []);
      assertEq_([r.shiftStart, r.shiftEnd, r.grossMinutes, r.breakMinutes, r.netMinutes], ['2026-10-15 08:00', '2026-10-15 16:30', 510, 30, 480]);
    }],
    ['Normalize: overnight shift ends next day', function () {
      var r = normalizeRow_(['E1', '2026-10-15', '22:00', '06:00'], ['a', 'b', 'c', 'd'], { employeeId: 0, date: 1, start: 2, end: 3 },
        { dateOrder: 'DMY', maxShiftMinutes: 960, minShiftMinutes: 15 });
      assertEq_([r.shiftDate, r.shiftEnd, r.grossMinutes, r.overnight], ['2026-10-15', '2026-10-16 06:00', 480, true]);
    }],
    ['Normalize: end at 24:00 is not overnight', function () {
      var r = normalizeRow_(['E1', '2026-10-15', '16:00', '24:00'], ['a', 'b', 'c', 'd'], { employeeId: 0, date: 1, start: 2, end: 3 },
        { dateOrder: 'DMY', maxShiftMinutes: 960, minShiftMinutes: 15 });
      assertEq_([r.shiftEnd, r.grossMinutes, r.overnight], ['2026-10-16 00:00', 480, false]);
    }],
    ['Normalize: break across midnight is placed on the right day', function () {
      var r = normalizeRow_(['E1', '2026-10-15', '20:00', '04:00', '23:45', '00:15'], ['a', 'b', 'c', 'd', 'e', 'f'],
        { employeeId: 0, date: 1, start: 2, end: 3, breakStart: 4, breakEnd: 5 }, { dateOrder: 'DMY', maxShiftMinutes: 960, minShiftMinutes: 15 });
      assertEq_([r.breakStart, r.breakEnd, r.breakMinutes, r.netMinutes], ['2026-10-15 23:45', '2026-10-16 00:15', 30, 450]);
    }],
    ['Normalize: errors for identical times, explicit end before start, missing date, bad time', function () {
      var o = { dateOrder: 'DMY', maxShiftMinutes: 960, minShiftMinutes: 15 };
      var cols = { employeeId: 0, date: 1, start: 2, end: 3 };
      assert_(normalizeRow_(['E1', '2026-10-15', '08:00', '08:00'], ['a', 'b', 'c', 'd'], cols, o).errors.length, 'identical');
      assert_(normalizeRow_(['E1', '', '08:00', '16:00'], ['a', 'b', 'c', 'd'], cols, o).errors.length, 'missing date');
      assert_(normalizeRow_(['E1', '2026-10-15', '8 o clock', '16:00'], ['a', 'b', 'c', 'd'], cols, o).errors.length, 'bad time');
      var r = normalizeRow_(['E1', '2026-10-15 18:00', '2026-10-15 09:00'], ['a', 'b', 'c'], { employeeId: 0, start: 1, end: 2 }, o);
      assert_(r.errors.some(function (e) { return /before it starts/.test(e); }), 'explicit end before start');
    }],
    ['Normalize: unmapped columns are preserved in extra', function () {
      var r = normalizeRow_(['E1', '2026-10-15', '08:00', '16:00', 'CC-42', ''], ['id', 'd', 's', 'e', 'Cost Center', 'Empty'],
        { employeeId: 0, date: 1, start: 2, end: 3 }, { dateOrder: 'DMY', maxShiftMinutes: 960, minShiftMinutes: 15 });
      assertEq_(r.extra, { 'Cost Center': 'CC-42' });
    }],
    ['Record key: shift ID preferred; composite distinguishes same-day shifts', function () {
      assertEq_(buildRecordKey_('TEAM_001', { shiftId: '991' }), 'S|991');
      var a = buildRecordKey_('TEAM_001', { employeeId: 'e1', shiftStart: '2026-10-15 08:00', shiftEnd: '2026-10-15 12:00', activity: 'Phone' });
      var b = buildRecordKey_('TEAM_001', { employeeId: 'E1', shiftStart: '2026-10-15 13:00', shiftEnd: '2026-10-15 17:00', activity: 'Phone' });
      assert_(a !== b, 'two shifts on one day need different keys');
      assert_(a.indexOf('ID:E1') >= 0, 'ID part is case-insensitive');
    }],
    ['Employee IDs: whitespace, ".0", optional leading zeros', function () {
      assertEq_(normalizeEmployeeId_(' 12 34 '), '1234'); assertEq_(normalizeEmployeeId_('123.0'), '123');
      assertEq_(normalizeEmployeeId_('00123', true), '123'); assertEq_(normalizeEmployeeId_('00123', false), '00123');
    }],
    ['Staff matching: ID, unique exact name, ambiguous name, NONE strategy', function () {
      var idx = buildStaffIndex_([{ employeeId: 'E1', employeeName: 'Ann Lee', active: true },
        { employeeId: 'E5', employeeName: 'Sam Doe', active: true }, { employeeId: 'E6', employeeName: 'Sam  Doe', active: true }]);
      assertEq_(matchEmployee_(idx, 'e1', '', 'EXACT_FLAGGED').status, 'ID');
      assertEq_(matchEmployee_(idx, '', 'ann LEE', 'EXACT_FLAGGED').status, 'NAME');
      assertEq_(matchEmployee_(idx, '', 'Sam Doe', 'EXACT_FLAGGED').status, 'AMBIGUOUS');
      assertEq_(matchEmployee_(idx, '', 'Ann Lee', 'NONE').status, 'UNKNOWN');
      assertEq_(matchEmployee_(idx, '', 'Ann Leigh', 'EXACT_FLAGGED').status, 'UNKNOWN');
    }],
    ['Sheet names: invalid characters, length, uniqueness', function () {
      assertEq_(sanitizeSheetName_("  'Ops: [EU]/Night?' "), 'Ops- -EU--Night-');
      var long = new Array(120).join('x');
      var n = applySheetPattern_('{team} - Daily', long);
      assert_(n.length <= 100 && /- Daily$/.test(n), 'pattern suffix kept within 100 chars');
      assertEq_(uniqueSheetName_('A - Daily', ['a - daily', 'a - daily (2)']), 'A - Daily (3)');
    }],
    ['Plan: valid import inserts all rows and can commit', function () {
      var p = planFromCsv_(CSV_BASIC_);
      assertEq_(p.report.fatal, []);
      assertEq_([p.summary.validRows, p.summary.insert, p.canCommit], [2, 2, true]);
    }],
    ['Plan: different column order produces identical keys', function () {
      var csv2 = ['Activity,End Time,Start Time,Date,Employee Name,Employee ID,Break',
        'Phone,16:30,08:00,2026-10-15,Ann Lee,E1,30', 'Chat,17:00,09:00,2026-10-15,Bob Ray,E2,0:45'].join('\n');
      var k1 = planFromCsv_(CSV_BASIC_).actions.map(function (a) { return a.key; }).sort();
      var k2 = planFromCsv_(csv2).actions.map(function (a) { return a.key; }).sort();
      assertEq_(k2, k1);
    }],
    ['Plan: missing required column stops the import', function () {
      var p = planFromCsv_('Employee ID,Date,Start Time\nE1,2026-10-15,08:00');
      assert_(p.report.fatal.length > 0 && !p.canCommit, 'must be blocked');
      assertEq_(p.actions.length, 0);
    }],
    ['Plan: unknown and inactive employees are imported but flagged', function () {
      var p = planFromCsv_('Employee ID,Date,Start,End\nE9,2026-10-15,08:00,12:00\nE3,2026-10-15,08:00,12:00');
      assertEq_([p.summary.unknownEmployeeCount, p.summary.inactiveStaff, p.summary.insert], [1, 1, 2]);
      assert_(p.canCommit, 'unknown employees do not block');
    }],
    ['Plan: multiple shifts per employee per day', function () {
      var p = planFromCsv_('Employee ID,Date,Start,End\nE1,2026-10-15,08:00,12:00\nE1,2026-10-15,13:00,17:00');
      assertEq_([p.summary.insert, p.summary.overlapsCount], [2, 0]);
    }],
    ['Plan: overlapping shifts are reported', function () {
      var p = planFromCsv_('Employee ID,Date,Start,End\nE1,2026-10-15,08:00,12:00\nE1,2026-10-15,11:00,15:00');
      assertEq_(p.summary.overlapsCount, 1);
    }],
    ['Plan: overnight shift', function () {
      var p = planFromCsv_('Employee ID,Date,Start,End\nE1,2026-10-15,22:00,06:00');
      assertEq_([p.summary.overnight, p.actions[0].record.shiftEnd], [1, '2026-10-16 06:00']);
    }],
    ['Plan: re-import is unchanged; exact duplicate row in file skipped', function () {
      var first = planFromCsv_(CSV_BASIC_);
      var stored = applyPlanInMemory_([], first, 'IMP_1');
      var again = planFromCsv_(CSV_BASIC_ + '\nE1,Ann Lee,2026-10-15,08:00,16:30,30,Phone', { existing: stored });
      assertEq_([again.actions.length, again.summary.unchanged, again.summary.duplicatesInFile], [0, 2, 1]);
    }],
    ['Plan: conflicting copies of one shift in the file are rejected', function () {
      var p = planFromCsv_('Shift ID,Employee ID,Date,Start,End\n77,E1,2026-10-15,08:00,12:00\n77,E1,2026-10-15,09:00,12:00');
      assertEq_([p.summary.insert, p.summary.rejectedRows], [1, 1]);
    }],
    ['Plan: changed shift with SKIP, UPDATE and ASK strategies', function () {
      var stored = applyPlanInMemory_([], planFromCsv_(CSV_BASIC_), 'IMP_1');
      var changed = CSV_BASIC_.replace('16:30,30,Phone', '16:30,45,Phone');
      var skip = planFromCsv_(changed, { existing: stored, strategy: 'SKIP' });
      var upd = planFromCsv_(changed, { existing: stored, strategy: 'UPDATE' });
      var ask = planFromCsv_(changed, { existing: stored, strategy: 'ASK' });
      assertEq_([skip.summary.skippedExisting, skip.actions.length], [1, 0]);
      assertEq_([upd.summary.update, upd.actions[0].type, upd.actions[0].record.breakMinutes], [1, 'UPDATE', 45]);
      assertEq_([ask.summary.changedPending, ask.canCommit], [1, false]);
    }],
    ['Plan: REPLACE_RANGE removes only inside the imported range', function () {
      var base = 'Employee ID,Date,Start,End\nE1,2026-10-14,08:00,12:00\nE1,2026-10-15,08:00,12:00\nE2,2026-10-15,08:00,12:00\nE2,2026-10-16,08:00,12:00';
      var stored = applyPlanInMemory_([], planFromCsv_(base), 'IMP_1');
      var p = planFromCsv_('Employee ID,Date,Start,End\nE1,2026-10-15,08:00,12:00', { existing: stored, strategy: 'REPLACE_RANGE' });
      assertEq_([p.summary.remove, p.summary.unchanged], [1, 1]);
      var removed = p.actions.filter(function (a) { return a.type === 'REMOVE'; })[0];
      assertEq_(removed.before.shiftDate, '2026-10-15');
      var after = applyPlanInMemory_(stored, p, 'IMP_2');
      assertEq_(after.filter(function (r) { return r.recordStatus === 'ACTIVE'; }).map(function (r) { return r.shiftDate; }).sort(), ['2026-10-14', '2026-10-15', '2026-10-16']);
    }],
    ['Plan: REPLACE_RANGE is blocked when rows of that team were rejected', function () {
      var stored = applyPlanInMemory_([], planFromCsv_(CSV_BASIC_), 'IMP_1');
      var p = planFromCsv_('Employee ID,Date,Start,End\nE1,2026-10-15,08:00,12:00\nE2,2026-10-15,99:00,12:00', { existing: stored, strategy: 'REPLACE_RANGE', allowPartial: true });
      assert_(p.report.fatal.some(function (m) { return /Replace is blocked/.test(m); }) && !p.canCommit, 'must block');
    }],
    ['Plan: rejected rows block unless partial import is allowed', function () {
      var csv = 'Employee ID,Date,Start,End\nE1,2026-10-15,08:00,12:00\nE2,2026-02-31,08:00,12:00';
      assertEq_(planFromCsv_(csv).canCommit, false);
      var p = planFromCsv_(csv, { allowPartial: true });
      assertEq_([p.canCommit, p.summary.insert, p.summary.rejectedRows], [true, 1, 1]);
    }],
    ['Plan: ambiguous numeric dates are fatal until the order is chosen', function () {
      var csv = 'Employee ID,Date,Start,End\nE1,03/04/2026,08:00,12:00';
      assert_(planFromCsv_(csv).report.fatal.some(function (m) { return /ambiguous/.test(m); }), 'ambiguous fatal');
      var p = planFromCsv_(csv, { options: { dateOrder: 'DMY' } });
      assertEq_(p.actions[0].record.shiftDate, '2026-04-03');
    }],
    ['Plan: SPLIT routes by name/alias and rejects unknown team values', function () {
      var csv = 'Team,Employee ID,Date,Start,End\nA-Team,E1,2026-10-15,08:00,12:00\nbeta,E7,2026-10-15,08:00,12:00\nGamma,E8,2026-10-15,08:00,12:00';
      var p = planFromCsv_(csv, { teamMode: 'AUTO', teamId: '', allowPartial: true });
      assertEq_(p.teamMode, 'SPLIT');
      assertEq_(p.summary.teams.map(function (t) { return t.teamId + ':' + t.rows; }).sort(), ['TEAM_001:1', 'TEAM_002:1']);
      assertEq_(p.summary.rejectedRows, 1);
    }],
    ['Plan: FILTER keeps only the selected team; EXPLICIT warns about other teams', function () {
      var csv = 'Team,Employee ID,Date,Start,End\nAlpha,E1,2026-10-15,08:00,12:00\nBeta,E7,2026-10-15,08:00,12:00';
      var f = planFromCsv_(csv, { teamMode: 'FILTER', teamId: 'TEAM_002' });
      assertEq_([f.summary.insert, f.summary.otherTeamRows, f.actions[0].teamId], [1, 1, 'TEAM_002']);
      var e = planFromCsv_(csv, { teamMode: 'EXPLICIT', teamId: 'TEAM_001' });
      assert_(e.report.warnings.some(function (m) { return /other teams/.test(m); }), 'warns about other team values');
    }],
    ['Plan: no team column and no team selected is fatal', function () {
      var p = planFromCsv_(CSV_BASIC_, { teamMode: 'AUTO', teamId: '' });
      assert_(p.report.fatal.some(function (m) { return /target team/.test(m); }), 'fatal');
    }],
    ['Plan: name-only rows match a unique staff name and are flagged', function () {
      var p = planFromCsv_('Employee,Date,Start,End\nAnn Lee,2026-10-15,08:00,12:00');
      assertEq_([p.summary.nameMatched, p.actions[0].record.employeeId, p.actions[0].record.staffMatch], [1, 'E1', 'NAME']);
      assert_(p.actions[0].key.indexOf('NM:ann lee') >= 0, 'key uses the source name, not the matched ID');
    }],
    ['Plan token changes when stored data changes', function () {
      var p1 = planFromCsv_(CSV_BASIC_);
      var stored = applyPlanInMemory_([], planFromCsv_('Employee ID,Date,Start,End\nE1,2026-10-15,08:00,16:30'), 'IMP_0');
      var p2 = planFromCsv_(CSV_BASIC_, { existing: stored, strategy: 'REPLACE_RANGE' });
      assert_(p1.token !== p2.token, 'tokens must differ');
      assertEq_(planFromCsv_(CSV_BASIC_).token, p1.token, 'token is deterministic');
    }],
    ['Daily view rows: carry-over, overnight flag and headcount', function () {
      var recs = [
        { recordStatus: 'ACTIVE', teamId: 'T', employeeId: 'E1', employeeName: 'Ann', shiftDate: '2026-10-14', shiftStart: '2026-10-14 22:00', shiftEnd: '2026-10-15 07:00', breakStart: '', breakEnd: '', breakMinutes: 0 },
        { recordStatus: 'ACTIVE', teamId: 'T', employeeId: 'E2', employeeName: 'Bob', shiftDate: '2026-10-15', shiftStart: '2026-10-15 05:00', shiftEnd: '2026-10-15 09:00', breakStart: '2026-10-15 05:00', breakEnd: '2026-10-15 05:45', breakMinutes: 45 },
        { recordStatus: 'REMOVED', teamId: 'T', employeeId: 'E3', employeeName: 'Cy', shiftDate: '2026-10-15', shiftStart: '2026-10-15 05:00', shiftEnd: '2026-10-15 09:00', breakMinutes: 0 }
      ];
      var rows = buildDayRows_(recs, '2026-10-15', null, { maxShiftMinutes: 960, nameStrategy: 'NONE', showCarryOver: true });
      assertEq_(rows.length, 2);
      assert_(rows[0].flags.indexOf('From previous day') >= 0 && rows[0].flags.indexOf('Overnight') >= 0, 'carry-over flags');
      var hc = headcountByHour_(rows, '2026-10-15', 300, 420);
      assertEq_(hc.map(function (h) { return h.count; }), [1, 2]);
    }]
  ];
}

/* ---------------------------- v1.1 unit tests ---------------------------- */

/** Synthetic Daily Schedule sheet following the DESCRIBED layout (not a real export). */
function dailyFixture_() {
  return [
    ['Daily schedule 2026-10-15', '', '', '', '', ''],
    ['SHIFT TYPE', 'Employee Name', 'Shift', 'D', 'E', 'Hours'],
    ['Customer Support', 'Ann Lee', '08:00 - 16:30', '', '', '8'],
    ['Customer Support', 'Bob Ray', '22:00 - 06:00', '', '', '8'],
    ['Training', 'Cy Moe', '09:00 - 11:00', '', '', '2'],
    ['', '', '', '', '', ''],
    ['Meeting', '', '', '', '', '']
  ];
}

function planFromDaily_(table, filter, overrides) {
  var a = adaptDailySchedule_(table, DEFAULT_DAILY_LAYOUT, { dateOrder: 'AUTO' });
  var pre = newReport_();
  mergeReport_(pre, a);
  var staff = testStaff_();
  var input = {
    table: a.table, headerRow: 0, fieldMap: a.fieldMap, options: { dateOrder: 'AUTO', hoursUnit: 'HOURS' },
    teamMode: 'EXPLICIT', teamId: 'TEAM_001', strategy: 'UPDATE', allowPartial: false,
    teams: testTeams_(), profileOptions: {}, existing: [], sourceRowNumbers: a.sourceRows, preReport: pre, scheduleDate: a.scheduleDate,
    getStaffIndex: function (id) { return staff[id] || null; },
    getShiftTypeFilter: function () { return filter; }, cfg: TEST_CFG_
  };
  Object.keys(overrides || {}).forEach(function (k) { input[k] = overrides[k]; });
  return buildImportPlan_(input);
}

function unitTestsV11_() {
  var SEL_CS = { mode: 'SELECTED', types: ['Customer Support'], known: ['Customer Support', 'Training'] };
  return [
    ['Daily: schedule date from A1 (ISO, d/m/y, month names, whitespace/case)', function () {
      assertEq_(extractScheduleDate_('Daily schedule 2026-10-15').date, '2026-10-15');
      assertEq_(extractScheduleDate_('  DAILY   SCHEDULE 15/10/2026 ').date, '2026-10-15');
      assertEq_(extractScheduleDate_('Daily schedule Thursday, October 15, 2026').date, '2026-10-15');
      assertEq_(extractScheduleDate_('Daily schedule 15 Oct 2026').date, '2026-10-15');
    }],
    ['Daily: unclear A1 dates are errors, never today', function () {
      assert_(extractScheduleDate_('Daily schedule').error, 'no date');
      assert_(extractScheduleDate_('').error, 'empty');
      assert_(/ambiguous/.test(extractScheduleDate_('Daily schedule 03/04/2026').error), 'ambiguous');
      assertEq_(extractScheduleDate_('Daily schedule 03/04/2026', 'DMY').date, '2026-04-03');
      assert_(/several/.test(extractScheduleDate_('Daily schedule 2026-10-15 - 2026-10-16').error), 'two dates');
    }],
    ['Daily: shift information formats', function () {
      var p = parseShiftInfo_('08:00 - 16:00');
      assertEq_([p.start, p.end], ['08:00', '16:00']);
      assertEq_([parseShiftInfo_('08:00-16:00').end, parseShiftInfo_('22:00–06:00').start], ['16:00', '22:00']);
      assertEq_(parseShiftInfo_('8:00 AM - 4:30 PM').end, '4:30 PM');
      assertEq_(parseShiftInfo_('08.00 to 16.00').end, '16.00');
      var d = parseShiftInfo_('2026-10-15 22:00 - 2026-10-16 06:00');
      assertEq_([d.start, d.end], ['2026-10-15 22:00', '2026-10-16 06:00']);
      assertEq_(parseShiftInfo_('2026-10-15 22:00 - 06:00').end, '06:00');
      assertEq_(parseShiftInfo_('08:00 - 16:00 (Phone)').rest, '(Phone)');
    }],
    ['Daily: unparseable shift information is rejected, not guessed', function () {
      assert_(parseShiftInfo_('Off').error, 'no range');
      assert_(/several/.test(parseShiftInfo_('08:00-12:00, 13:00-17:00').error), 'two ranges');
      assert_(parseShiftInfo_('').error, 'empty');
    }],
    ['Daily: adapter uses configured rows/columns and skips group rows', function () {
      var a = adaptDailySchedule_(dailyFixture_(), DEFAULT_DAILY_LAYOUT, {});
      assertEq_([a.scheduleDate, a.dateSource, a.dataRows, a.nonShiftRows], ['2026-10-15', 'title', 3, 1]);
      assertEq_(a.sourceRows, [3, 4, 5]);
      assertEq_(a.fieldMap.shiftType, 'Shift Type');
      assertEq_(a.fatal, []);
      var t = dailyFixture_();
      t.splice(1, 1); // no label row: data starts in row 2
      var b = adaptDailySchedule_(t, DEFAULT_DAILY_LAYOUT, {});
      assert_(b.warnings.some(function (w) { return /looks like data/.test(w); }), 'warns that the header row contains data');
      var c = adaptDailySchedule_(t, normalizeDailyLayout_({ headerRow: 0, firstDataRow: 2 }), {});
      assertEq_(c.dataRows, 3);
    }],
    ['Daily: missing date needs confirmation; override is used', function () {
      var t = dailyFixture_(); t[0][0] = 'Daily schedule';
      assert_(adaptDailySchedule_(t, DEFAULT_DAILY_LAYOUT, {}).fatal.length > 0, 'fatal without date');
      var a = adaptDailySchedule_(t, DEFAULT_DAILY_LAYOUT, { dateOverride: '2026-10-20' });
      assertEq_([a.fatal.length, a.scheduleDate, a.dateSource], [0, '2026-10-20', 'confirmed']);
    }],
    ['Daily: fill-down of grouped shift types (optional)', function () {
      var t = [['Daily schedule 2026-10-15'], ['SHIFT TYPE', 'Employee Name', 'Shift'],
        ['Customer Support', '', ''], ['', 'Ann Lee', '08:00 - 16:00'], ['', 'Bob Ray', '09:00 - 17:00']];
      var off = adaptDailySchedule_(t, DEFAULT_DAILY_LAYOUT, {});
      assertEq_(off.blankShiftTypes, 2);
      var on = adaptDailySchedule_(t, normalizeDailyLayout_({ fillDownShiftType: true }), {});
      assertEq_(discoverShiftTypes_(on.table, 'Shift Type'), [{ type: 'Customer Support', rows: 2 }]);
    }],
    ['Daily: discover shift types with counts', function () {
      var a = adaptDailySchedule_(dailyFixture_(), DEFAULT_DAILY_LAYOUT, {});
      assertEq_(discoverShiftTypes_(a.table, 'Shift Type'), [{ type: 'Customer Support', rows: 2 }, { type: 'Training', rows: 1 }]);
    }],
    ['Shift types: only selected types are imported; excluded rows are counted', function () {
      var p = planFromDaily_(dailyFixture_(), SEL_CS);
      assertEq_(p.report.fatal, []);
      assertEq_([p.summary.insert, p.summary.excludedByShiftType, p.summary.scheduleDate], [2, 1, '2026-10-15']);
      var tr = p.summary.shiftTypes.filter(function (t) { return t.type === 'Training'; })[0];
      assertEq_([tr.rows, tr.included, tr.excluded], [1, 0, 1]);
      assert_(p.actions.every(function (a) { return a.record.shiftType === 'Customer Support'; }), 'no other types written');
    }],
    ['Shift types: no selection blocks the import; "all" must be explicit', function () {
      var p = planFromDaily_(dailyFixture_(), { mode: 'NOT_CONFIGURED', types: [], known: [] });
      assert_(p.report.fatal.some(function (m) { return /no shift-type selection/.test(m); }) && !p.canCommit, 'blocked');
      var all = planFromDaily_(dailyFixture_(), { mode: 'ALL', types: [], known: ['Customer Support', 'Training'] });
      assertEq_([all.summary.insert, all.canCommit], [3, true]);
    }],
    ['Shift types: unseen types produce a warning and are not imported', function () {
      var p = planFromDaily_(dailyFixture_(), { mode: 'SELECTED', types: ['Customer Support'], known: ['Customer Support'] });
      assertEq_(p.summary.newShiftTypes, ['Training']);
      assert_(p.report.warnings.some(function (m) { return /not seen before/.test(m); }), 'warning');
      assertEq_(p.summary.excludedByShiftType, 1);
    }],
    ['Shift types: exact match after whitespace normalization only', function () {
      var t = dailyFixture_(); t[2][0] = '  Customer   Support '; t[3][0] = 'customer support';
      var p = planFromDaily_(t, SEL_CS);
      assertEq_([p.summary.insert, p.summary.excludedByShiftType], [1, 2]);
    }],
    ['Daily plan: overnight, hours comparison, name matching', function () {
      var p = planFromDaily_(dailyFixture_(), { mode: 'ALL', types: [], known: [] });
      var bob = p.actions.filter(function (a) { return a.record.employeeName === 'Bob Ray'; })[0].record;
      assertEq_([bob.shiftEnd, bob.grossMinutes, bob.scheduledMinutes], ['2026-10-16 06:00', 480, 480]);
      // Ann 08:00–16:30 vs "8" hours differs by 30 min (> 15); Cy Moe is in the fixture staff list (inactive).
      assertEq_([p.summary.overnight, p.summary.hoursDiscrepancies, p.summary.nameMatched, p.summary.unknownEmployeeCount, p.summary.inactiveStaff], [1, 1, 3, 0, 1]);
      var ann = p.actions.filter(function (a) { return a.record.employeeName === 'Ann Lee'; })[0].record;
      assertEq_([ann.employeeId, ann.staffMatch, ann.sourceShiftInfo, ann.sourceHours], ['E1', 'NAME', '08:00 - 16:30', '8']);
    }],
    ['Daily plan: invalid names, shift info and hours are reported', function () {
      var t = dailyFixture_();
      t.splice(5, 0, ['Customer Support', '', '08:00 - 10:00', '', '', '2'], ['Customer Support', 'Dee Fox', 'Off', '', '', ''],
        ['Customer Support', 'Eve Ng', '10:00 - 12:00', '', '', 'abc'], ['Customer Support', 'Fay Lu', '12:00 - 14:00', '', '', '']);
      var p = planFromDaily_(t, SEL_CS, { allowPartial: true });
      assertEq_([p.summary.missingEmployee, p.summary.unparseableShiftInfo, p.summary.hoursInvalid, p.summary.hoursMissing], [1, 1, 1, 1]);
      assertEq_(p.rejected.map(function (r) { return r.row; }).sort(), [6, 7]);
    }],
    ['Daily plan: repeated import creates no duplicates', function () {
      var first = planFromDaily_(dailyFixture_(), SEL_CS);
      var stored = applyPlanInMemory_([], first, 'IMP_1');
      var again = planFromDaily_(dailyFixture_(), SEL_CS, { existing: stored });
      assertEq_([again.actions.length, again.summary.unchanged], [0, 2]);
    }],
    ['Daily plan: Replace touches only the selected shift types of that date', function () {
      var stored = applyPlanInMemory_([], planFromDaily_(dailyFixture_(), { mode: 'ALL', types: [], known: [] }), 'IMP_1');
      var t = dailyFixture_(); t.splice(3, 1); // Bob's shift no longer in the export
      var p = planFromDaily_(t, SEL_CS, { existing: stored, strategy: 'REPLACE_RANGE' });
      assertEq_(p.summary.remove, 1);
      assertEq_(p.actions.filter(function (a) { return a.type === 'REMOVE'; })[0].before.employeeName, 'Bob Ray');
      var after = applyPlanInMemory_(stored, p, 'IMP_2');
      assert_(after.some(function (r) { return r.shiftType === 'Training' && r.recordStatus === 'ACTIVE'; }), 'Training shift untouched');
    }],
    ['Record keys of pre-1.1 records are unchanged', function () {
      var r = { employeeId: 'E1', shiftStart: '2026-10-15 08:00', shiftEnd: '2026-10-15 16:00', activity: 'Phone' };
      assertEq_(buildRecordKey_('T', r), 'C|T|ID:E1|2026-10-15 08:00|2026-10-15 16:00|phone');
      r.shiftType = 'Customer Support';
      assertEq_(buildRecordKey_('T', r), 'C|T|ID:E1|2026-10-15 08:00|2026-10-15 16:00|phone|ST:customer support');
    }],
    ['Operating hours: windows for standard, 24/7, custom across midnight', function () {
      var std = operatingWindow_(mergeDisplay_({ operatingHoursMode: 'STANDARD', operatingHoursStart: '06:00', operatingHoursEnd: '22:00' }));
      assertEq_([std.startMin, std.endMin, std.fullDay], [360, 1320, false]);
      var all = operatingWindow_(mergeDisplay_({ operatingHoursMode: '24_7', operatingHoursStart: '09:00', operatingHoursEnd: '10:00' }));
      assertEq_([all.startMin, all.endMin, all.fullDay], [0, 1440, true]);
      var night = operatingWindow_(mergeDisplay_({ operatingHoursMode: 'CUSTOM', operatingHoursStart: '18:00', operatingHoursEnd: '06:00' }));
      assertEq_([night.startMin, night.endMin, night.crossesMidnight], [1080, 1800, true]);
      assertEq_(operatingWindow_(mergeDisplay_({ operatingHoursMode: 'CUSTOM', operatingHoursStart: '08:00', operatingHoursEnd: '23:59' })).endMin, 1440);
    }],
    ['Operating hours: legacy display hours migrate; validation rules', function () {
      var d = mergeDisplay_({ workdayStart: '07:00', workdayEnd: '19:00' });
      assertEq_([d.operatingHoursMode, d.operatingHoursStart, d.operatingHoursEnd], ['STANDARD', '07:00', '19:00']);
      var bad = newReport_(); validateDisplay_(mergeDisplay_({ operatingHoursMode: 'STANDARD', operatingHoursStart: '22:00', operatingHoursEnd: '06:00' }), bad);
      assert_(bad.fatal.length === 1, 'standard cannot cross midnight');
      var ok = newReport_(); validateDisplay_(mergeDisplay_({ operatingHoursMode: 'CUSTOM', operatingHoursStart: '22:00', operatingHoursEnd: '06:00' }), ok);
      var full = newReport_(); validateDisplay_(mergeDisplay_({ operatingHoursMode: '24_7' }), full);
      assertEq_([ok.fatal.length, full.fatal.length], [0, 0]);
    }],
    ['Daily view: 24/7 shows midnight-crossing shifts and 24 headcount slots', function () {
      var recs = [
        { recordStatus: 'ACTIVE', teamId: 'T', employeeId: 'E1', employeeName: 'Ann', shiftDate: '2026-10-14', shiftStart: '2026-10-14 22:00', shiftEnd: '2026-10-15 06:00', breakMinutes: 0 },
        { recordStatus: 'ACTIVE', teamId: 'T', employeeId: 'E2', employeeName: 'Bob', shiftDate: '2026-10-15', shiftStart: '2026-10-15 00:30', shiftEnd: '2026-10-15 08:00', breakMinutes: 0 },
        { recordStatus: 'ACTIVE', teamId: 'T', employeeId: 'E3', employeeName: 'Cy', shiftDate: '2026-10-15', shiftStart: '2026-10-15 23:00', shiftEnd: '2026-10-16 07:00', breakMinutes: 0 }
      ];
      var w = operatingWindow_(mergeDisplay_({ operatingHoursMode: '24_7' }));
      var rows = buildDayRows_(recs, '2026-10-15', null, { maxShiftMinutes: 960, nameStrategy: 'NONE', showCarryOver: false, window: w });
      assertEq_(rows.length, 3);
      var hc = headcountByHour_(rows, '2026-10-15', w.startMin, w.endMin);
      assertEq_([hc.length, hc[0].label, hc[0].count, hc[23].label, hc[23].count], [24, '00:00–01:00', 2, '23:00–24:00', 1]);
    }],
    ['Daily view: custom night window includes next-day starts; standard flags outside hours', function () {
      var recs = [
        { recordStatus: 'ACTIVE', teamId: 'T', employeeId: 'E1', employeeName: 'Ann', shiftDate: '2026-10-16', shiftStart: '2026-10-16 02:00', shiftEnd: '2026-10-16 06:00', breakMinutes: 0 },
        { recordStatus: 'ACTIVE', teamId: 'T', employeeId: 'E2', employeeName: 'Bob', shiftDate: '2026-10-15', shiftStart: '2026-10-15 02:00', shiftEnd: '2026-10-15 04:00', breakMinutes: 0 }
      ];
      var night = operatingWindow_(mergeDisplay_({ operatingHoursMode: 'CUSTOM', operatingHoursStart: '18:00', operatingHoursEnd: '06:00' }));
      var rows = buildDayRows_(recs, '2026-10-15', null, { maxShiftMinutes: 960, showCarryOver: false, window: night });
      var ann = rows.filter(function (r) { return r.rec.employeeId === 'E1'; })[0];
      assert_(ann && ann.flags.indexOf('Starts next day') >= 0, 'next-day start inside the night window');
      assertEq_(headcountByHour_(rows, '2026-10-15', night.startMin, night.endMin).length, 12);
      var std = operatingWindow_(mergeDisplay_({}));
      var rows2 = buildDayRows_(recs, '2026-10-15', null, { maxShiftMinutes: 960, showCarryOver: false, window: std });
      assertEq_(rows2.length, 1);
      assert_(rows2[0].flags.indexOf('Outside operating hours') >= 0, 'flagged, still shown');
    }],
    ['Daily view: hours differ flag from stored scheduled minutes', function () {
      var rec = { recordStatus: 'ACTIVE', teamId: 'T', employeeId: 'E1', employeeName: 'Ann', shiftDate: '2026-10-15',
        shiftStart: '2026-10-15 08:00', shiftEnd: '2026-10-15 16:30', breakMinutes: 0, scheduledMinutes: 480 };
      var rows = buildDayRows_([rec], '2026-10-15', null, { maxShiftMinutes: 960, window: operatingWindow_(mergeDisplay_({ operatingHoursMode: '24_7' })) });
      assert_(rows[0].flags.indexOf('Hours differ') >= 0, 'flag');
      rec.scheduledMinutes = 510;
      rows = buildDayRows_([rec], '2026-10-15', null, { maxShiftMinutes: 960, window: operatingWindow_(mergeDisplay_({ operatingHoursMode: '24_7' })) });
      assert_(rows[0].flags.indexOf('Hours differ') < 0, 'no flag when equal');
    }],
    ['Staff: default columns are the eight required ones, without Email', function () {
      var f = normalizeStaffFields_(DEFAULT_STAFF_FIELDS);
      assertEq_(f, ['employeeId', 'employeeName', 'field:external_id_1', 'field:external_id_2', 'field:external_id_3', 'active', 'role', 'notes']);
      var reg = { external_id_1: { displayName: 'Converse ID' }, external_id_2: { displayName: 'Aircall ID' }, external_id_3: { displayName: 'AstraID' } };
      assertEq_(f.map(function (k) { return staffFieldLabel_(k, reg); }), ['Employee ID', 'Employee Name', 'Converse ID', 'Aircall ID', 'AstraID', 'Active', 'Role', 'Notes']);
    }],
    ['Staff: columns resolve by key note, so renamed fields keep their values', function () {
      var reg = { external_id_1: { displayName: 'CRM ID', fieldType: 'IDENTIFIER' } };
      var keys = resolveStaffColumns_(['Employee ID', 'Employee Name', 'Converse ID', 'Notes', 'My column'],
        ['', '', 'sm-field: field:external_id_1\n…', '', ''], reg);
      assertEq_(keys, ['employeeId', 'employeeName', 'field:external_id_1', 'notes', 'custom:My column']);
      assertEq_(resolveStaffColumns_(['CRM ID'], [''], reg), ['field:external_id_1']);
    }],
    ['Staff: alternative match key keeps leading zeros and text', function () {
      var rows = [{ employeeId: 'E1', employeeName: 'Ann Lee', active: true, fields: { 'field:external_id_1': '007' } },
        { employeeId: 'E2', employeeName: 'Bob Ray', active: true, fields: { 'field:external_id_1': 'AB-12' } }];
      var idx = buildStaffIndex_(rows, 'field:external_id_1');
      assertEq_([matchEmployee_(idx, '007', '', 'NONE').staff.employeeId, matchEmployee_(idx, '7', '', 'NONE').status,
        matchEmployee_(idx, 'ab-12', '', 'NONE').staff.employeeId], ['E1', 'UNKNOWN', 'E2']);
      var dups = findDuplicateIdentifiers_(rows.concat([{ employeeId: 'E3', employeeName: 'Cy', fields: { 'field:external_id_1': '007' } }]),
        ['employeeId', 'field:external_id_1'], ['Employee ID', 'Converse ID'], { external_id_1: { fieldType: 'IDENTIFIER' } });
      assertEq_(dups, { 'Converse ID': ['007'] });
    }],
    ['Import with an alternative match key stores the internal Employee ID', function () {
      var rows = [{ employeeId: 'E1', employeeName: 'Ann Lee', active: true, fields: { 'field:external_id_1': '0042' } }];
      var idx = buildStaffIndex_(rows, 'field:external_id_1');
      idx.matchFieldLabel = 'Converse ID';
      var p = planFromCsv_('Employee ID,Date,Start,End\n0042,2026-10-15,08:00,12:00\n9999,2026-10-15,08:00,12:00',
        { getStaffIndex: function () { return idx; } });
      var recs = p.actions.map(function (a) { return a.record; });
      assertEq_([recs[0].employeeId, recs[0].staffMatch, recs[0].extra['Source Converse ID']], ['E1', 'ID', '0042']);
      assertEq_([recs[1].employeeId, recs[1].staffMatch], ['', 'UNKNOWN']);
    }],
    ['Team import settings: defaults and normalization', function () {
      var d = normalizeTeamImport_(undefined);
      assertEq_([d.shiftTypeMode, d.matchField, d.shiftTypes], ['NOT_CONFIGURED', 'employeeId', []]);
      var n = normalizeTeamImport_({ shiftTypeMode: 'SELECTED', shiftTypes: [' Customer  Support ', 'Training', 'Training'], matchField: 'bad', duplicateStrategy: 'NOPE' });
      assertEq_([n.shiftTypes, n.knownShiftTypes, n.matchField, n.duplicateStrategy], [['Customer Support', 'Training'], ['Customer Support', 'Training'], 'employeeId', '']);
    }],
    ['Daily layout validation', function () {
      var r = newReport_(); validateDailyLayout_({ headerRow: 3, firstDataRow: 2 }, r);
      assert_(r.fatal.length > 0, 'data row must follow header row');
      var r2 = newReport_(); validateDailyLayout_({ shiftInfoColumn: 'B' }, r2);
      assert_(r2.fatal.some(function (m) { return /only once/.test(m); }), 'duplicate column letters');
      var r3 = newReport_(); validateDailyLayout_(DEFAULT_DAILY_LAYOUT, r3);
      assertEq_(r3.fatal, []);
      assertEq_([columnNumber_('A'), columnNumber_('f'), columnNumber_('AA'), columnNumber_('1')], [1, 6, 27, 0]);
    }]
  ];
}

function runUnitTests() {
  return runTestList_('Unit tests', unitTests_().concat(unitTestsV11_()));
}

/* ------------------------------------------------------------------------ */
/* Integration tests (real spreadsheet)                                      */
/* ------------------------------------------------------------------------ */

var IT_PREFIX_ = 'ZZ Test ';

function runIntegrationTests() {
  var ss = getSs_();
  var fresh = !ss.getSheetByName(T_CONFIG.sheet);
  if (!fresh && !cfgBool_(getConfig_(), 'TEST_MODE')) {
    throw new Error('Integration tests modify the spreadsheet. Run them in a copy: set _CONFIG TEST_MODE = TRUE there first.');
  }
  var ctx = { teams: {}, imports: [] };
  var tests = [
    ['1. Initialize a new spreadsheet', function () {
      var r = initializeSystem_();
      assert_(r.state.initialized && r.state.healthy, 'initialized and healthy');
      if (fresh) setConfigValues_({ TEST_MODE: 'TRUE' });
    }],
    ['2. Initialization is idempotent', function () {
      var before = ss.getSheets().length, cfgRows = readTable_(T_CONFIG).rows.length, types = listTeamTypes_(true).length;
      var r = initializeSystem_();
      assertEq_([ss.getSheets().length, readTable_(T_CONFIG).rows.length, listTeamTypes_(true).length], [before, cfgRows, types]);
      assert_(r.actions.join(' ').indexOf('Nothing was changed') >= 0 || r.actions.every(function (a) { return /Refreshed/.test(a); }), 'no structural changes: ' + r.actions.join(' | '));
    }],
    ['3. Create the first team', function () {
      var type = listTeamTypes_(false)[0];
      var r = createTeam_({ teamName: IT_PREFIX_ + 'Alpha', typeMode: 'EXISTING', teamTypeId: type.typeId, active: true, importAliases: 'ZZ-A' });
      ctx.teams.alpha = r.team;
      assertEq_(r.team.status, 'READY');
      assert_(resolveTeamSheet_(r.team, 'schedule') && resolveTeamSheet_(r.team, 'staff'), 'both sheets exist');
    }],
    ['4. Create a second team of the same type', function () {
      var r = createTeam_({ teamName: IT_PREFIX_ + 'Beta', typeMode: 'EXISTING', teamTypeId: ctx.teams.alpha.teamTypeId });
      ctx.teams.beta = r.team;
      assert_(r.team.teamId !== ctx.teams.alpha.teamId, 'distinct IDs');
    }],
    ['5. Create a team of a new type', function () {
      var r = createTeam_({ teamName: IT_PREFIX_ + 'Gamma', typeMode: 'NEW', newTypeName: IT_PREFIX_ + 'Type ' + Date.now(),
        scheduleFields: ['employeeName', 'start', 'end', 'flags'], display: { layout: 'CUSTOM' } });
      ctx.teams.gamma = r.team;
      ctx.newTypeId = r.team.teamTypeId;
      assert_(r.team.teamTypeId !== ctx.teams.alpha.teamTypeId, 'different type');
    }],
    ['6. Duplicate team names are rejected', function () {
      assertThrows_(function () { createTeam_({ teamName: (IT_PREFIX_ + 'alpha').toUpperCase(), typeMode: 'EXISTING', teamTypeId: ctx.teams.alpha.teamTypeId }); }, 'VALIDATION');
    }],
    ['7. Invalid sheet-name characters are sanitized', function () {
      var r = createTeam_({ teamName: IT_PREFIX_ + 'Delta: [Night]/Ops?', typeMode: 'EXISTING', teamTypeId: ctx.teams.alpha.teamTypeId });
      ctx.teams.delta = r.team;
      assert_(!/[\[\]\*\?\/\\:]/.test(r.team.scheduleSheet) && !/[\[\]\*\?\/\\:]/.test(r.team.staffSheet), 'no forbidden characters');
    }],
    ['8/11/12/13. Import a valid schedule (unknown employee, multi-shift, overnight)', function () {
      var staff = {};
      staff[STAFF_FIELD_DEFS.employeeId.label] = 'ZT1'; staff[STAFF_FIELD_DEFS.employeeName.label] = 'Test Ann';
      upsertStaff_(ctx.teams.alpha, staff, '');
      var csv = 'Employee ID,Employee Name,Date,Start,End,Break,Activity\n' +
        'ZT1,Test Ann,2026-10-15,08:00,12:00,0,Phone\nZT1,Test Ann,2026-10-15,13:00,17:00,15,Chat\n' +
        'ZT9,Test Unknown,2026-10-15,22:00,06:00,30,Night\nZT1,Test Ann,2026-10-16,08:00,12:00,0,Phone';
      var r = itImport_(ctx, csv, ctx.teams.alpha.teamId, 'UPDATE');
      assertEq_([r.status, r.inserted], ['COMMITTED', 4]);
      var recs = queryScheduleRecords_({ teamIds: [ctx.teams.alpha.teamId] }).filter(function (x) { return x.recordStatus === 'ACTIVE'; });
      assertEq_(recs.length, 4);
      assert_(recs.some(function (x) { return x.shiftEnd === '2026-10-16 06:00'; }), 'overnight stored');
      var view = renderTeamView_(getTeam_(ctx.teams.alpha.teamId), { date: '2026-10-15' });
      assertEq_(view.shifts, 3);
    }],
    ['9/14. Re-import with different column order changes nothing', function () {
      var csv = 'Activity,Break,End,Start,Date,Employee Name,Employee ID\n' +
        'Phone,0,12:00,08:00,2026-10-15,Test Ann,ZT1\nChat,15,17:00,13:00,2026-10-15,Test Ann,ZT1\n' +
        'Night,30,06:00,22:00,2026-10-15,Test Unknown,ZT9\nPhone,0,12:00,08:00,2026-10-16,Test Ann,ZT1';
      var r = itImport_(ctx, csv, ctx.teams.alpha.teamId, 'UPDATE');
      assertEq_([r.inserted, r.updated, r.unchanged], [0, 0, 4]);
    }],
    ['15. Update an existing schedule', function () {
      var csv = 'Employee ID,Employee Name,Date,Start,End,Break,Activity\nZT1,Test Ann,2026-10-15,13:00,17:00,30,Chat';
      var r = itImport_(ctx, csv, ctx.teams.alpha.teamId, 'UPDATE');
      assertEq_(r.updated, 1);
    }],
    ['16/17. Replace within range keeps records outside the range', function () {
      var csv = 'Employee ID,Employee Name,Date,Start,End,Break,Activity\nZT1,Test Ann,2026-10-15,08:00,12:00,0,Phone';
      var r = itImport_(ctx, csv, ctx.teams.alpha.teamId, 'REPLACE_RANGE');
      assertEq_(r.removed, 2);
      var active = queryScheduleRecords_({ teamIds: [ctx.teams.alpha.teamId] }).filter(function (x) { return x.recordStatus === 'ACTIVE'; });
      assertEq_(active.map(function (x) { return x.shiftDate; }).sort(), ['2026-10-15', '2026-10-16']);
    }],
    ['Undo restores the replaced records', function () {
      var u = undoImport_(ctx.imports[ctx.imports.length - 1]);
      assertEq_(u.restored, 2);
      var active = queryScheduleRecords_({ teamIds: [ctx.teams.alpha.teamId] }).filter(function (x) { return x.recordStatus === 'ACTIVE'; });
      assertEq_(active.length, 4);
    }],
    ['10/19/20. Invalid imports never write data', function () {
      var before = readAllScheduleRecords_().records.length;
      var bad = 'Employee ID,Date,Start\nZT1,2026-10-15,08:00';
      assertThrows_(function () { itImport_(ctx, bad, ctx.teams.alpha.teamId, 'UPDATE'); }, 'BLOCKED');
      var malformed = 'Employee ID,Date,Start,End\nZT1,2026-02-30,08:00,12:00\nZT1,2026-10-17,25:00,12:00';
      assertThrows_(function () { itImport_(ctx, malformed, ctx.teams.alpha.teamId, 'UPDATE'); }, 'BLOCKED');
      assertEq_(readAllScheduleRecords_().records.length, before, 'no rows written');
    }],
    ['Stale preview token is refused', function () {
      var csv = 'Employee ID,Date,Start,End\nZT1,2026-10-20,08:00,12:00';
      var r = itImport_(ctx, csv, ctx.teams.alpha.teamId, 'UPDATE', 'stale-token');
      assertEq_(r.status, 'PLAN_CHANGED');
    }],
    ['v1.1 #1–3: standard, 24/7 and custom operating hours persist and render', function () {
      var type = ctx.teams.alpha.teamTypeId;
      var t247 = createTeam_({ teamName: IT_PREFIX_ + '24-7', typeMode: 'EXISTING', teamTypeId: type, display: { operatingHoursMode: '24_7' } }).team;
      var tNight = createTeam_({ teamName: IT_PREFIX_ + 'Night', typeMode: 'EXISTING', teamTypeId: type,
        display: { operatingHoursMode: 'CUSTOM', operatingHoursStart: '18:00', operatingHoursEnd: '06:00' } }).team;
      ctx.teams.t247 = t247; ctx.teams.night = tNight;
      assertEq_(getTeam_(t247.teamId).settings.display.operatingHoursMode, '24_7');
      assertEq_(operatingWindow_(getTeam_(tNight.teamId).settings.display).label, '18:00–06:00 (+1)');
      assertEq_(operatingWindow_(getTeam_(ctx.teams.alpha.teamId).settings.display).fullDay, false);
      var sh = resolveTeamSheet_(getTeam_(t247.teamId), 'schedule');
      assertEq_(sh.getRange(VIEW.INFO_ROW, 9).getValue(), '24/7');
    }],
    ['v1.1 #5: editing one setting preserves all others', function () {
      var t = getTeam_(ctx.teams.night.teamId);
      var before = stableStringify_(t.settings.import) + stableStringify_(t.settings.display) + t.importAliases;
      updateTeam_(t.teamId, { teamName: t.teamName, description: 'changed only this' });
      var after = getTeam_(t.teamId);
      assertEq_(stableStringify_(after.settings.import) + stableStringify_(after.settings.display) + after.importAliases, before);
      assertEq_(after.description, 'changed only this');
    }],
    ['v1.1 #28–29: migration of a v1.0 team is backward compatible and idempotent', function () {
      var t = readTable_(T_TEAMS).rows.filter(function (r) { return str_(r.teamId) === ctx.teams.beta.teamId; })[0];
      var legacy = JSON.parse(JSON.stringify(t.settings));
      delete legacy.import;
      legacy.display = { workdayStart: '07:00', workdayEnd: '19:00', showBreaks: true };
      t.settings = legacy;
      updateObject_(T_TEAMS, t);
      var msgs = migrateTeamsV11_();
      assert_(msgs.some(function (m) { return m.indexOf(IT_PREFIX_ + 'Beta') >= 0; }), 'migrated');
      var b = getTeam_(ctx.teams.beta.teamId);
      assertEq_([b.settings.display.operatingHoursMode, b.settings.display.operatingHoursStart, b.settings.display.operatingHoursEnd, b.settings.import.scheduleType],
        ['STANDARD', '07:00', '19:00', 'TABLE']);
      assertEq_(migrateTeamsV11_().filter(function (m) { return m.indexOf(IT_PREFIX_) >= 0; }), [], 'second run changes nothing');
    }],
    ['v1.1 #6–10: default staff columns; renaming an identifier keeps values; leading zeros kept', function () {
      var team = getTeam_(ctx.teams.t247.teamId);
      var st = readStaff_(team);
      assert_(st.keys.indexOf('email') < 0, 'no Email column');
      ['field:external_id_1', 'field:external_id_2', 'field:external_id_3', 'role', 'notes', 'active'].forEach(function (k) { assert_(st.keys.indexOf(k) >= 0, 'has ' + k); });
      var reg = getStaffFieldMap_();
      var v = {};
      v['Employee ID'] = 'ZT100'; v['Employee Name'] = 'Test Zero'; v[reg.external_id_1.displayName] = '000123';
      upsertStaff_(team, v, '');
      var oldName = reg.external_id_1.displayName;
      saveStaffField_({ fieldKey: 'external_id_1', displayName: IT_PREFIX_ + 'CRM', fieldType: 'IDENTIFIER' });
      relayoutAllStaffSheets_();
      var st2 = readStaff_(team);
      var row = st2.rows.filter(function (r) { return r.employeeId === 'ZT100'; })[0];
      assertEq_([row.fields['field:external_id_1'], st2.header[st2.keys.indexOf('field:external_id_1')]], ['000123', IT_PREFIX_ + 'CRM']);
      saveStaffField_({ fieldKey: 'external_id_1', displayName: oldName, fieldType: 'IDENTIFIER' });
      relayoutAllStaffSheets_();
      assertEq_(readStaff_(team).rows.filter(function (r) { return r.employeeId === 'ZT100'; })[0].fields['field:external_id_1'], '000123');
      var dup = {}; dup['Employee ID'] = 'ZT101'; dup['Employee Name'] = 'Test Dup'; dup[oldName] = '000123';
      assertThrows_(function () { upsertStaff_(team, dup, ''); }, 'VALIDATION');
    }],
    ['v1.1 #13–27: Daily Schedule import with shift-type filtering, end to end', function () {
      var team = getTeam_(ctx.teams.t247.teamId);
      var raw = dailyFixture_();
      raw[0][0] = 'Daily schedule 2026-11-03';
      var importId = newId_('IMP');
      ctx.imports.push(importId);
      stageTable_(importId, { meta: { fileName: 'daily-test.xlsx', format: 'XLSX', fileHash: 'x', warnings: [] }, table: raw });
      var insp = inspectTable_(raw, { profileId: 'AUTO' }, getConfig_());
      assertEq_([insp.format, insp.scheduleDate, insp.shiftTypes.length], ['QUINYX_DAILY', '2026-11-03', 2]);
      var req = { importId: importId, format: 'QUINYX_DAILY', profileId: insp.profileId, layout: insp.layout, scheduleDate: insp.scheduleDate,
        teamMode: 'EXPLICIT', teamId: team.teamId, strategy: 'UPDATE', allowPartial: false, headerRow: 1, options: {} };
      var blocked = analyzeStaged_(req).plan;
      assert_(!blocked.canCommit, 'team without a selection must choose first');
      req.shiftTypeOverride = { teamId: team.teamId, mode: 'SELECTED', types: ['Customer Support'] };
      req.saveShiftTypes = true;
      req.token = analyzeStaged_(req).plan.token;
      var r = commitImport_(req);
      assertEq_([r.status, r.inserted, r.excluded, r.scheduleDate], ['COMMITTED', 2, 1, '2026-11-03']);
      var t2 = getTeam_(team.teamId);
      assertEq_([t2.settings.import.shiftTypeMode, t2.settings.import.shiftTypes], ['SELECTED', ['Customer Support']]);
      var recs = queryScheduleRecords_({ teamIds: [team.teamId], dates: ['2026-11-03'] });
      assertEq_(recs.map(function (x) { return x.shiftType; }), ['Customer Support', 'Customer Support']);
      var importId2 = newId_('IMP');
      ctx.imports.push(importId2);
      stageTable_(importId2, { meta: { fileName: 'daily-test.xlsx', format: 'XLSX', fileHash: 'x', warnings: [] }, table: raw });
      var req2 = JSON.parse(JSON.stringify(req)); req2.importId = importId2; delete req2.shiftTypeOverride; req2.saveShiftTypes = false;
      req2.token = analyzeStaged_(req2).plan.token;
      var r2 = commitImport_(req2);
      assertEq_([r2.inserted, r2.unchanged], [0, 2]);
      var view = renderTeamView_(t2, { date: '2026-11-03' });
      assertEq_(view.shifts, 2);
    }],
    ['18. Recover from a missing team worksheet', function () {
      var team = getTeam_(ctx.teams.beta.teamId);
      ss.deleteSheet(resolveTeamSheet_(team, 'schedule'));
      assert_(validateStructure_().fatal.length > 0, 'structure validation reports it');
      rebuildMissingSheets_();
      assert_(resolveTeamSheet_(getTeam_(ctx.teams.beta.teamId), 'schedule'), 'sheet recreated');
    }]
  ];
  var result;
  try {
    result = runTestList_('Integration tests', tests);
  } finally {
    itCleanup_(ctx);
  }
  return result;
}

/** Stages CSV text, analyses it and commits it (as the dialog does). */
function itImport_(ctx, csv, teamId, strategy, forceToken) {
  var table = trimTable_(parseCsv_(csv, ','));
  var importId = newId_('IMP');
  stageTable_(importId, { meta: { fileName: 'integration-test.csv', format: 'CSV', fileHash: hash64_(csv), warnings: [] }, table: table });
  var insp = inspectTable_(table, { profileId: 'NONE', headerRow: 0 }, getConfig_());
  var req = { importId: importId, headerRow: insp.headerRow, fieldMap: insp.fieldMap, options: { dateOrder: 'AUTO', breakUnit: 'MINUTES' },
    profileId: '', teamMode: 'EXPLICIT', teamId: teamId, strategy: strategy, allowPartial: false };
  var a = analyzeStaged_(req);
  req.token = forceToken || a.plan.token;
  ctx.imports.push(importId);
  var r = commitImport_(req);
  return r;
}

function itCleanup_(ctx) {
  try {
    var ids = Object.keys(ctx.teams).map(function (k) { return ctx.teams[k].teamId; });
    listTeams_().forEach(function (t) { if (ids.indexOf(t.teamId) >= 0) deleteTeam_(t.teamId, t.teamName, true); });
    var t = readTable_(T_SCHEDULE);
    var keep = t.values.slice(1).filter(function (row) { return !row.every(isBlank_) && ids.indexOf(str_(row[t.idx.teamId])) < 0; });
    replaceAllRows_(t.sheet, T_SCHEDULE, t.header, keep, t.lastRow);
    [T_IMPORT_LOG, T_CHANGES, T_STAGING].forEach(function (def) {
      var tt = readTable_(def);
      var rows = tt.values.slice(1).filter(function (row) { return !row.every(isBlank_) && ctx.imports.indexOf(str_(row[tt.idx.importId])) < 0; });
      replaceAllRows_(tt.sheet, def, tt.header, rows, tt.lastRow);
    });
    if (ctx.newTypeId) {
      var type = getTeamType_(ctx.newTypeId);
      if (type) deleteSheetRows_(requireSheet_(T_TEAM_TYPES.sheet), [type._row]);
    }
    rebuildSheetIndex_();
    rebuildDashboardSafe_();
    console.log('Integration test data cleaned up.');
  } catch (e) {
    logError_('itCleanup_', e);
    console.log('Cleanup failed — remove "' + IT_PREFIX_ + '" teams manually.');
  }
}
