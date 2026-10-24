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
  'Employee ID,Employee Name,Date,Start Time,End Time,Activity',
  'E1,Ann Lee,2026-10-15,08:00,16:30,Phone',
  'E2,Bob Ray,2026-10-15,09:00,17:00,Chat'
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
    table: table, headerRow: 0, fieldMap: auto.fieldMap, options: { dateOrder: 'AUTO' },
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
    ['Normalize: basic shift', function () {
      var r = normalizeRow_(['E1', 'Ann', '2026-10-15', '08:00', '16:30'], ['id', 'n', 'd', 's', 'e'],
        { employeeId: 0, employeeName: 1, date: 2, start: 3, end: 4 },
        { dateOrder: 'DMY', maxShiftMinutes: 960, minShiftMinutes: 15 });
      assertEq_(r.errors, []);
      assertEq_([r.shiftStart, r.shiftEnd, r.grossMinutes], ['2026-10-15 08:00', '2026-10-15 16:30', 510]);
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
      var csv2 = ['Activity,End Time,Start Time,Date,Employee Name,Employee ID',
        'Phone,16:30,08:00,2026-10-15,Ann Lee,E1', 'Chat,17:00,09:00,2026-10-15,Bob Ray,E2'].join('\n');
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
      var again = planFromCsv_(CSV_BASIC_ + '\nE1,Ann Lee,2026-10-15,08:00,16:30,Phone', { existing: stored });
      assertEq_([again.actions.length, again.summary.unchanged, again.summary.duplicatesInFile], [0, 2, 1]);
    }],
    ['Plan: conflicting copies of one shift in the file are rejected', function () {
      var p = planFromCsv_('Shift ID,Employee ID,Date,Start,End\n77,E1,2026-10-15,08:00,12:00\n77,E1,2026-10-15,09:00,12:00');
      assertEq_([p.summary.insert, p.summary.rejectedRows], [1, 1]);
    }],
    ['Plan: changed shift with SKIP, UPDATE and ASK strategies', function () {
      var stored = applyPlanInMemory_([], planFromCsv_(CSV_BASIC_), 'IMP_1');
      var changed = CSV_BASIC_.replace('E1,Ann Lee,', 'E1,Ann Lee-Smith,');
      var skip = planFromCsv_(changed, { existing: stored, strategy: 'SKIP' });
      var upd = planFromCsv_(changed, { existing: stored, strategy: 'UPDATE' });
      var ask = planFromCsv_(changed, { existing: stored, strategy: 'ASK' });
      assertEq_([skip.summary.skippedExisting, skip.actions.length], [1, 0]);
      assertEq_([upd.summary.update, upd.actions[0].type, upd.actions[0].record.employeeName], [1, 'UPDATE', 'Ann Lee-Smith']);
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
        { recordStatus: 'ACTIVE', teamId: 'T', employeeId: 'E1', employeeName: 'Ann', shiftDate: '2026-10-14', shiftStart: '2026-10-14 22:00', shiftEnd: '2026-10-15 07:00' },
        { recordStatus: 'ACTIVE', teamId: 'T', employeeId: 'E2', employeeName: 'Bob', shiftDate: '2026-10-15', shiftStart: '2026-10-15 05:00', shiftEnd: '2026-10-15 09:00' },
        { recordStatus: 'REMOVED', teamId: 'T', employeeId: 'E3', employeeName: 'Cy', shiftDate: '2026-10-15', shiftStart: '2026-10-15 05:00', shiftEnd: '2026-10-15 09:00' }
      ];
      var rows = buildDayRows_(recs, '2026-10-15', null, { maxShiftMinutes: 960, nameStrategy: 'NONE', showCarryOver: true });
      assertEq_(rows.length, 2);
      assert_(rows[0].flags.indexOf('From previous day') >= 0 && rows[0].flags.indexOf('Overnight') >= 0, 'carry-over flags');
      var hc = headcountByHour_(rows, '2026-10-15', 300, 420);
      assertEq_(hc.map(function (h) { return h.count; }), [2, 2]);
    }]
  ];
}

/* ------------------- unit tests: Daily Schedule and shift types ------------------- */

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
        { recordStatus: 'ACTIVE', teamId: 'T', employeeId: 'E1', employeeName: 'Ann', shiftDate: '2026-10-14', shiftStart: '2026-10-14 22:00', shiftEnd: '2026-10-15 06:00' },
        { recordStatus: 'ACTIVE', teamId: 'T', employeeId: 'E2', employeeName: 'Bob', shiftDate: '2026-10-15', shiftStart: '2026-10-15 00:30', shiftEnd: '2026-10-15 08:00' },
        { recordStatus: 'ACTIVE', teamId: 'T', employeeId: 'E3', employeeName: 'Cy', shiftDate: '2026-10-15', shiftStart: '2026-10-15 23:00', shiftEnd: '2026-10-16 07:00' }
      ];
      var w = operatingWindow_(mergeDisplay_({ operatingHoursMode: '24_7' }));
      var rows = buildDayRows_(recs, '2026-10-15', null, { maxShiftMinutes: 960, nameStrategy: 'NONE', showCarryOver: false, window: w });
      assertEq_(rows.length, 3);
      var hc = headcountByHour_(rows, '2026-10-15', w.startMin, w.endMin);
      assertEq_([hc.length, hc[0].label, hc[0].count, hc[23].label, hc[23].count], [24, '00:00–01:00', 2, '23:00–24:00', 1]);
    }],
    ['Daily view: custom night window includes next-day starts; standard flags outside hours', function () {
      var recs = [
        { recordStatus: 'ACTIVE', teamId: 'T', employeeId: 'E1', employeeName: 'Ann', shiftDate: '2026-10-16', shiftStart: '2026-10-16 02:00', shiftEnd: '2026-10-16 06:00' },
        { recordStatus: 'ACTIVE', teamId: 'T', employeeId: 'E2', employeeName: 'Bob', shiftDate: '2026-10-15', shiftStart: '2026-10-15 02:00', shiftEnd: '2026-10-15 04:00' }
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
        shiftStart: '2026-10-15 08:00', shiftEnd: '2026-10-15 16:30', scheduledMinutes: 480 };
      var rows = buildDayRows_([rec], '2026-10-15', null, { maxShiftMinutes: 960, window: operatingWindow_(mergeDisplay_({ operatingHoursMode: '24_7' })) });
      assert_(rows[0].flags.indexOf('Hours differ') >= 0, 'flag');
      rec.scheduledMinutes = 510;
      rows = buildDayRows_([rec], '2026-10-15', null, { maxShiftMinutes: 960, window: operatingWindow_(mergeDisplay_({ operatingHoursMode: '24_7' })) });
      assert_(rows[0].flags.indexOf('Hours differ') < 0, 'no flag when equal');
    }],
    ['Staff: default columns are exactly Employee ID, Name, Role, Notes (Active is retired)', function () {
      var f = normalizeStaffFields_(DEFAULT_STAFF_FIELDS);
      assertEq_(f.map(function (k) { return staffFieldLabel_(k, {}); }), ['Employee ID', 'Employee Name', 'Role', 'Notes']);
      assertEq_(normalizeStaffFields_(['employeeId', 'employeeName', 'active', 'role']), ['employeeId', 'employeeName', 'role'], 'a stored Active field is dropped');
      assert_(f.every(function (k) { return k.indexOf('field:') < 0; }) && f.indexOf('email') < 0, 'no identifier fields and no Email by default');
      assertEq_(SEED_STAFF_FIELDS_, [], 'no identifier fields are seeded');
    }],
    ['Staff: columns resolve by key note, so renamed fields keep their values', function () {
      var reg = { external_id_1: { displayName: 'CRM ID', fieldType: 'IDENTIFIER' } };
      var keys = resolveStaffColumns_(['Employee ID', 'Employee Name', 'Platform ID', 'Notes', 'My column'],
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
        ['employeeId', 'field:external_id_1'], ['Employee ID', 'Platform ID'], { external_id_1: { fieldType: 'IDENTIFIER' } });
      assertEq_(dups, { 'Platform ID': ['007'] });
    }],
    ['Import with an alternative match key stores the internal Employee ID', function () {
      var rows = [{ employeeId: 'E1', employeeName: 'Ann Lee', active: true, fields: { 'field:external_id_1': '0042' } }];
      var idx = buildStaffIndex_(rows, 'field:external_id_1');
      idx.matchFieldLabel = 'Platform ID';
      var p = planFromCsv_('Employee ID,Date,Start,End\n0042,2026-10-15,08:00,12:00\n9999,2026-10-15,08:00,12:00',
        { getStaffIndex: function () { return idx; } });
      var recs = p.actions.map(function (a) { return a.record; });
      assertEq_([recs[0].employeeId, recs[0].staffMatch, recs[0].extra['Source Platform ID']], ['E1', 'ID', '0042']);
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

/* ------------------------ unit tests: meetings and routing ------------------------ */

/** Daily Schedule fixture with one shift and meetings before, during, during and after it. */
function meetingFixture_() {
  return [
    ['Daily schedule 2026-10-15', '', '', '', '', ''],
    ['SHIFT TYPE', 'Employee Name', 'Shift', 'D', 'E', 'Hours'],
    ['Customer Support', 'Ann Lee', '08:00 - 16:00', '', '', '8'],
    ['Meeting', 'Ann Lee', '07:30 - 08:00', '', '', '0.5'],
    ['Meeting', 'Ann Lee', '10:00 - 10:30', '', '', '0.5'],
    ['Meeting', 'Ann Lee', '15:00 - 15:30', '', '', '0.5'],
    ['Meeting', 'Ann Lee', '16:00 - 16:30', '', '', '0.5'],
    ['Customer Support', 'Bob Ray', '09:00 - 17:00', '', '', '8']
  ];
}

function itemsOf_(recs) {
  return recs.map(function (r) { return { rec: r, startMin: wallMinutes_(r.shiftStart), endMin: wallMinutes_(r.shiftEnd) }; });
}

function unitTestsV111_() {
  var MEET_ON = { mode: 'SELECTED', types: ['Customer Support'], known: ['Customer Support', 'Meeting'], importMeetings: true, meetingTypes: ['Meeting'] };
  var MEET_OFF = { mode: 'SELECTED', types: ['Customer Support'], known: ['Customer Support', 'Meeting'], importMeetings: false, meetingTypes: ['Meeting'] };
  return [
    ['Meetings: one shift plus meetings before, during and after are separate assignments', function () {
      var p = planFromDaily_(meetingFixture_(), MEET_ON);
      assertEq_(p.report.fatal, []);
      assertEq_([p.summary.normalShifts, p.summary.meetingsDetected, p.summary.meetingsImported, p.summary.meetingsExcluded], [2, 4, 4, 0]);
      var ann = p.actions.filter(function (a) { return a.record.employeeName === 'Ann Lee'; }).map(function (a) { return a.record; });
      assertEq_(ann.length, 5);
      assertEq_(ann.filter(function (r) { return r.activityCategory === 'MEETING'; }).length, 4);
      assertEq_(uniq_(p.actions.map(function (a) { return a.key; })).length, p.actions.length, 'distinct keys');
      assertEq_([p.summary.meetingsInShift, p.summary.overlapsCount], [4, 0], 'the shift grows to 07:30–16:30 (meetings touching it are part of it); all four meetings are inside, no conflicts');
    }],
    ['Meetings: disabled → excluded and reported, shifts unchanged', function () {
      var p = planFromDaily_(meetingFixture_(), MEET_OFF);
      assertEq_([p.summary.meetingsDetected, p.summary.meetingsExcluded, p.summary.meetingsImported, p.summary.normalShifts], [4, 4, 0, 2]);
      assert_(p.actions.every(function (a) { return a.record.activityCategory === 'SHIFT'; }), 'no meetings written');
      assert_(p.canCommit, 'excluded meetings do not block');
    }],
    ['Meetings: repeated import creates no duplicate meetings', function () {
      var stored = applyPlanInMemory_([], planFromDaily_(meetingFixture_(), MEET_ON), 'IMP_1');
      var again = planFromDaily_(meetingFixture_(), MEET_ON, { existing: stored });
      assertEq_([again.actions.length, again.summary.unchanged], [0, 6]);
    }],
    ['Meetings: working hours do not double-count meetings inside the shift', function () {
      var p = planFromDaily_(meetingFixture_(), MEET_ON);
      var ann = p.actions.map(function (a) { return a.record; }).filter(function (r) { return r.employeeName === 'Ann Lee'; });
      var work = workMinutesByEmployee_(itemsOf_(ann));
      var only = Object.keys(work).map(function (k) { return work[k]; })[0];
      assertEq_(only, 480 + 30 + 30, 'shift 8h + 30 min before + 30 min after; the two meetings inside add nothing');
    }],
    ['Overlaps: two meetings overlapping each other, or a meeting partly outside a shift, are conflicts', function () {
      var mk = function (s, e, cat) { return { employeeId: 'E1', teamId: 'T', shiftStart: '2026-10-15 ' + s, shiftEnd: '2026-10-15 ' + e, activityCategory: cat }; };
      assertEq_(findConflicts_(itemsOf_([mk('08:00', '16:00', 'SHIFT'), mk('10:00', '11:00', 'MEETING'), mk('10:30', '11:30', 'MEETING')])).length, 1);
      assertEq_(findConflicts_(itemsOf_([mk('08:00', '16:00', 'SHIFT'), mk('15:30', '16:30', 'MEETING')])).length, 1);
      assertEq_(findConflicts_(itemsOf_([mk('08:00', '16:00', 'SHIFT'), mk('12:00', '20:00', 'SHIFT')])).length, 1);
      assertEq_(findConflicts_(itemsOf_([mk('08:00', '16:00', 'SHIFT'), mk('09:00', '10:00', 'MEETING')])).length, 0);
    }]
  ];
}

function unitTestsV112_() {
  return [
    ['Version 2.0.0: spreadsheets of every 1.x version run the upgrade once; the current one does not', function () {
      assertEq_(APP.VERSION, '2.0.0');
      assertEq_(versionNeedsUpgrade_('2.0.0'), false);
      assertEq_([versionNeedsUpgrade_('1.1.3'), versionNeedsUpgrade_('1.1.0'), versionNeedsUpgrade_('1.0.0'), versionNeedsUpgrade_(''), versionNeedsUpgrade_(undefined)],
        [true, true, true, true, true]);
    }]
  ];
}

/* ------------- staff-sheet routing and held-back employees (unit) ------------- */

function unitTestsStaffRouting_() {
  var heldKeys = function (p) { return p.summary.heldPeople.map(function (h) { return h.employeeName + ':' + h.reason; }); };
  var teamsOf = function (p) { return p.actions.map(function (a) { return a.record.employeeName + '>' + a.teamId; }).sort(); };
  var csv = 'Employee Name,Date,Start,End\nann  lee,2026-10-15,08:00,16:00\nDee Fox,2026-10-15,09:00,17:00\nZed New,2026-10-15,10:00,18:00';
  return [
    ['All teams: each row goes to the team whose staff sheet lists the person; others are held back', function () {
      var p = planFromCsv_(csv, { teamMode: 'STAFF', teamId: '' });
      assertEq_(teamsOf(p), ['Dee Fox>TEAM_002', 'ann lee>TEAM_001'], 'matched by name, ignoring case and spaces');
      assertEq_(heldKeys(p), ['Zed New:NOT_IN_STAFF']);
      assertEq_([p.summary.heldPeople[0].candidates.length, p.canCommit], [2, false], 'any team can be chosen; held people block the import');
    }],
    ['All teams: a decision imports or skips every row of the held person', function () {
      var key = 'NM:' + normName_('Zed New');
      var imp = planFromCsv_(csv, { teamMode: 'STAFF', teamId: '', decisions: (function () { var d = {}; d[key] = 'TEAM_002'; return d; })() });
      assertEq_([imp.summary.insert, imp.summary.heldPeople.length, imp.summary.unknownEmployeeCount, imp.canCommit], [3, 0, 1, true]);
      var skip = planFromCsv_(csv, { teamMode: 'STAFF', teamId: '', decisions: (function () { var d = {}; d[key] = 'SKIP'; return d; })() });
      assertEq_([skip.summary.insert, skip.summary.skippedByDecision, skip.canCommit], [2, 1, true]);
      assert_(imp.token !== skip.token, 'decisions are part of the plan token');
    }],
    ['All teams: a person in two staff sheets is never guessed', function () {
      var staff = testStaff_();
      staff.TEAM_002 = buildStaffIndex_([{ employeeId: 'E1', employeeName: 'Ann Lee', active: true }]);
      var p = planFromCsv_(csv, { teamMode: 'STAFF', teamId: '', getStaffIndex: function (id) { return staff[id] || null; } });
      var ann = p.summary.heldPeople.filter(function (h) { return h.reason === 'IN_SEVERAL'; })[0];
      assertEq_(ann && ann.candidates.map(function (c) { return c.teamId; }), ['TEAM_001', 'TEAM_002']);
      assert_(!p.actions.some(function (a) { return /ann/i.test(a.record.employeeName); }), 'no row imported for Ann');
    }],
    ['One team: people missing from its staff sheet are held back only when review is asked for', function () {
      var one = 'Employee ID,Employee Name,Date,Start,End\nE1,Ann Lee,2026-10-15,08:00,16:00\nE9,Zed New,2026-10-15,09:00,17:00';
      var held = planFromCsv_(one, { reviewUnknown: true });
      assertEq_([held.summary.insert, heldKeys(held), held.canCommit], [1, ['Zed New:NOT_IN_TEAM'], false]);
      var go = planFromCsv_(one, { reviewUnknown: true, decisions: { 'ID:E9': 'TEAM_001' } });
      assertEq_([go.summary.insert, go.canCommit], [2, true]);
      assertEq_(planFromCsv_(one).summary.insert, 2, 'without review, unknown employees are imported and flagged (API behaviour)');
    }],
    ['One team: a held person found in another staff sheet is suggested and can be sent to that team', function () {
      var csv2 = 'Employee ID,Employee Name,Date,Start,End\nE1,Ann Lee,2026-10-15,08:00,16:00\nE7,Dee Fox,2026-10-15,09:00,17:00';
      var held = planFromCsv_(csv2, { reviewUnknown: true });
      var dee = held.summary.heldPeople[0];
      assertEq_([dee.employeeName, dee.foundIn, dee.candidates.map(function (c) { return c.teamId; })], ['Dee Fox', ['TEAM_002'], ['TEAM_001', 'TEAM_002']]);
      var moved = planFromCsv_(csv2, { reviewUnknown: true, decisions: { 'ID:E7': 'TEAM_002' } });
      assertEq_([teamsOf(moved), moved.canCommit], [['Ann Lee>TEAM_001', 'Dee Fox>TEAM_002'], true]);
      assertEq_(moved.summary.unknownEmployeeCount, 0, 'Dee is in TEAM_002\'s staff sheet, so not flagged there');
    }]
  ];
}

function unitTestsThemes_() {
  return [
    ['Themes: every theme has a label, a font and a complete sheet palette; UI_THEME accepts only known themes', function () {
      assert_(THEMES.DEFAULT && THEMES.DEFAULT.file === '', 'the default theme needs no file');
      Object.keys(THEMES).forEach(function (k) {
        var s = THEMES[k].sheet;
        assert_(THEMES[k].label && s && s.font, k + ' has a label and a font');
        ['header', 'headerText', 'accent', 'band', 'soft', 'warn', 'error'].forEach(function (c) {
          assert_(/^#[0-9a-f]{6}$/i.test(s[c]), k + '.' + c + ' is a hex color');
        });
      });
      assertEq_(sheetTheme_({ UI_THEME: 'EMBER' }).accent, '#eb1700');
      assertEq_(sheetTheme_({ UI_THEME: 'GONE' }), THEMES.DEFAULT.sheet, 'an unknown theme falls back to the default');
      assertEq_(validateConfigUpdates_({ UI_THEME: 'SKY' }).fatal, []);
      assertEq_(validateConfigUpdates_({ UI_THEME: 'NEON' }).fatal.length, 1);
    }]
  ];
}

function unitTestsSplitShifts_() {
  var day = [
    ['Daily schedule 2026-10-15', '', '', '', '', ''],
    ['SHIFT TYPE', 'Employee Name', 'Shift', 'D', 'E', 'Hours'],
    ['Customer Support', 'Ann Lee', '08:00 - 15:00', '', '', '7'],
    ['Training', 'Ann Lee', '15:00 - 16:00', '', '', '1'],
    ['Customer Support', 'Ann Lee', '16:00 - 16:20', '', '', '0:20'],
    ['Customer Support', 'Bob Ray', '08:00 - 12:00', '', '', '4'],
    ['Customer Support', 'Bob Ray', '12:30 - 16:00', '', '', '3.5'],
    ['Customer Support', 'Zed New', '08:00 - 10:00', '', '', '2'],
    ['Training', 'Zed New', '10:00 - 11:00', '', '', '1'],
    ['Customer Support', 'Zed New', '11:00 - 12:00', '', '', '1']
  ];
  var filter = function (importMeetings) {
    return { mode: 'SELECTED', types: ['Customer Support'], known: ['Customer Support', 'Training'], importMeetings: importMeetings, meetingTypes: ['Training'] };
  };
  var shifts = function (p) {
    return p.actions.filter(function (a) { return a.record.activityCategory !== 'MEETING'; })
      .map(function (a) { return a.record.employeeName + ' ' + a.record.shiftStart.substr(11) + '-' + a.record.shiftEnd.substr(11); }).sort();
  };
  return [
    ['Split shifts: pieces around a meeting/training become the person\'s whole shift; the training stays its own row', function () {
      var p = planFromDaily_(day, filter(true));
      assertEq_(p.report.fatal, []);
      assertEq_(shifts(p), ['Ann Lee 08:00-16:20', 'Bob Ray 08:00-12:00', 'Bob Ray 12:30-16:00', 'Zed New 08:00-12:00'],
        'Ann joined; Bob\'s gap has no meeting; Zed is joined too although not in the staff sheet');
      var ann = p.actions.filter(function (a) { return a.record.employeeName === 'Ann Lee' && a.record.activityCategory !== 'MEETING'; })[0].record;
      assertEq_([ann.grossMinutes, ann.scheduledMinutes], [500, 500], '8h 20m, and the scheduled hours include the training');
      assert_(p.actions.some(function (a) { return a.record.activityCategory === 'MEETING' && a.record.shiftStart.substr(11) === '15:00'; }), 'training imported separately');
      assertEq_(p.summary.joinedPieces, 2, 'one piece each for Ann and Zed');
    }],
    ['Split shifts: pieces are joined even when the training itself is not imported; re-import changes nothing', function () {
      var off = planFromDaily_(day, filter(false));
      assert_(shifts(off).indexOf('Ann Lee 08:00-16:20') >= 0, 'joined without importing the training');
      var stored = applyPlanInMemory_([], planFromDaily_(day, filter(true)), 'IMP_1');
      var again = planFromDaily_(day, filter(true), { existing: stored });
      assertEq_([again.actions.length, again.summary.joinedPieces], [0, 2]);
    }],
    ['Split shifts: a training cut from the end (or start) of a shift is part of the shift', function () {
      var edge = [
        ['Daily schedule 2026-10-15', '', '', '', '', ''],
        ['SHIFT TYPE', 'Employee Name', 'Shift', 'D', 'E', 'Hours'],
        ['Customer Support', 'Ann Lee', '09:00 - 14:15', '', '', '5:15'],
        ['Training', 'Ann Lee', '14:15 - 15:00', '', '', '0:45'],
        ['Training', 'Bob Ray', '07:30 - 08:00', '', '', '0:30'],
        ['Customer Support', 'Bob Ray', '08:00 - 12:00', '', '', '4'],
        ['Training', 'Bob Ray', '13:00 - 14:00', '', '', '1']
      ];
      var p = planFromDaily_(edge, filter(true));
      assertEq_(shifts(p), ['Ann Lee 09:00-15:00', 'Bob Ray 07:30-12:00'], 'a training not touching the shift (Bob 13:00) stays separate');
      var ann = p.actions.filter(function (a) { return a.record.employeeName === 'Ann Lee' && a.record.activityCategory !== 'MEETING'; })[0].record;
      assertEq_([ann.grossMinutes, ann.scheduledMinutes], [360, 360]);
      assertEq_(p.actions.filter(function (a) { return a.record.activityCategory === 'MEETING'; }).length, 3, 'every training is still its own row');
      assertEq_(p.summary.extendedShifts, 2);
    }],
    ['Split shifts: a piece of a shift type that is not imported still counts toward the shift; a nameless training belongs to the row above', function () {
      var mixed = [
        ['Daily schedule 2026-10-15', '', '', '', '', ''],
        ['SHIFT TYPE', 'Employee Name', 'Shift', 'D', 'E', 'Hours'],
        ['Customer Support', 'Ann Lee', '08:40 - 13:00', '', '', '4:20'],
        ['Training', '-', '13:00 - 13:30', '', '', '0:30'],
        ['Other Support', 'Ann Lee', '13:30 - 17:00', '', '', '3:30'],
        ['Other Support', 'Bob Ray', '08:00 - 12:00', '', '', '4']
      ];
      var p = planFromDaily_(mixed, filter(true));
      assertEq_(p.report.fatal, []);
      assertEq_(shifts(p), ['Ann Lee 08:40-17:00'], 'Ann\'s whole working time; Bob only has the excluded type');
      var tr = p.actions.filter(function (a) { return a.record.activityCategory === 'MEETING'; });
      assertEq_(tr.map(function (a) { return a.record.employeeName + ' ' + a.record.shiftStart.substr(11); }), ['Ann Lee 13:00']);
    }],
    ['Split shifts: pieces stored by an earlier import are replaced by the whole shift', function () {
      var old = [
        { recordKey: 'OLD1', teamId: 'TEAM_001', employeeId: 'E1', employeeName: 'Ann Lee', shiftDate: '2026-10-15', shiftStart: '2026-10-15 08:00', shiftEnd: '2026-10-15 15:00', recordStatus: 'ACTIVE', activityCategory: 'SHIFT' },
        { recordKey: 'OLD2', teamId: 'TEAM_001', employeeId: 'E1', employeeName: 'Ann Lee', shiftDate: '2026-10-15', shiftStart: '2026-10-15 16:00', shiftEnd: '2026-10-15 16:20', recordStatus: 'ACTIVE', activityCategory: 'SHIFT' }
      ];
      var p = planFromDaily_(day, filter(true), { existing: old });
      assertEq_(p.actions.filter(function (a) { return a.type === 'REMOVE'; }).map(function (a) { return a.key; }).sort(), ['OLD1', 'OLD2']);
      assertEq_(p.summary.replacedPieces, 2);
    }]
  ];
}

function unitTestsLinks_() {
  var rec = function (id, name, start, end, cat) {
    return { recordStatus: 'ACTIVE', teamId: 'T1', employeeId: id, employeeName: name, shiftStart: start, shiftEnd: end, activityCategory: cat || 'SHIFT' };
  };
  var recs = [
    rec('E1', 'Ann Lee', '2026-10-15 08:00', '2026-10-15 16:00'),
    rec('E1', 'Ann Lee', '2026-10-15 13:30', '2026-10-15 14:30', 'MEETING'),
    rec('E2', 'Bob Ray', '2026-10-15 14:00', '2026-10-15 22:00'),
    rec('E3', 'Cy Moe', '2026-10-14 22:00', '2026-10-15 06:00'),
    rec('E4', 'Dee Fox', '2026-10-15 06:00', '2026-10-15 10:00')
  ];
  var names = function (list) { return list.map(function (p) { return p.employeeName; }); };
  return [
    ['Links: the IDs replace {IDS} exactly as configured (separator, text around each ID, encoding, chunks)', function () {
      var t = normalizeLinkTemplate_({ baseUrl: 'https://dash.example/live?users={IDS}', separator: '%2C' });
      assertEq_(buildMonitoringUrls_(t, ['A1', 'D 4', 'A1']), ['https://dash.example/live?users=A1%2CD%204'], 'unique, encoded, separator as typed');
      var each = normalizeLinkTemplate_({ baseUrl: 'https://chat.example/team?page=1', separator: '', prefix: '&userIds=' });
      assertEq_(buildMonitoringUrls_(each, ['1', '2']), ['https://chat.example/team?page=1&userIds=1&userIds=2'], 'no {IDS}: appended at the end');
      var raw = normalizeLinkTemplate_({ baseUrl: 'https://x.example/{IDS}', separator: '|', encode: false, maxPerLink: 2 });
      assertEq_(buildMonitoringUrls_(raw, ['a b', 'c', 'd']), ['https://x.example/a b|c', 'https://x.example/d'], 'no encoding; split into links of 2');
      assertEq_(buildMonitoringUrls_(t, []), [], 'no IDs, no link');
    }],
    ['Links: who is working now / at a time / in a window / that day (overnight shifts count)', function () {
      assertEq_(names(selectWorking_(recs, { date: '2026-10-15', who: 'AT', atMin: 14 * 60 })), ['Ann Lee', 'Bob Ray'], 'at 14:00 (shift ending at 14:00 or starting at 14:00: start counts)');
      assertEq_(names(selectWorking_(recs, { date: '2026-10-15', who: 'AT', atMin: 5 * 60 })), ['Cy Moe'], 'night shift from the day before');
      assertEq_(names(selectWorking_(recs, { date: '2026-10-15', who: 'WINDOW', fromMin: 9 * 60, toMin: 10 * 60 })), ['Dee Fox', 'Ann Lee']);
      assertEq_(names(selectWorking_(recs, { date: '2026-10-15', who: 'DAY' })).length, 4, 'meetings are never people');
      assertEq_(names(selectWorking_(recs, { date: '2026-10-15', who: 'AT', atMin: 14 * 60, excludeMeetings: true })), ['Bob Ray'], 'Ann is in a meeting at 14:00');
    }],
    ['Links: a window past midnight (23:00 – 08:00) runs into the next morning', function () {
      var night = recs.concat([rec('E5', 'Eve Ng', '2026-10-16 00:30', '2026-10-16 08:00'), rec('E6', 'Fay Lu', '2026-10-16 08:00', '2026-10-16 16:00')]);
      assertEq_(names(selectWorking_(night, { date: '2026-10-15', who: 'WINDOW', fromMin: 23 * 60, toMin: 8 * 60, excludePrevDay: true })), ['Eve Ng'],
        'Bob ends 22:00, Fay starts 08:00: neither is in the window');
      night.push(rec('E7', 'Gil Ok', '2026-10-15 22:00', '2026-10-16 06:00'));
      assertEq_(names(selectWorking_(night, { date: '2026-10-15', who: 'WINDOW', fromMin: 23 * 60, toMin: 8 * 60, excludePrevDay: true })), ['Gil Ok', 'Eve Ng']);
      assertEq_([linkWindowCrossesMidnight_(1380, 480), linkWindowCrossesMidnight_(480, 960)], [true, false]);
    }],
    ['Links: shifts "from previous day" are left out unless included', function () {
      assertEq_(names(selectWorking_(recs, { date: '2026-10-15', who: 'AT', atMin: 5 * 60, excludePrevDay: true })), []);
      assertEq_(selectAssignments_(recs, { date: '2026-10-15', who: 'DAY', include: 'SHIFTS', excludePrevDay: true }).length, 3);
      assertEq_([normalizeLinkTemplate_({}).includePrevDay, normalizeLinkTemplate_({ includePrevDay: true }).includePrevDay], [false, true], 'left out by default');
    }],
    ['CSV export: one column per chosen item with its own header; one value per row or the whole output in one cell; safe fields', function () {
      var cols = [{ header: 'Night agents', values: ['<@U1>', '<@U2>', '<@U3>'], text: '<@U1>, <@U2>, <@U3>' },
        { header: 'Plan, today', values: ['08:00 - 16:00 Ann', '14:00 - 22:00 "Bob"'], text: '08:00 - 16:00 Ann\n14:00 - 22:00 "Bob"' }];
      var rows = buildLinksCsv_(cols, { layout: 'ROWS', delimiter: ',' });
      assertEq_(rows.csv.split('\r\n'), ['Night agents,"Plan, today"', '<@U1>,08:00 - 16:00 Ann', '<@U2>,"14:00 - 22:00 ""Bob"""', '<@U3>,', ''], 'quotes, commas and the shorter column');
      assertEq_(rows.rows, 3);
      var cell = buildLinksCsv_(cols, { layout: 'CELL', delimiter: ';' });
      assertEq_(cell.csv, 'Night agents;Plan, today\r\n<@U1>, <@U2>, <@U3>;"08:00 - 16:00 Ann\n14:00 - 22:00 ""Bob"""\r\n', 'semicolon; line breaks kept inside one cell');
      assertEq_([csvField_('=SUM(A1)', ','), csvField_('-5', ','), csvField_('+1 555', ','), csvField_('-x', ','), csvField_('@SUM(A1)', ',')], ["'=SUM(A1)", '-5', '+1 555', "'-x", "'@SUM(A1)"], 'formulas never run when the file is opened');
      assertEq_([csvField_('@John Doe', ','), csvField_('@john.doe', ','), csvField_('<@U1>', ',')], ['@John Doe', '@john.doe', '<@U1>'], 'names and mentions stay as they are');
      var plan = { template: { kind: 'PLAN', emptyText: 'No one scheduled' }, text: 'Leads\n08:00 Ann\n\nAgents\n09:00 Bob', urls: [] };
      assertEq_(linkOutputValues_(plan), ['Leads', '08:00 Ann', 'Agents', '09:00 Bob'], 'plan lines without the blank ones');
      assertEq_(linkOutputValues_({ template: { kind: 'PLAN', emptyText: 'No one scheduled' }, text: 'No one scheduled', urls: [] }), [], 'nobody: an empty column');
      assertEq_(linkOutputValues_({ template: { kind: 'LINK' }, urls: ['https://x/1', 'https://x/2'] }), ['https://x/1', 'https://x/2']);
      var list = { template: { kind: 'LIST', emptyText: '' }, text: '@Ann Lee, @Bob Ray', values: ['@Ann Lee', '@Bob Ray'], rawValues: ['Ann Lee', 'Bob Ray'], urls: [] };
      assertEq_([linkOutputValues_(list), linkOutputValues_(list, true)], [['@Ann Lee', '@Bob Ray'], ['Ann Lee', 'Bob Ray']], 'plain: without the text added before/after each value');
      assertEq_(normalizeLinkCsvSettings_({ plain: 1 }).plain, true);
      assertEq_(normalizeLinkCsvSettings_({ columns: [{ id: 'A', header: 'X' }, { id: '' }], layout: 'NOPE', delimiter: '|' }),
        { columns: [{ id: 'A', header: 'X', field: '' }], layout: 'ROWS', delimiter: ',', plain: false });
      var recs3 = [{ employeeId: 'E1', employeeName: 'Ann Lee', teamId: 'T1' }, { employeeId: 'E2', employeeName: 'Bob Ray', teamId: 'T1' }, { employeeId: 'E1', employeeName: 'Ann Lee', teamId: 'T1' }, { employeeId: '', employeeName: 'Cy Moe', teamId: 'T1' }];
      var mail = { E1: 'ann@x.com', E2: 'bob@x.com' };
      assertEq_(staffColumnValues_(recs3, function (r) { return mail[r.employeeId] || ''; }), { values: ['ann@x.com', 'bob@x.com'], missing: ['Cy Moe'] }, 'emails of the listed people, each once; who has none is named');
      var al = buildAgentList_(normalizeLinkTemplate_({ kind: 'LIST', separator: ', ' }), [{ identity: 'a', rec: recs3[0] }, { identity: 'b', rec: recs3[1] }], function (r) { return r.employeeName; });
      assertEq_(al.listed.map(function (r) { return r.employeeId; }), ['E1', 'E2'], 'the people behind the names, in order');
    }],
    ['Agent lists: people of a day as names or IDs, optionally only those not working on another day', function () {
      var t = normalizeLinkTemplate_({ kind: 'LIST', name: 'Add', idField: 'NAME', separator: ', ', listDay: 'TODAY', exceptDay: 'YESTERDAY' });
      assertEq_([t.who, t.listDay, t.exceptDay, listDayDate_('2026-10-15', 'YESTERDAY'), listDayDate_('2026-10-31', 'TOMORROW')],
        ['DAY', 'TODAY', 'YESTERDAY', '2026-10-14', '2026-11-01']);
      var today = selectWorking_(recs, { date: '2026-10-15', who: 'DAY', excludePrevDay: true });
      var yesterday = {};
      selectWorking_(recs, { date: '2026-10-14', who: 'DAY', excludePrevDay: true }).forEach(function (p) { yesterday[p.identity] = true; });
      var nameOf = function (r) { return r.employeeName; };
      assertEq_(buildAgentList_(t, today, nameOf, null).text, 'Dee Fox, Ann Lee, Bob Ray');
      assertEq_(buildAgentList_(normalizeLinkTemplate_({ kind: 'LIST', separator: '\\n' }), today, nameOf, null).text, 'Dee Fox\nAnn Lee\nBob Ray', '\\n = one per line');
      var add = buildAgentList_(t, today, nameOf, { 'ID:E4': true });
      assertEq_([add.text, add.left], ['Ann Lee, Bob Ray', 1]);
      var noLeads = buildAgentList_(normalizeLinkTemplate_({ kind: 'LIST', separator: ', ', excludeRoles: 'Shift Lead' }), today, nameOf, null,
        function (r) { return r.employeeId === 'E2' ? 'shift  lead' : 'Agent'; });
      assertEq_([noLeads.text, noLeads.byRole], ['Dee Fox, Ann Lee', 1], 'roles are left out ignoring case and spaces');
      var removed = buildAgentList_(normalizeLinkTemplate_({ kind: 'LIST', prefix: '<@', suffix: '>', separator: ' ' }),
        selectWorking_(recs, { date: '2026-10-14', who: 'DAY', excludePrevDay: true }), function (r) { return r.employeeId === 'E3' ? 'U3' : ''; }, null);
      assertEq_([removed.text, removed.missing], ['<@U3>', []], 'Cy worked yesterday (22:00 start)');
      assertEq_(Object.keys(yesterday), ['ID:E3']);
      assertEq_(buildAgentList_(normalizeLinkTemplate_({ kind: 'LIST', emptyText: '' }), [], nameOf, null).text, '');
      assertEq_(validateLinkTemplate_(normalizeLinkTemplate_({ kind: 'LIST', name: 'X', idField: 'NAME', listDay: 'TODAY', exceptDay: 'TODAY' }), ['employeeId']).length, 1, 'compare with another day');
      assertEq_(validateLinkTemplate_(normalizeLinkTemplate_({ kind: 'LIST', name: 'X', idField: 'NAME' }), ['employeeId']), [], 'Name needs no staff column');
    }],
    ['Links: templates need a name and an http(s) base URL; the ID column must be a staff column', function () {
      var t = normalizeLinkTemplate_({ name: 'X', baseUrl: 'https://a.example/{IDS}', idField: 'field:phone', who: 'WINDOW', from: '10:00', to: '10:00' });
      var errs = validateLinkTemplate_(t, ['employeeId', 'field:phone']);
      assertEq_(errs.length, 1, 'only the empty window: ' + errs.join(' | '));
      t.to = '08:00';
      assertEq_(validateLinkTemplate_(t, ['employeeId', 'field:phone']), [], 'a window past midnight is valid');
      assertEq_(validateLinkTemplate_(normalizeLinkTemplate_({ name: '', baseUrl: 'ftp://x', idField: 'nope' }), ['employeeId']).length, 3);
      assertEq_(normalizeLinkTemplate_({}).separator, ',', 'default separator');
      assertEq_(validateLinkTemplate_(normalizeLinkTemplate_({ name: 'Live', baseUrl: 'https://a.example' }), ['employeeId'], ['live']).length, 1, 'names are unique (case-insensitive)');
    }],
    ['Daily plans: one line per shift and/or meeting from the line format, sorted, optionally grouped by team', function () {
      var plan = normalizeLinkTemplate_({ kind: 'PLAN', name: 'Day', lineTemplate: '{START} - {END} <@{ID}> {NAME}' });
      var items = selectAssignments_(recs, { date: '2026-10-15', who: 'DAY', include: 'BOTH' });
      var ids = { E1: 'U1', E2: 'U2' };
      var text = buildPlanText_(plan, items, { T1: 'Support' }, function (r) { return ids[r.employeeId] || ''; });
      assertEq_(text.split('\n'), ['22:00 - 06:00 <@> Cy Moe', '06:00 - 10:00 <@> Dee Fox', '08:00 - 16:00 <@U1> Ann Lee', '13:30 - 14:30 <@U1> Ann Lee', '14:00 - 22:00 <@U2> Bob Ray']);
      var shifts = selectAssignments_(recs, { date: '2026-10-15', who: 'AT', atMin: 14 * 60, include: 'SHIFTS' });
      var grouped = buildPlanText_(normalizeLinkTemplate_({ kind: 'PLAN', groupByTeam: true }), shifts, { T1: 'Support' }, function () { return ''; });
      assertEq_(grouped, 'Support\n08:00 - 16:00 Ann Lee\n14:00 - 22:00 Bob Ray');
      assertEq_(buildPlanText_(normalizeLinkTemplate_({ kind: 'PLAN', emptyText: 'Nobody' }), [], {}, function () { return ''; }), 'Nobody');
      assertEq_(selectAssignments_(recs, { date: '2026-10-15', who: 'DAY', include: 'MEETINGS' }).length, 1);
    }],
    ['Daily plans: roles from the staff sheet put shift leads first (with headings), or filter by role', function () {
      var roles = { E2: 'Support Shift Lead', E4: 'support  shift lead', E1: 'Agent' };
      var roleOf = function (r) { return roles[r.employeeId] || ''; };
      var shifts = selectAssignments_(recs, { date: '2026-10-15', who: 'DAY', include: 'SHIFTS' });
      var first = normalizeLinkTemplate_({ kind: 'PLAN', roles: 'Support Shift Lead', lineTemplate: '{START} {NAME} {ROLE}' });
      assertEq_(buildPlanText_(first, shifts, {}, function () { return ''; }, roleOf).split('\n'),
        ['06:00 Dee Fox support shift lead', '14:00 Bob Ray Support Shift Lead', '22:00 Cy Moe', '08:00 Ann Lee Agent'],
        'leads first (role matched ignoring case/spaces), each part by start time');
      var heads = normalizeLinkTemplate_({ kind: 'PLAN', roles: ['Support Shift Lead'], roleHeadings: true, restHeading: 'Agents' });
      assertEq_(buildPlanText_(heads, shifts, {}, function () { return ''; }, roleOf),
        'Support Shift Lead\n06:00 - 10:00 Dee Fox\n14:00 - 22:00 Bob Ray\n\nAgents\n22:00 - 06:00 Cy Moe\n08:00 - 16:00 Ann Lee');
      var only = normalizeLinkTemplate_({ kind: 'PLAN', roles: 'Support Shift Lead', roleMode: 'ONLY' });
      var except = normalizeLinkTemplate_({ kind: 'PLAN', roles: 'Support Shift Lead', roleMode: 'EXCEPT' });
      assertEq_([orderPlanItems_(only, shifts, roleOf).length, orderPlanItems_(except, shifts, roleOf).length], [2, 2]);
    }],
    ['Daily plans: several sections with own headings (one or more roles each), everyone else, left-out roles', function () {
      var roles = { E2: 'Support Shift Lead', E4: 'Senior Agent', E3: 'Team Lead', E1: 'Trainee' };
      var roleOf = function (r) { return roles[r.employeeId] || ''; };
      var shifts = selectAssignments_(recs, { date: '2026-10-15', who: 'DAY', include: 'SHIFTS' });
      var plan = normalizeLinkTemplate_({ kind: 'PLAN', lineTemplate: '{NAME}',
        sections: [{ heading: '🎧 Shift leads', roles: 'support shift lead' }, { heading: '⭐ Seniors', roles: ['Senior Agent', 'Team Lead'] }],
        showRest: true, restHeading: 'Agents', excludeRoles: 'Trainee' });
      assertEq_(buildPlanText_(plan, shifts, {}, function () { return ''; }, roleOf), '🎧 Shift leads\nBob Ray\n\n⭐ Seniors\nCy Moe\nDee Fox',
        'Ann (Trainee) left out; no one else, so no "Agents" section');
      var noHead = normalizeLinkTemplate_({ kind: 'PLAN', lineTemplate: '{NAME}', sections: [{ heading: '', roles: 'Support Shift Lead' }], showRest: false });
      assertEq_(buildPlanText_(noHead, shifts, {}, function () { return ''; }, roleOf), 'Bob Ray', 'only the section; no heading line');
      var old = normalizeLinkTemplate_({ kind: 'PLAN', roles: 'A, B', roleMode: 'ONLY', roleHeadings: true });
      assertEq_([old.sections.map(function (s) { return s.heading + ':' + s.roles.join('|'); }), old.showRest], [['A:A', 'B:B'], false], 'older role settings are converted');
    }],
    ['Daily plans: sections by any staff column (e.g. Skills); a cell with several values matches any; {ROLE} stays the Role', function () {
      var skills = { E1: 'Chat, Phone', E2: 'Email', E3: 'phone', E4: '' };
      var roles = { E1: 'Agent', E2: 'Lead', E3: 'Agent', E4: 'Agent' };
      var skillOf = function (r) { return skills[r.employeeId] || ''; };
      var roleOf = function (r) { return roles[r.employeeId] || ''; };
      var shifts = selectAssignments_(recs, { date: '2026-10-15', who: 'DAY', include: 'SHIFTS' });
      var plan = normalizeLinkTemplate_({ kind: 'PLAN', lineTemplate: '{NAME} ({ROLE})', sectionField: 'skills',
        sections: [{ heading: '📞 Phone', roles: 'Phone' }, { heading: '✉ Email', roles: 'email' }], restHeading: 'Others', excludeRoles: 'Chat only' });
      assertEq_(plan.sectionField, 'skills');
      assertEq_(buildPlanText_(plan, shifts, {}, function () { return ''; }, roleOf, '2026-10-15', skillOf),
        '📞 Phone\nCy Moe (Agent)\nAnn Lee (Agent)\n\n✉ Email\nBob Ray (Lead)\n\nOthers\nDee Fox (Agent)', 'Ann\'s "Chat, Phone" matches Phone; {ROLE} still shows the Role');
      assertEq_(normalizeLinkTemplate_({ kind: 'PLAN' }).sectionField, 'role', 'Role by default (older plans unchanged)');
      assertEq_(planCellValues_(' Chat ,Phone '), ['chat phone', 'chat', 'phone']);
      var gone = normalizeLinkTemplate_({ kind: 'PLAN', name: 'P', sectionField: 'field:old', sections: [{ heading: 'A', roles: 'x' }] });
      assertEq_(validateLinkTemplate_(gone, ['employeeId'], [], ['role', 'notes']).length, 1, 'a deleted column is reported');
      assertEq_(validateLinkTemplate_(normalizeLinkTemplate_({ kind: 'PLAN', name: 'P', sectionField: 'field:old' }), ['employeeId'], [], ['role']), [], 'no sections: the column does not matter');
    }],
    ['Daily plans: extra text by time is added after the name, or at {TAGS}', function () {
      var shifts = selectAssignments_(recs, { date: '2026-10-15', who: 'DAY', include: 'SHIFTS' });
      var tags = [{ text: '📞', mode: 'OVERLAPS', from: '08:00', to: '14:00' }, { text: '🌙', mode: 'ENDS_AFTER', from: '21:00' },
        { text: '(early)', mode: 'STARTS_BEFORE', from: '07:00' }];
      var after = normalizeLinkTemplate_({ kind: 'PLAN', lineTemplate: '{START} - {END} {NAME}', tags: tags });
      assertEq_(buildPlanText_(after, shifts, {}, function () { return ''; }, null, '2026-10-15').split('\n'),
        ['22:00 - 06:00 Cy Moe (early)', '06:00 - 10:00 Dee Fox 📞 (early)', '08:00 - 16:00 Ann Lee 📞', '14:00 - 22:00 Bob Ray 🌙']);
      var slot = normalizeLinkTemplate_({ kind: 'PLAN', lineTemplate: '{TAGS} {NAME} {START}', tags: [{ text: '*', mode: 'COVERS', from: '09:00', to: '15:00' }] });
      assertEq_(buildPlanText_(slot, shifts, {}, function () { return ''; }, null, '2026-10-15').split('\n'),
        ['Cy Moe 22:00', 'Dee Fox 06:00', '* Ann Lee 08:00', 'Bob Ray 14:00'], 'COVERS = the whole window; empty {TAGS} leaves no extra space');
      assertEq_(validateLinkTemplate_(normalizeLinkTemplate_({ kind: 'PLAN', name: 'P', tags: [{ text: 'x', mode: 'OVERLAPS', from: '14:00', to: '08:00' }] }), ['employeeId']).length, 1);
      var quiet = normalizeLinkTemplate_({ kind: 'PLAN', lineTemplate: '{NAME}', tags: tags,
        sections: [{ heading: 'Leads', roles: 'Lead', noTags: true }], restHeading: 'Agents' });
      var roleOf = function (r) { return r.employeeId === 'E4' ? 'Lead' : ''; };
      assertEq_(buildPlanText_(quiet, shifts, {}, function () { return ''; }, roleOf, '2026-10-15'),
        'Leads\nDee Fox\n\nAgents\nCy Moe (early)\nAnn Lee 📞\nBob Ray 🌙', 'a section with "No extra text" gets no time rules; the others still do');
    }],
    ['Links sheet: column names in row 1, one row per item in the saved order, extra URL columns when split; items can be moved', function () {
      var a = { id: 'A', name: 'Live', kind: 'LINK' }, b = { id: 'B', name: 'Plan', kind: 'PLAN' };
      var t = linksSheetRows_([
        { template: a, date: '2026-10-15', urls: ['https://x/1', 'https://x/2'], text: '3 agent(s)', count: 3, people: 4, missing: ['Zed'] },
        { template: b, date: '2026-10-15', urls: [], text: '08:00 - 16:00 Ann', count: 1, people: 1, missing: [] }
      ], '2026-10-15 08:00');
      assertEq_(t.header, ['Name', 'Kind', 'Date', 'Updated', 'Count', 'Missing', 'Text', 'URL', 'URL 2']);
      assertEq_(t.rows[0], ['Live', 'Link', '2026-10-15', '2026-10-15 08:00', '3 of 4', 'Zed', '3 agent(s)', 'https://x/1', 'https://x/2']);
      assertEq_(t.rows[1].slice(0, 2).concat(t.rows[1].slice(6)), ['Plan', 'Plan', '08:00 - 16:00 Ann', '', '']);
      var s = normalizeLinkSheetSettings_({});
      assertEq_([s.layout, s.keyHeader, s.keyValue, s.dateHeader, s.dateFormat], ['ROW', 'Key', 'DAILY', 'Header_Date', 'yyyy-MM-dd'], 'one row is the default');
      var one = linksSheetRow_([
        { template: a, urls: ['https://x/1', 'https://x/2'], text: '' },
        { template: b, urls: [], text: '08:00 - 16:00 Ann' },
        { template: { name: 'Nobody', kind: 'LINK' }, urls: [], text: '' }
      ], s, '2026-10-15');
      assertEq_(one.header, ['Key', 'Header_Date', 'Live', 'Live 2', 'Plan', 'Nobody']);
      assertEq_(one.values, ['DAILY', '2026-10-15', 'https://x/1', 'https://x/2', '08:00 - 16:00 Ann', '']);
      assertEq_(one.urlCols, [2, 3, 5], 'link columns (clickable)');
      var list = [a, b, { id: 'C' }];
      assertEq_(moveLinkTemplate_(list, 'C', -1).map(function (x) { return x.id; }), ['A', 'C', 'B']);
      assertEq_(moveLinkTemplate_(list, 'A', -1).map(function (x) { return x.id; }), ['A', 'B', 'C'], 'the first item cannot move up');
    }]
  ];
}

function unitTestsWebApp_() {
  return [
    ['Web app: the navigation bar goes right after <body>, the script before </head>, and <body> gets the web-page class', function () {
      var page = '<!DOCTYPE html><html><head><base target="_top"></head><body class="sidebar">\n<main>x</main></body></html>';
      var out = injectWebShell_(page, '<script>W</script>', '<nav>N</nav>');
      assert_(out.indexOf('<script>W</script></head>') > 0, 'head part');
      assert_(out.indexOf('<body class="web-page sidebar"><nav>N</nav>') > 0, 'class kept and nav first: ' + out);
      assert_(injectWebShell_('<html><head></head><body><p>', 'H', 'N').indexOf('<body class="web-page">N<p>') > 0, 'body without class');
      assertEq_(injectWebShell_('<p>bare</p>', 'H', 'N'), 'NH<p>bare</p>', 'no head or body tag');
      assertEq_(webPageHeader_('<body class="sidebar"><main class="app-body">', 'Staff <Directory>'), '<header class="app-header"><h1>Staff &lt;Directory&gt;</h1></header>', 'sidebar pages get a header');
      assertEq_(webPageHeader_('<header class="app-header">', 'X'), '', 'pages with a header keep theirs');
    }],
    ['Web app: every page has a file and a title; the nav marks the current page (or the page it belongs to)', function () {
      Object.keys(WEB_PAGES).forEach(function (k) { assert_(WEB_PAGES[k].file && WEB_PAGES[k].title, k); });
      var nav = webNav_('team', 'https://x/exec');
      // Extension pages (when their files are present) come after the built-in ones.
      assertEq_(nav.map(function (n) { return n.key; }).filter(function (k) { return WEB_PAGES[k]; }), ['home', 'schedule', 'dashboard', 'import', 'teams', 'staff', 'links', 'settings']);
      assertEq_(nav.filter(function (n) { return n.current; }).map(function (n) { return n.key; }), ['teams'], 'Team editor belongs to Teams');
      assertEq_(nav[3].href, 'https://x/exec?page=import');
      assertEq_(WEB_PAGES.setup.init, false, 'Setup opens before initialization');
      assertEq_([webDateParam_('2026-10-15'), webDateParam_('15/10/2026'), webListParam_('A, B,,C'), webListParam_('')], ['2026-10-15', '', ['A', 'B', 'C'], []]);
    }],
    ['Web app: prefetched answers are keyed exactly like the page\'s first api() call', function () {
      var pre = webPrefetch_([['apiPing'], ['notAnApi'], ['apiNoSuchFunction', 1]]);
      assertEq_(Object.keys(pre), ['apiPing[]'], 'only existing api* functions');
      assert_(pre['apiPing[]'].ok, 'the {ok, data} answer as the client expects it');
      var b = WEB_PAGES.schedule.boot({ date: '2026-10-15', teams: 'T1,T2' });
      assertEq_(WEB_PAGES.schedule.prefetch({}, b), [['apiWebDay', '2026-10-15', ['T1', 'T2']]], 'same arguments as WebSchedule load()');
      assertEq_(WEB_PAGES.team.prefetch({}, WEB_PAGES.team.boot({})), [['apiTeamDialogBootstrap', '']], 'same as TeamDialog: BOOT.teamId || ""');
    }],
    ['Web pages: one day as data has the same numbers as the daily sheet; person keys and weeks', function () {
      var team = { teamId: 'T1', settings: { display: { operatingHoursMode: '24_7' }, import: {} } };
      var rec = function (id, name, s, e, cat) { return { recordStatus: 'ACTIVE', teamId: 'T1', employeeId: id, employeeName: name, shiftDate: s.substr(0, 10), shiftStart: s, shiftEnd: e, activityCategory: cat || 'SHIFT', scheduledMinutes: '' }; };
      var recs = [rec('E1', 'Ann Lee', '2026-10-15 08:00', '2026-10-15 16:00'), rec('E1', 'Ann Lee', '2026-10-15 10:00', '2026-10-15 11:00', 'MEETING'),
        rec('E2', 'Bob Ray', '2026-10-14 22:00', '2026-10-15 06:00'), rec('E3', 'Cy Moe', '2026-10-15 12:00', '2026-10-15 20:00')];
      var dv = dayView_(team, '2026-10-15', recs, null, TEST_CFG_);
      var S = dv.summary;
      assertEq_([S.shifts, S.meetings, S.staff, S.workingHours, S.carried, S.peak], [2, 1, 2, '16:00', 1, 2],
        'Bob is carried over from the day before; the meeting inside Ann\'s shift adds no hours; peak 12–16 = Ann and Cy');
      assertEq_(dv.headcount.length, 24);
      var row = webDayRow_(dv.rows[0], dayNumber_('2026-10-15') * 1440, null, '');
      assertEq_([row.name, row.start, row.end, row.from, row.carry, row.key], ['Bob Ray', '22:00', '06:00', -120, true, 'ID:E2']);
      assertEq_([webPersonKey_('', ' Ann  Lee '), webRecordIsPerson_({ employeeId: 'e1' }, 'ID:E1'), webRecordIsPerson_({ employeeId: '', employeeName: 'ann lee' }, 'NM:Ann Lee'),
        webRecordIsPerson_({ employeeId: 'E9', employeeName: 'Ann Lee' }, 'NM:Ann Lee')], ['NM:Ann Lee', true, true, false]);
      assertEq_([weekStartOf_('2026-10-15'), weekStartOf_('2026-10-19'), weekStartOf_('2026-10-25')], ['2026-10-12', '2026-10-19', '2026-10-19'], 'weeks start on Monday');
    }],
    ['Web pages: the Monitoring Links output is read item by item in both layouts', function () {
      var row = linksOutputItems_([['Key', 'Header_Date', 'Live', 'Plan'], ['DAILY', '2026-10-15', 'https://x/1', '08:00 Ann']], { layout: 'ROW' });
      assertEq_(row.map(function (x) { return x.name + '=' + x.value + (x.url ? ' (url)' : ''); }), ['Live=https://x/1 (url)', 'Plan=08:00 Ann']);
      var rows = linksOutputItems_([['Name', 'Kind', 'Date', 'Updated', 'Count', 'Missing', 'Text', 'URL', 'URL 2'],
        ['Live', 'Link', '', '', '', '', '3 agent(s)', 'https://x/1', 'https://x/2'], ['Plan', 'Plan', '', '', '', '', '08:00 Ann', '', '']], { layout: 'ROWS' });
      assertEq_(rows.map(function (x) { return x.name + '=' + x.value; }), ['Live=https://x/1', 'Live 2=https://x/2', 'Plan=08:00 Ann']);
    }],
    ['Web app: the tab icon comes from the theme file\'s first-line tag (or the older comment); only http(s) URLs', function () {
      assertEq_(faviconFromThemeHtml_('<meta name="sm-favicon" content="https://x.example/i.png?a=1&amp;b=2"><!-- note -->\n<style>'), 'https://x.example/i.png?a=1&b=2', '&amp; in the attribute');
      assertEq_(faviconFromThemeHtml_("<meta content='https://y.example/f.ico' name='sm-favicon'>"), 'https://y.example/f.ico', 'either attribute order and quote');
      assertEq_(faviconFromThemeHtml_('<meta name="viewport" content="width=device-width"><style>'), '', 'other meta tags are ignored');
      assertEq_(faviconFromThemeHtml_('<!-- favicon: https://x.example/i.png?a=1&b=2 -->\n<style>'), 'https://x.example/i.png?a=1&b=2', 'older comment form');
      assertEq_([faviconFromThemeHtml_('<style>no marker</style>'), faviconFromThemeHtml_('<!-- favicon: javascript:alert(1) -->')], ['', '']);
      assert_(/^https:\/\/raw\.githubusercontent\.com\/.+\/default\.png$/.test(WEB_DEFAULT_FAVICON_), 'default icon hosted with the repository');
    }],
    ['Sheet index: the newest stored copy wins; copies stored before the web app are read too', function () {
      var old = JSON.stringify({ 11: { teamId: 'T1', kind: 'schedule' } });
      var newer = JSON.stringify({ at: 200, idx: { 22: { teamId: 'T2', kind: 'staff' } } });
      var older = JSON.stringify({ at: 100, idx: { 33: { teamId: 'T3', kind: 'staff' } } });
      assertEq_(Object.keys(newestSheetIndex_([old])), ['11']);
      assertEq_(Object.keys(newestSheetIndex_([older, newer, old])), ['22']);
      assertEq_(newestSheetIndex_(['not json']), null);
    }]
  ];
}

function unitTestsIdImport_() {
  var targets = [
    { key: 'employeeId', label: 'Employee ID', kind: 'ID', unique: true, fill: true },
    { key: 'employeeName', label: 'Employee Name', kind: 'TEXT', unique: false, fill: false },
    { key: 'email', label: 'Email', kind: 'EMAIL', unique: false, fill: true },
    { key: 'role', label: 'Role', kind: 'TEXT', unique: false, fill: true },
    { key: 'field:slack', label: 'Slack ID', kind: 'IDENTIFIER', unique: true, fill: true }
  ];
  var person = function (row, id, name, f) { return { _row: row, employeeId: id, employeeName: name, fields: f || {} }; };
  var sheets = function () {
    return [
      { teamId: 'T1', teamName: 'Alpha', keys: ['employeeId', 'employeeName', 'role', 'email', 'field:slack'], rows: [person(4, '', 'Ann Lee', { email: '' }),
        person(5, 'B9', 'Bob Ray', { email: 'bob@x.com', 'field:slack': 'U9' }), person(6, '', 'Cy Moe')] },
      { teamId: 'T2', teamName: 'Beta', keys: ['employeeId', 'employeeName', 'role'], rows: [person(4, '', 'Dee Fox'), person(5, '0123', 'Ann Lee')] }
    ];
  };
  var report = [['Custom report', ''], ['Badge no.', 'Name as First name, Last name'],
    ['0123', 'Ann, Lee'], ['555', 'Bob Ray'], ['777', 'Fox, Dee'], ['900', 'Zed New'], ['', 'No Badge'], ['555', 'Cy Moe']];
  var plan = function (table, o) { return planStaffImport_(table, o, sheets(), targets); };
  var statusOf = function (p) { var o = {}; p.items.forEach(function (i) { o[i.key] = i.status; }); return o; };
  return [
    ['Staff import: a Quinyx Custom report is read from row 2 and mapped as Name → find, Badge no. → Employee ID', function () {
      assertEq_(detectStaffImportHeader_(report), 2);
      var cols = staffImportColumns_(report, 2);
      assertEq_(cols.map(function (c) { return c.label; }), ['Badge no.', 'Name as First name, Last name']);
      var m = guessStaffImportMapping_(cols, targets);
      assertEq_([m.matchColumn, m.matchField, m.fills], [1, 'employeeName', [{ column: 0, field: 'employeeId' }]]);
      var e = guessStaffImportMapping_(staffImportColumns_([['Name', 'Email', 'Slack ID', 'Other']], 1), targets);
      assertEq_(e.fills, [{ column: 1, field: 'email' }, { column: 2, field: 'field:slack' }], 'columns named like staff columns are filled');
    }],
    ['Staff import: names match in every staff sheet; "Last, First" is tried; existing values are never replaced silently', function () {
      var p = plan(report, { headerRow: 2, matchColumn: 1, matchField: 'employeeName', fills: [{ column: 0, field: 'employeeId' }] });
      var s = statusOf(p);
      assertEq_([s['Ann, Lee'], s['Zed New'], s['Fox, Dee']], ['SET', 'NOT_FOUND', 'SET']);
      assertEq_(s['No Badge'], 'NOT_FOUND');
      assertEq_(statusOf(plan([['Name', 'Mail'], ['Cy Moe', '']], { headerRow: 1, matchColumn: 0, matchField: 'employeeName', fills: [{ column: 1, field: 'email' }] }))['Cy Moe'], 'EMPTY', 'an empty cell never clears anything');
      assertEq_([s['Bob Ray'], s['Cy Moe']], ['DUP_VALUE', 'DUP_VALUE'], 'one badge for two people is refused');
      var ann = p.items.filter(function (i) { return i.key === 'Ann, Lee'; })[0];
      assertEq_(ann.changes.map(function (c) { return c.teamName + ':' + c.status; }), ['Alpha:SET', 'Beta:SAME'], 'leading zeros kept; same ID in Beta');
      assertEq_(p.summary.writes, 2);
    }],
    ['Staff import: emails and own columns; checks per column; teams can be limited', function () {
      var t = [['Name', 'E-mail', 'Slack', 'Role'], ['Ann Lee', 'ann@x.com', 'U1', 'Agent'], ['Bob Ray', 'BOB@x.com', 'U9', 'Lead'], ['Cy Moe', 'not-an-email', 'U9', ''], ['Dee Fox', 'dee@x.com', '', 'Agent']];
      var p = plan(t, { headerRow: 1, matchColumn: 0, matchField: 'employeeName', fills: [{ column: 1, field: 'email' }, { column: 2, field: 'field:slack' }, { column: 3, field: 'role' }] });
      var ch = function (key, field, team) { return p.items.filter(function (i) { return i.key === key; })[0].changes.filter(function (c) { return c.field === field && (!team || c.teamName === team); })[0].status; };
      assertEq_([ch('Ann Lee', 'email', 'Alpha'), ch('Bob Ray', 'email'), ch('Cy Moe', 'email')], ['SET', 'SAME', 'INVALID_VALUE'], 'emails ignore capitals; invalid ones are refused');
      assertEq_([ch('Bob Ray', 'field:slack'), ch('Cy Moe', 'field:slack')], ['DUP_VALUE', 'DUP_VALUE'], 'one Slack ID for two people in the file');
      assertEq_(ch('Ann Lee', 'email', 'Beta'), 'NO_COLUMN', 'Beta has no Email column');
      assertEq_(ch('Bob Ray', 'role'), 'SET');
      var only = plan(t, { headerRow: 1, matchColumn: 0, matchField: 'employeeName', fills: [{ column: 3, field: 'role' }], teamIds: ['T2'] });
      assertEq_(statusOf(only)['Bob Ray'], 'NOT_FOUND', 'only the chosen team is searched');
    }],
    ['Staff import: a platform report (A1 Identifier, C1 Full name) fills an own ID column; each layout keeps its own column choice', function () {
      var platformReport = [['Identifier', 'Email', 'Full name'], ['1234567', 'a@x.com', 'Ann Lee'], ['7654321', '', 'Lee, Ann']];
      var cols = staffImportColumns_(platformReport, detectStaffImportHeader_(platformReport));
      var g = guessStaffImportMapping_(cols, targets);
      assertEq_([g.matchColumn, g.matchField], [2, 'employeeName'], 'Full name finds the person');
      assert_(!g.fills.some(function (f) { return f.field === 'employeeId'; }), '"Identifier" is never taken for the Employee ID');
      var tg = targets.concat([{ key: 'field:platform', label: 'Platform ID', kind: 'IDENTIFIER', unique: true, fill: true }]);
      var sh = sheets(); sh[0].keys.push('field:platform');
      var p = planStaffImport_([['Identifier', 'Email', 'Full name'], ['1234567', '', 'Ann Lee']], { headerRow: 1, matchColumn: 2, matchField: 'employeeName', fills: [{ column: 0, field: 'field:platform' }] }, sh, tg);
      assertEq_(p.items[0].changes.map(function (c) { return c.teamName + ':' + c.status; }), ['Alpha:SET', 'Beta:NO_COLUMN'], 'written into the Platform ID column of the row found by name');
      var dup = planStaffImport_(platformReport, { headerRow: 1, matchColumn: 2, matchField: 'employeeName', fills: [{ column: 0, field: 'field:platform' }] }, sh, tg);
      assertEq_(dup.items.map(function (i) { return i.status; }), ['DUPLICATE_IN_FILE', 'DUPLICATE_IN_FILE'], '"Ann Lee" and "Lee, Ann" find the same person: neither is written');
      assertEq_(dup.summary.writes, 0);
      var mem = rememberStaffImportMapping_([], ['Badge no.', 'Name'], { matchColumn: 1, matchField: 'employeeName', fills: [{ column: 0, field: 'employeeId' }] });
      mem = rememberStaffImportMapping_(mem, ['Identifier', 'Email', 'Full name'], { matchColumn: 2, matchField: 'employeeName', fills: [{ column: 0, field: 'field:platform' }] });
      assertEq_(rememberedStaffImportMapping_(mem, ['identifier', 'Email', ' Full  name']).fills[0].field, 'field:platform', 'Platform layout (capitals and spaces ignored)');
      assertEq_(rememberedStaffImportMapping_(mem, ['Badge no.', 'Name']).fills[0].field, 'employeeId', 'the Quinyx layout keeps its own');
      assertEq_(rememberedStaffImportMapping_(mem, ['Other']), null);
    }],
    ['Staff import: names that look alike are only suggested for review; your choice decides and is remembered', function () {
      var sim = function (a, b) { return staffImportNameSimilarity_(a, b).why; };
      assertEq_([sim('Lee Ann Marie', 'Ann Marie Lee'), sim('Ann Lee', 'Ann Marie Lee'), sim('Jon Smit', 'John Smith'), sim('A. Lee', 'Ann Lee'), sim('Ann Lee', 'Bob Ray')],
        ['same words, different order', 'middle name differs', 'similar spelling', 'same last name and initial', '']);
      var sh = sheets();
      sh[0].rows.push(person(7, 'E7', 'Ann Marie Lee'));
      var tg = targets.concat([{ key: 'field:platform', label: 'Platform ID', kind: 'IDENTIFIER', unique: true, fill: true }]);
      sh[0].keys.push('field:platform');
      var t = [['Identifier', 'Full name'], ['111', 'Lee Ann Marie'], ['222', 'Zed Nobody'], ['333', 'Cy Moe']];
      var o = { headerRow: 1, matchColumn: 1, matchField: 'employeeName', fills: [{ column: 0, field: 'field:platform' }] };
      var p = planStaffImport_(t, o, sh, tg);
      var it = p.items[0];
      assertEq_([it.status, it.suggestions[0].label, it.changes.length], ['SUGGESTED', 'Ann Marie Lee · E7', 0], 'suggested, nothing written yet');
      assertEq_([p.items[1].status, p.summary.review, p.summary.writes], ['NOT_FOUND', 1, 1], 'only Cy is written without review');
      o.assign = { 2: it.suggestions[0].ref, 4: 'SKIP' }; // file rows: 1 = header, 2 = Lee Ann Marie, 4 = Cy Moe
      var q = planStaffImport_(t, o, sh, tg);
      assertEq_([q.items[0].status, q.items[0].changes[0].row, q.items[2].status, q.summary.writes], ['SET', 7, 'SKIPPED', 1], 'the chosen person gets the ID; Cy is left out');
      assertEq_(q.learned, [{ key: 'employeeName|lee ann marie', ref: 'T1|ID:E7' }], 'the choice is remembered');
      var again = planStaffImport_(t, { headerRow: 1, matchColumn: 1, matchField: 'employeeName', fills: o.fills, aliases: { 'employeeName|lee ann marie': 'T1|ID:E7' } }, sh, tg);
      assertEq_([again.items[0].status, again.items[0].note], ['SET', 'Matched as you chose before.'], 'next import: matched by the remembered choice');
      var amb = sheets(); amb[0].rows.push(person(8, 'E8', 'Cy Moe'));
      var a = planStaffImport_([['Name', 'Role'], ['Cy Moe', 'Agent']], { headerRow: 1, matchColumn: 0, matchField: 'employeeName', fills: [{ column: 1, field: 'role' }] }, amb, targets);
      assertEq_([a.items[0].status, a.items[0].suggestions.length], ['AMBIGUOUS', 2], 'two Cy Moe in one sheet: both offered to choose from');
    }],
    ['Staff import: people with a left-out role get nothing and are not offered as matches', function () {
      var sh = sheets();
      sh[0].rows[1].fields.role = 'Shift Lead';            // Bob Ray in Alpha
      sh[0].rows.push(person(9, 'E9', 'Ann Marie Lee', { role: 'support  shift lead, Trainer' }));
      var t = [['Name', 'Role'], ['Bob Ray', 'X'], ['Lee Ann Marie', 'Y'], ['Ann Lee', 'Z']];
      var p = planStaffImport_(t, { headerRow: 1, matchColumn: 0, matchField: 'employeeName', fills: [{ column: 1, field: 'role' }], excludeRoles: ['Shift Lead', 'Support Shift Lead'] }, sh, targets);
      assertEq_([p.items[0].status, p.items[0].note], ['EXCLUDED_ROLE', 'Left out: role "Shift Lead".']);
      assert_(!p.items[1].suggestions.some(function (s) { return s.ref === 'T1|ID:E9'; }), 'Ann Marie Lee (a support shift lead) is never suggested');
      assertEq_(p.items[2].changes.map(function (c) { return c.teamName; }), ['Alpha', 'Beta'], 'everyone else as usual');
      assertEq_([p.summary.excluded, p.people.some(function (x) { return x.label.indexOf('Bob Ray') === 0; })], [1, false]);
    }],
    ['Staff import: a 6000-row file against 300 staff stays fast', function () {
      var staff = [];
      for (var i = 0; i < 300; i++) staff.push(person(4 + i, 'E' + i, 'Person' + i + ' Family' + (i % 37)));
      var big = [['Identifier', 'Full name']];
      for (var j = 0; j < 6000; j++) big.push(['X' + j, j % 20 === 0 ? 'Person' + (j % 300) + ' Family' + ((j % 300) % 37) : 'Someone' + j + ' Else' + (j % 91)]);
      var t0 = new Date().getTime();
      var p = planStaffImport_(big, { headerRow: 1, matchColumn: 1, matchField: 'employeeName', fills: [{ column: 0, field: 'field:platform' }] },
        [{ teamId: 'T1', teamName: 'Alpha', keys: ['employeeId', 'employeeName', 'field:platform'], rows: staff }],
        targets.concat([{ key: 'field:platform', label: 'Platform ID', kind: 'IDENTIFIER', unique: true, fill: true }]));
      var ms = new Date().getTime() - t0;
      assertEq_(p.summary.rows, 6000);
      assert_(ms < 60000, '6000 rows took ' + ms + ' ms');
    }],
    ['Staff import: find people by Employee ID or email; values already used by someone else are refused; mapping is checked', function () {
      var byId = plan([['ID', 'Mail'], ['b9', 'bobby@x.com'], ['0123', 'ann@x.com']], { headerRow: 1, matchColumn: 0, matchField: 'employeeId', fills: [{ column: 1, field: 'email' }] });
      assertEq_([statusOf(byId).b9, statusOf(byId)['0123']], ['CONFLICT', 'NO_COLUMN'], 'IDs ignore capitals; Beta has no Email column');
      assertEq_(byId.summary.writes, 0, 'a different email is only replaced when chosen');
      assertEq_(plan([['ID', 'Mail'], ['b9', 'bobby@x.com']], { headerRow: 1, matchColumn: 0, matchField: 'employeeId', fills: [{ column: 1, field: 'email' }], overwrite: true }).summary.writes, 1, 'replacing is a choice');
      var byMail = plan([['Mail', 'Slack'], ['BOB@x.com', 'U5']], { headerRow: 1, matchColumn: 0, matchField: 'email', fills: [{ column: 1, field: 'field:slack' }] });
      assertEq_(statusOf(byMail)['BOB@x.com'], 'CONFLICT');
      var inUse = plan([['Name', 'Slack'], ['Ann Lee', 'u9']], { headerRow: 1, matchColumn: 0, matchField: 'employeeName', fills: [{ column: 1, field: 'field:slack' }] });
      assertEq_(inUse.items[0].changes[0].status, 'IN_USE', 'U9 already belongs to Bob in Alpha');
      assert_(plan(report, { headerRow: 2, matchColumn: 1, matchField: 'employeeName', fills: [] }).errors.length, 'something must be filled');
      assert_(plan(report, { headerRow: 2, matchColumn: 1, matchField: 'employeeName', fills: [{ column: 0, field: 'employeeName' }] }).errors.length, 'names are only for finding');
    }]
  ];
}

function runUnitTests() {
  return runTestList_('Unit tests', unitTests_().concat(unitTestsV11_()).concat(unitTestsV111_()).concat(unitTestsV112_())
    .concat(unitTestsStaffRouting_()).concat(unitTestsThemes_()).concat(unitTestsIdImport_()).concat(unitTestsSplitShifts_()).concat(unitTestsLinks_()).concat(unitTestsWebApp_()).concat(extensionUnitTests_()));
}

/** Tests of the extension files that are present (see smExtensions_). */
function extensionUnitTests_() {
  return smExtensions_().reduce(function (all, e) { return e.tests ? all.concat(e.tests()) : all; }, []);
}

/** Formula of a conditional-format rule (real Sheets rule or the test mock's record). */
function ruleFormula_(r) {
  if (r && r.formula) return r.formula;
  try { return r.getBooleanCondition().getCriteriaValues()[0]; } catch (e) { return ''; }
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
    ['Initialize a new spreadsheet', function () {
      var r = initializeSystem_();
      assert_(r.state.initialized && r.state.healthy, 'initialized and healthy');
      if (fresh) setConfigValues_({ TEST_MODE: 'TRUE' });
    }],
    ['Initialization is idempotent', function () {
      var before = ss.getSheets().length, cfgRows = readTable_(T_CONFIG).rows.length, types = listTeamTypes_(true).length;
      var r = initializeSystem_();
      assertEq_([ss.getSheets().length, readTable_(T_CONFIG).rows.length, listTeamTypes_(true).length], [before, cfgRows, types]);
      assert_(r.actions.join(' ').indexOf('Nothing was changed') >= 0 || r.actions.every(function (a) { return /Refreshed/.test(a); }), 'no structural changes: ' + r.actions.join(' | '));
    }],
    ['Create the first team', function () {
      var type = listTeamTypes_(false)[0];
      var r = createTeam_({ teamName: IT_PREFIX_ + 'Alpha', typeMode: 'EXISTING', teamTypeId: type.typeId, active: true, importAliases: 'ZZ-A' });
      ctx.teams.alpha = r.team;
      assertEq_(r.team.status, 'READY');
      assert_(resolveTeamSheet_(r.team, 'schedule') && resolveTeamSheet_(r.team, 'staff'), 'both sheets exist');
    }],
    ['Create a second team of the same type', function () {
      var r = createTeam_({ teamName: IT_PREFIX_ + 'Beta', typeMode: 'EXISTING', teamTypeId: ctx.teams.alpha.teamTypeId });
      ctx.teams.beta = r.team;
      assert_(r.team.teamId !== ctx.teams.alpha.teamId, 'distinct IDs');
    }],
    ['Create a team of a new type', function () {
      var r = createTeam_({ teamName: IT_PREFIX_ + 'Gamma', typeMode: 'NEW', newTypeName: IT_PREFIX_ + 'Type ' + Date.now(),
        scheduleFields: ['employeeName', 'start', 'end', 'flags'], display: { layout: 'CUSTOM' } });
      ctx.teams.gamma = r.team;
      ctx.newTypeId = r.team.teamTypeId;
      assert_(r.team.teamTypeId !== ctx.teams.alpha.teamTypeId, 'different type');
    }],
    ['Duplicate team names are rejected', function () {
      assertThrows_(function () { createTeam_({ teamName: (IT_PREFIX_ + 'alpha').toUpperCase(), typeMode: 'EXISTING', teamTypeId: ctx.teams.alpha.teamTypeId }); }, 'VALIDATION');
    }],
    ['Invalid sheet-name characters are sanitized', function () {
      var r = createTeam_({ teamName: IT_PREFIX_ + 'Delta: [Night]/Ops?', typeMode: 'EXISTING', teamTypeId: ctx.teams.alpha.teamTypeId });
      ctx.teams.delta = r.team;
      assert_(!/[\[\]\*\?\/\\:]/.test(r.team.scheduleSheet) && !/[\[\]\*\?\/\\:]/.test(r.team.staffSheet), 'no forbidden characters');
    }],
    ['Import a valid schedule (unknown employee, multi-shift, overnight)', function () {
      var staff = {};
      staff[STAFF_FIELD_DEFS.employeeId.label] = 'ZT1'; staff[STAFF_FIELD_DEFS.employeeName.label] = 'Test Ann';
      upsertStaff_(ctx.teams.alpha, staff, '');
      var csv = 'Employee ID,Employee Name,Date,Start,End,Activity\n' +
        'ZT1,Test Ann,2026-10-15,08:00,12:00,Phone\nZT1,Test Ann,2026-10-15,13:00,17:00,Chat\n' +
        'ZT9,Test Unknown,2026-10-15,22:00,06:00,Night\nZT1,Test Ann,2026-10-16,08:00,12:00,Phone';
      var r = itImport_(ctx, csv, ctx.teams.alpha.teamId, 'UPDATE');
      assertEq_([r.status, r.inserted], ['COMMITTED', 4]);
      var recs = queryScheduleRecords_({ teamIds: [ctx.teams.alpha.teamId] }).filter(function (x) { return x.recordStatus === 'ACTIVE'; });
      assertEq_(recs.length, 4);
      assert_(recs.some(function (x) { return x.shiftEnd === '2026-10-16 06:00'; }), 'overnight stored');
      var view = renderTeamView_(getTeam_(ctx.teams.alpha.teamId), { date: '2026-10-15' });
      assertEq_(view.shifts, 3);
    }],
    ['Re-import with different column order changes nothing', function () {
      var csv = 'Activity,End,Start,Date,Employee Name,Employee ID\n' +
        'Phone,12:00,08:00,2026-10-15,Test Ann,ZT1\nChat,17:00,13:00,2026-10-15,Test Ann,ZT1\n' +
        'Night,06:00,22:00,2026-10-15,Test Unknown,ZT9\nPhone,12:00,08:00,2026-10-16,Test Ann,ZT1';
      var r = itImport_(ctx, csv, ctx.teams.alpha.teamId, 'UPDATE');
      assertEq_([r.inserted, r.updated, r.unchanged], [0, 0, 4]);
    }],
    ['Update an existing schedule', function () {
      var csv = 'Employee ID,Employee Name,Date,Start,End,Activity,Role\nZT1,Test Ann,2026-10-15,13:00,17:00,Chat,Lead';
      var r = itImport_(ctx, csv, ctx.teams.alpha.teamId, 'UPDATE');
      assertEq_(r.updated, 1);
    }],
    ['Replace within range keeps records outside the range', function () {
      var csv = 'Employee ID,Employee Name,Date,Start,End,Activity\nZT1,Test Ann,2026-10-15,08:00,12:00,Phone';
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
    ['Invalid imports never write data', function () {
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
    ['standard, 24/7 and custom operating hours persist and render', function () {
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
    ['editing one setting preserves all others', function () {
      var t = getTeam_(ctx.teams.night.teamId);
      var before = stableStringify_(t.settings.import) + stableStringify_(t.settings.display) + t.importAliases;
      updateTeam_(t.teamId, { teamName: t.teamName, description: 'changed only this' });
      var after = getTeam_(t.teamId);
      assertEq_(stableStringify_(after.settings.import) + stableStringify_(after.settings.display) + after.importAliases, before);
      assertEq_(after.description, 'changed only this');
    }],
    ['migration of a v1.0 team is backward compatible and idempotent', function () {
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
    ['4 default columns; custom identifier added, renamed without data loss; leading zeros kept', function () {
      var team = getTeam_(ctx.teams.t247.teamId);
      var st = readStaff_(team);
      assertEq_(st.keys.filter(Boolean), ['employeeId', 'employeeName', 'role', 'notes']);
      var before = listStaffFields_().length;
      var f = saveStaffField_({ displayName: IT_PREFIX_ + 'Platform ID', fieldType: 'IDENTIFIER' }).field;
      ctx.fieldKeys = (ctx.fieldKeys || []).concat([f.fieldKey]);
      assertEq_(listStaffFields_().length, before + 1);
      setStaffFieldTeams_(f.fieldKey, [team.teamId]);
      team = getTeam_(team.teamId);
      var ref = 'field:' + f.fieldKey;
      var v = {};
      v['Employee ID'] = 'ZT100'; v['Employee Name'] = 'Test Zero'; v[f.displayName] = '000123';
      upsertStaff_(team, v, '');
      saveStaffField_({ fieldKey: f.fieldKey, displayName: IT_PREFIX_ + 'CRM', fieldType: 'IDENTIFIER' });
      relayoutAllStaffSheets_();
      var st2 = readStaff_(team);
      var row = st2.rows.filter(function (r) { return r.employeeId === 'ZT100'; })[0];
      assertEq_([row.fields[ref], st2.header[st2.keys.indexOf(ref)]], ['000123', IT_PREFIX_ + 'CRM']);
      var dup = {}; dup['Employee ID'] = 'ZT101'; dup['Employee Name'] = 'Test Dup'; dup[IT_PREFIX_ + 'CRM'] = '000123';
      assertThrows_(function () { upsertStaff_(team, dup, ''); }, 'VALIDATION');
      // Deleting the field without confirmation keeps the values as an ordinary column.
      deleteStaffField_(f.fieldKey, false, '');
      ctx.fieldKeys = [];
      var st3 = readStaff_(getTeam_(team.teamId));
      var col = st3.header.indexOf(IT_PREFIX_ + 'CRM');
      assert_(col >= 0 && st3.rows.filter(function (r) { return r.employeeId === 'ZT100'; })[0].values[IT_PREFIX_ + 'CRM'] === '000123', 'values kept after delete');
    }],
    ['Daily Schedule import with shift-type filtering, end to end', function () {
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
    ['Shared staff sheets are split: each team gets its own copy and IDs keep leading zeros', function () {
      var owner = getTeam_(ctx.teams.night.teamId);
      var staff = {}; staff['Employee ID'] = '007'; staff['Employee Name'] = 'Split One';
      upsertStaff_(owner, staff, '');
      var other = createTeam_({ teamName: IT_PREFIX_ + 'Shared', typeMode: 'EXISTING', teamTypeId: owner.teamTypeId }).team;
      ctx.teams.shared = other;
      other = getTeam_(other.teamId);
      // Simulate an older spreadsheet in which both teams use the owner's staff sheet.
      var ownSheet = resolveTeamSheet_(other, 'staff');
      other.settings.staffSheetId = owner.settings.staffSheetId; other.staffSheet = owner.staffSheet; saveTeamRow_(other);
      ss.deleteSheet(ownSheet);
      var msgs = splitSharedStaffSheets_();
      assertEq_(msgs.length, 1, msgs.join(' | '));
      other = getTeam_(other.teamId); owner = getTeam_(owner.teamId);
      assert_(String(other.settings.staffSheetId) !== String(owner.settings.staffSheetId), 'separate staff sheets');
      var copied = readStaff_(other).rows.filter(function (r) { return r.employeeName === 'Split One'; })[0];
      assertEq_(copied && copied.employeeId, '007', 'staff copied with the leading zeros');
      assertEq_(splitSharedStaffSheets_(), [], 'a second run changes nothing');
    }],
    ['Schedule Viewer renders with filters, stores them in the sheet, and meeting rows are shaded', function () {
      var team = getTeam_(ctx.teams.alpha.teamId);
      var res = apiViewerRender(team.teamId, '2026-10-15', { employee: '(All)', activity: '(All)', status: 'Has warnings' });
      assert_(res.ok, res.error && res.error.message);
      var v = res.data;
      assertEq_([v.date, v.filters.status, v.hoursMode, v.teamName], ['2026-10-15', 'Has warnings', team.settings.display.operatingHoursMode, team.teamName]);
      assert_(typeof v.summary.shifts === 'number' && v.shown <= v.shifts && v.statusOptions.indexOf('Meeting') >= 0, 'summary and filter options returned');
      var sh = resolveTeamSheet_(team, 'schedule');
      assertEq_(sh.getRange(VIEW.FILTER_ROW, VIEW.STATUS_COL).getValue(), 'Has warnings', 'filter stored in the status cell');
      assertEq_(apiViewerRender(team.teamId, '', { status: 'Nonsense' }).data.filters.status, '(All)', 'unknown status falls back to (All)');
      var kept = apiViewerRender(team.teamId, '', null).data;
      assertEq_(kept.date, '2026-10-15', 'empty date keeps the sheet date');
      var formulas = sh.getConditionalFormatRules().map(ruleFormula_);
      assert_(formulas.some(function (f) { return /^=LEFT\(\$[A-Z]+7,7\)="Meeting"$/.test(f); }), 'meeting row rule present: ' + formulas.join(' | '));
      assert_(!apiViewerRender('NO_SUCH_TEAM', '', null).ok, 'unknown team is refused');
    }],
    ['Recover from a missing team worksheet', function () {
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
  var req = { importId: importId, headerRow: insp.headerRow, fieldMap: insp.fieldMap, options: { dateOrder: 'AUTO' },
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
    var fieldRows = listStaffFields_().filter(function (f) { return f.displayName.indexOf(IT_PREFIX_) === 0; }).map(function (f) { return f._row; });
    if (fieldRows.length) deleteSheetRows_(requireSheet_(T_STAFF_FIELDS.sheet), fieldRows);
    rebuildSheetIndex_();
    rebuildDashboardSafe_();
    console.log('Integration test data cleaned up.');
  } catch (e) {
    logError_('itCleanup_', e);
    console.log('Cleanup failed — remove "' + IT_PREFIX_ + '" teams manually.');
  }
}
