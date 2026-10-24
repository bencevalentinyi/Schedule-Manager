/**
 * TaxiRequests.gs — optional extension (delete this file and TaxiDialog.html to remove it; nothing else changes).
 * Taxi request rule checks for a Slack workflow, without a Slack app, API calls or triggers:
 *
 *  - The Slack workflow adds each request to the request tab ("Add a row to a spreadsheet"), as it does today.
 *  - The rules (e.g. shift ends between 00:00 and 06:00; employed for less than 3 months, from the staff sheets'
 *    "employee since" column) are written as ONE live formula into the checks tab. It recalculates the moment the
 *    row is added; newest request first, one row per request: Row, Name, Result (OK / CHECK), Message, Employee since, Months.
 *  - The workflow reads it back with "Select a spreadsheet row" (checks tab, Name = the requester) and posts the
 *    Message in the request's thread, so the approver sees it before clicking Prebooked / Deny.
 *  - The request tab is never written to; the checks tab is rebuilt by "Save and apply" (and after staff
 *    sheets are added or their columns move).
 *
 * Settings: _CONFIG TAXI_SETTINGS (JSON). The same rules also run here (taxiEvaluate_) for the dialog's preview.
 * Dependencies: Utils.gs, ConfigService.gs, TeamService.gs (listTeams_), StaffService.gs (readStaff_), Schema.gs, Main.gs (showHtml_)
 */

var SM_EXTENSIONS = (typeof SM_EXTENSIONS !== 'undefined' && SM_EXTENSIONS) || [];
SM_EXTENSIONS.push({
  id: 'taxi', title: 'Taxi Requests',
  menu: [{ label: 'Taxi Request Rules', fn: 'menuTaxiRules' }],
  tests: function () { return taxiUnitTests_(); }
});

var TAXI_SETTINGS_KEY_ = 'TAXI_SETTINGS';
var TAXI_REQUEST_HEADERS = ['Date', 'SA Name', 'Team Lead', 'Address', 'Phone Number', 'Shift end', 'When the taxi should arrive',
  'Pet friendly', 'Booking done', 'Made by / Denied by', 'Reason'];
var TAXI_CHECK_HEADERS = ['Row', 'Name', 'Result', 'Message', 'Employee since', 'Months'];

/* ------------------------------------------------------------------------ */
/* Settings (pure)                                                           */
/* ------------------------------------------------------------------------ */

/** Settings with defaults. Pure. */
function normalizeTaxiSettings_(s) {
  s = s || {};
  var r = s.rules || {}, se = r.shiftEnd || {}, te = r.tenure || {};
  var hm = function (v, d) { var m = hmToMinutes_(str_(v)); return m === null ? d : minutesToHm_(m % 1440); };
  return {
    requestTab: str_(s.requestTab) || 'Taxi Requests',
    checksTab: str_(s.checksTab) || 'Taxi Checks',
    nameColumn: str_(s.nameColumn) || 'SA Name',
    shiftEndColumn: str_(s.shiftEndColumn) || 'Shift end',
    arrivalColumn: str_(s.arrivalColumn) || 'When the taxi should arrive',
    staffMatch: str_(s.staffMatch) || 'employeeName',
    sinceField: str_(s.sinceField),
    rules: {
      shiftEnd: { on: se.on !== false, from: hm(se.from, '00:00'), to: hm(se.to, '06:00') },
      tenure: { on: te.on !== false, months: Math.max(1, Math.floor(toNumber_(te.months, 3))) }
    },
    okText: s.okText !== undefined ? str_(s.okText) : '✅ All taxi rules are met.',
    failText: s.failText !== undefined ? str_(s.failText) : '⚠️ Check before approving:'
  };
}

function validateTaxiSettings_(s) {
  var errors = [];
  if (s.requestTab === s.checksTab) errors.push('The checks tab must be a different tab than the requests.');
  if (s.rules.tenure.on && !s.sinceField) errors.push('Choose the staff column with the employee-since date (or switch the employment rule off).');
  if (s.rules.shiftEnd.on && s.rules.shiftEnd.from === s.rules.shiftEnd.to) errors.push('The shift end window starts and ends at the same time.');
  return errors;
}

function taxiRuleTexts_(s) {
  var out = [];
  if (s.rules.shiftEnd.on) out.push('Shift ends between ' + s.rules.shiftEnd.from + ' and ' + s.rules.shiftEnd.to);
  if (s.rules.tenure.on) out.push('Employed for less than ' + s.rules.tenure.months + ' months');
  return out;
}

/* ------------------------------------------------------------------------ */
/* Rules in JavaScript (pure; the dialog preview)                            */
/* ------------------------------------------------------------------------ */

/** Shift end text or Date → minutes after 00:00, or null. "00:30", "0.30", "12:30 AM", "1:15 pm", a Date. Pure. */
function taxiTimeMinutes_(v, tz) {
  if (isDate_(v)) return hmToMinutes_(Utilities.formatDate(v, tz, 'HH:mm')) % 1440;
  var m = /(\d{1,2})[:.](\d{2})\s*(am|pm)?|(\d{1,2})\s*(am|pm)/.exec(str_(v).toLowerCase());
  if (!m) return null;
  var h = +(m[1] || m[4]), mi = +(m[2] || 0), ap = m[3] || m[5] || '';
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (h > 24 || mi > 59) return null;
  return (h * 60 + mi) % 1440;
}

function taxiInWindow_(min, fromHm, toHm) {
  var f = hmToMinutes_(fromHm), t = hmToMinutes_(toHm);
  return f <= t ? min >= f && min <= t : min >= f || min <= t;
}

/** Whole months from one ISO date to another (DATEDIF "M"), or -1. Pure. */
function taxiMonths_(fromIso, toIso) {
  if (!isIsoDate_(fromIso) || !isIsoDate_(toIso) || fromIso > toIso) return -1;
  var a = fromIso.split('-').map(Number), b = toIso.split('-').map(Number);
  return (b[0] - a[0]) * 12 + (b[1] - a[1]) - (b[2] < a[2] ? 1 : 0);
}

/**
 * One request against the rules (the same rules as the sheet formula). Pure.
 * @param {{name, shiftEnd, arrival}} req
 * @param {Object<string, string>} sinceByName normText_(name) → employee-since ISO date ('' when the column is empty)
 * @return {{result: 'OK'|'CHECK', message: string, problems: string[], since: string, months: number|string}}
 */
function taxiEvaluate_(req, sinceByName, s, todayIso, tz) {
  var problems = [];
  if (s.rules.shiftEnd.on) {
    var m = taxiTimeMinutes_(req.shiftEnd, tz);
    if (m === null) problems.push('Shift end not understood');
    else if (!taxiInWindow_(m, s.rules.shiftEnd.from, s.rules.shiftEnd.to)) {
      problems.push('Shift ends ' + minutesToHm_(m) + ' (taxi only for shifts ending ' + s.rules.shiftEnd.from + '–' + s.rules.shiftEnd.to + ')');
    }
  }
  var key = normText_(req.name), found = Object.prototype.hasOwnProperty.call(sinceByName, key);
  var since = found ? sinceByName[key] : '', months = '';
  if (s.rules.tenure.on) {
    var ref = isDate_(req.arrival) ? Utilities.formatDate(req.arrival, tz, 'yyyy-MM-dd') : (cellToIsoDate_(req.arrival, tz) || todayIso);
    var n = taxiMonths_(since, ref);
    if (!found) problems.push('Not found in the staff sheets');
    else if (n < 0) problems.push('Employee since date missing');
    else {
      months = n;
      if (n >= s.rules.tenure.months) problems.push('Employed ' + n + ' months (taxi only under ' + s.rules.tenure.months + ' months)');
    }
  }
  return {
    result: problems.length ? 'CHECK' : 'OK', problems: problems, since: since, months: months,
    message: problems.length ? (s.failText ? s.failText + ' ' : '') + problems.join('; ') : s.okText
  };
}

/* ------------------------------------------------------------------------ */
/* The sheet formula (pure)                                                  */
/* ------------------------------------------------------------------------ */

function taxiSheetRef_(name) {
  return "'" + String(name).replace(/'/g, "''") + "'";
}

function taxiText_(s) {
  return '"' + String(s).replace(/"/g, '""') + '"';
}

function taxiTimeExpr_(hm) {
  var m = hmToMinutes_(hm);
  return 'TIME(' + Math.floor(m / 60) + ',' + (m % 60) + ',0)';
}

/**
 * The checks tab's formula (cell A1; English function names, as Apps Script writes formulas). Pure.
 * @param {Object} s normalized settings
 * @param {{name: string, shiftEnd: string, arrival: string}} cols column letters in the request tab
 * @param {Array<{sheet: string, key: string, since: string, firstRow: number}>} staff staff sheets and their column letters
 */
function buildTaxiFormula_(s, cols, staff) {
  var R = taxiSheetRef_(s.requestTab);
  var col = function (letter) { return R + '!' + letter + '2:' + letter; };
  var staffTbl = staff.length
    ? '{' + staff.map(function (x) {
      var q = taxiSheetRef_(x.sheet);
      return q + '!' + x.key + x.firstRow + ':' + x.key + ',' + q + '!' + x.since + x.firstRow + ':' + x.since;
    }).join(';') + '}'
    : '{"",""}';
  var parts = [];
  if (s.rules.shiftEnd.on) {
    var f = taxiTimeExpr_(s.rules.shiftEnd.from), t = taxiTimeExpr_(s.rules.shiftEnd.to);
    var inside = hmToMinutes_(s.rules.shiftEnd.from) <= hmToMinutes_(s.rules.shiftEnd.to)
      ? '(endT>=' + f + ')*(endT<=' + t + ')' : '(endT>=' + f + ')+(endT<=' + t + ')';
    parts.push('IF(endT<0,' + taxiText_('Shift end not understood; ') + ',IF(' + inside + ',"",' + taxiText_('Shift ends ') +
      '&TEXT(endT,"hh:mm")&' + taxiText_(' (taxi only for shifts ending ' + s.rules.shiftEnd.from + '–' + s.rules.shiftEnd.to + '); ') + '))');
  }
  if (s.rules.tenure.on) {
    var n = s.rules.tenure.months;
    parts.push('IF(NOT(found),' + taxiText_('Not found in the staff sheets; ') + ',IF(tenure<0,' + taxiText_('Employee since date missing; ') +
      ',IF(tenure<' + n + ',"",' + taxiText_('Employed ') + '&tenure&' + taxiText_(' months (taxi only under ' + n + ' months); ') + ')))');
  }
  var msg = parts.length ? parts.join('&') : '""';
  var fail = s.failText ? taxiText_(s.failText + ' ') + '&' : '';
  return '=ARRAYFORMULA(LET(' + [
    'reqName,' + col(cols.name),
    'shiftEnd,' + col(cols.shiftEnd),
    'arrival,' + col(cols.arrival),
    'rowNo,ROW(' + col(cols.name) + ')',
    'staffTbl,' + staffTbl,
    'staffKey,LOWER(TRIM(INDEX(staffTbl,,1)))',
    'reqKey,LOWER(TRIM(reqName))',
    'found,ISNUMBER(MATCH(reqKey,staffKey,0))',
    'since,IFERROR(VLOOKUP(reqKey,{staffKey,INDEX(staffTbl,,2)},2,FALSE),"")',
    'endT,IFERROR(MOD(IF(ISNUMBER(shiftEnd),shiftEnd,TIMEVALUE(SUBSTITUTE(shiftEnd,".",":"))),1),-1)',
    'refDay,IFERROR(INT(IF(ISNUMBER(arrival),arrival,DATEVALUE(LEFT(arrival,10)))),TODAY())',
    'tenure,IF(since="",-1,IFERROR(DATEDIF(since,refDay,"M"),-1))',
    'msg,' + msg,
    'out,{rowNo,reqName,IF(msg="","OK","CHECK"),IF(msg="",' + taxiText_(s.okText) + ',' + fail + 'LEFT(msg,LEN(msg)-2)),' +
      'IF(since="","",TEXT(since,"yyyy-mm-dd")),IF(tenure<0,"",tenure)}',
    'VSTACK({' + TAXI_CHECK_HEADERS.map(taxiText_).join(',') + '},IFERROR(SORT(FILTER(out,reqName<>""),1,FALSE),{' +
      TAXI_CHECK_HEADERS.map(function () { return '""'; }).join(',') + '}))'
  ].join(',') + '))';
}

/** Header text → column letter in a header row (exact, ignoring case/punctuation), or ''. Pure. */
function taxiColumnLetter_(headers, wanted) {
  var w = normText_(wanted);
  for (var i = 0; i < headers.length; i++) if (w && normText_(headers[i]) === w) return columnLetter_(i + 1);
  return '';
}

/* ------------------------------------------------------------------------ */
/* Sheets                                                                    */
/* ------------------------------------------------------------------------ */

function getTaxiSettings_() {
  return normalizeTaxiSettings_(parseJson_(getConfig_()[TAXI_SETTINGS_KEY_], {}));
}

function taxiHeaders_(tabName) {
  var sh = getSs_().getSheetByName(tabName);
  if (!sh || sh.getLastColumn() < 1) return null;
  return sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(str_);
}

/** Each ready team's staff sheet with the match and employee-since columns (teams without them are listed in `missing`). */
function taxiStaffSources_(s) {
  var out = { sources: [], missing: [], sinceByName: {}, fields: [] };
  var seen = {}, tz = getTz_();
  listTeams_().filter(function (t) { return t.status === TEAM_STATUS.READY; }).forEach(function (team) {
    var st;
    try { st = readStaff_(team); } catch (e) { out.missing.push(team.teamName + ' (staff sheet cannot be read)'); return; }
    st.keys.forEach(function (k, i) {
      if (k && st.header[i] && !seen[k]) { seen[k] = true; out.fields.push({ key: k, label: st.header[i] }); }
    });
    var iKey = st.keys.indexOf(s.staffMatch), iSince = st.keys.indexOf(s.sinceField);
    if (iKey < 0 || (s.rules.tenure.on && iSince < 0)) { out.missing.push(team.teamName); return; }
    out.sources.push({ sheet: st.sheet.getName(), key: columnLetter_(iKey + 1), since: columnLetter_((iSince < 0 ? iKey : iSince) + 1), firstRow: STAFF_LAYOUT.FIRST_DATA_ROW });
    st.rows.forEach(function (r) {
      var name = s.staffMatch === 'employeeName' ? r.employeeName : str_(r.fields[s.staffMatch]);
      var k = normText_(name);
      // Real dates (or yyyy-MM-dd text) only, as the sheet's DATEDIF: other text shows as "date missing" in both.
      if (k && !Object.prototype.hasOwnProperty.call(out.sinceByName, k)) out.sinceByName[k] = iSince < 0 ? '' : cellToIsoDate_(r.fields[s.sinceField], tz);
    });
  });
  return out;
}

/** The request tab's column letters for the settings, or a validation error. */
function taxiRequestColumns_(s) {
  var headers = taxiHeaders_(s.requestTab);
  if (!headers) fail_('NOT_FOUND', 'The tab "' + s.requestTab + '" does not exist or has no header row.');
  var cols = { name: taxiColumnLetter_(headers, s.nameColumn), shiftEnd: taxiColumnLetter_(headers, s.shiftEndColumn), arrival: taxiColumnLetter_(headers, s.arrivalColumn) };
  var missing = [];
  if (!cols.name) missing.push(s.nameColumn);
  if (!cols.shiftEnd) missing.push(s.shiftEndColumn);
  if (!cols.arrival) missing.push(s.arrivalColumn);
  if (missing.length) fail_('VALIDATION', 'The tab "' + s.requestTab + '" has no column ' + missing.map(function (m) { return '"' + m + '"'; }).join(', ') + '.');
  return cols;
}

/** Writes the formula into the checks tab (created when missing; it holds nothing else). */
function applyTaxiChecks_(s) {
  var cols = taxiRequestColumns_(s);
  var staff = taxiStaffSources_(s);
  var ss = getSs_();
  var sh = ss.getSheetByName(s.checksTab) || ss.insertSheet(s.checksTab);
  sh.clear();
  sh.getRange(1, 1).setFormula(buildTaxiFormula_(s, cols, staff.sources));
  sh.getRange(1, 1, 1, TAXI_CHECK_HEADERS.length).setFontWeight('bold');
  sh.setFrozenRows(1);
  sh.setColumnWidth(4, 420);
  return { sheetUrl: sheetLink_(sh), teams: staff.sources.length, missingTeams: staff.missing };
}

/* ------------------------------------------------------------------------ */
/* APIs                                                                      */
/* ------------------------------------------------------------------------ */

function menuTaxiRules() {
  menuRun_('menuTaxiRules', function () { showHtml_('TaxiDialog', 'Taxi Request Rules', {}, DIALOG_SIZE.LARGE); });
}

function apiTaxiBootstrap() {
  return apiCall_('apiTaxiBootstrap', function () {
    requireInitialized_();
    var s = getTaxiSettings_();
    var staff = taxiStaffSources_(s);
    var fields = [{ key: 'employeeName', label: 'Employee Name' }].concat(staff.fields.filter(function (f) { return f.key !== 'employeeName'; }));
    return {
      settings: s, tabs: getSs_().getSheets().map(function (x) { return x.getName(); }).filter(function (n) { return n.charAt(0) !== '_'; }),
      headers: taxiHeaders_(s.requestTab) || [], staffFields: fields, requestHeaders: TAXI_REQUEST_HEADERS, checkHeaders: TAXI_CHECK_HEADERS
    };
  });
}

function apiTaxiHeaders(tab) {
  return apiCall_('apiTaxiHeaders', function () { return taxiHeaders_(str_(tab)) || []; });
}

/** Creates the request tab with the usual headers (for a new setup; an existing tab is never changed). */
function apiTaxiCreateRequestTab(tab) {
  return apiCall_('apiTaxiCreateRequestTab', function () {
    return withLock_(function () {
      var name = str_(tab) || 'Taxi Requests';
      if (getSs_().getSheetByName(name)) fail_('VALIDATION', 'The tab "' + name + '" already exists.');
      var sh = getSs_().insertSheet(name);
      sh.getRange(1, 1, 1, TAXI_REQUEST_HEADERS.length).setValues([TAXI_REQUEST_HEADERS]).setFontWeight('bold');
      sh.setFrozenRows(1);
      return { tab: name, headers: TAXI_REQUEST_HEADERS };
    });
  });
}

/** The newest requests against the (unsaved) settings, checked here — what the sheet formula will show. */
function apiTaxiPreview(settings) {
  return apiCall_('apiTaxiPreview', function () {
    var s = normalizeTaxiSettings_(settings);
    var cols = taxiRequestColumns_(s);
    var staff = taxiStaffSources_(s);
    var sh = getSs_().getSheetByName(s.requestTab), tz = getTz_(), today = todayIso_(tz);
    var last = sh.getLastRow(), rows = [];
    if (last >= 2) {
      var first = Math.max(2, last - 24);
      var values = sh.getRange(first, 1, last - first + 1, sh.getLastColumn()).getValues();
      var at = function (row, letter) { return row[columnNumber_(letter) - 1]; };
      for (var i = values.length - 1; i >= 0; i--) {
        var req = { name: str_(at(values[i], cols.name)), shiftEnd: at(values[i], cols.shiftEnd), arrival: at(values[i], cols.arrival) };
        if (!req.name) continue;
        var e = taxiEvaluate_(req, staff.sinceByName, s, today, tz);
        rows.push({ row: first + i, name: req.name, shiftEnd: isDate_(req.shiftEnd) ? Utilities.formatDate(req.shiftEnd, tz, 'HH:mm') : str_(req.shiftEnd),
          arrival: isDate_(req.arrival) ? Utilities.formatDate(req.arrival, tz, 'yyyy-MM-dd HH:mm') : str_(req.arrival),
          result: e.result, message: e.message, since: e.since, months: e.months });
      }
    }
    return { rows: rows, rules: taxiRuleTexts_(s), missingTeams: staff.missing, errors: validateTaxiSettings_(s) };
  });
}

function apiTaxiSave(settings) {
  return apiCall_('apiTaxiSave', function () {
    var s = normalizeTaxiSettings_(settings);
    var errors = validateTaxiSettings_(s);
    if (errors.length) fail_('VALIDATION', errors.join(' '));
    return withLock_(function () {
      var res = applyTaxiChecks_(s);
      var u = {};
      u[TAXI_SETTINGS_KEY_] = JSON.stringify(s);
      setConfigValues_(u);
      res.settings = s;
      return res;
    });
  });
}

/* ------------------------------------------------------------------------ */
/* Tests                                                                     */
/* ------------------------------------------------------------------------ */

function taxiUnitTests_() {
  var tz = 'UTC';
  var s = normalizeTaxiSettings_({ sinceField: 'reg:since' });
  return [
    ['Taxi: settings defaults and validation', function () {
      assertEq_([s.rules.shiftEnd.from, s.rules.shiftEnd.to, s.rules.tenure.months, s.checksTab], ['00:00', '06:00', 3, 'Taxi Checks']);
      assertEq_(validateTaxiSettings_(normalizeTaxiSettings_({})).length, 1, 'the employment rule needs the employee-since column');
      assertEq_(validateTaxiSettings_(normalizeTaxiSettings_({ rules: { tenure: { on: false } } })), []);
    }],
    ['Taxi: shift end times in the usual forms', function () {
      assertEq_(['00:30', '0.30', '12:30 AM', '1:15 pm', '2am', '23:45', 'late'].map(function (v) { return taxiTimeMinutes_(v, tz); }),
        [30, 30, 30, 795, 120, 1425, null]);
      assertEq_([taxiInWindow_(30, '00:00', '06:00'), taxiInWindow_(1425, '00:00', '06:00'), taxiInWindow_(1425, '23:00', '06:00'), taxiInWindow_(420, '23:00', '06:00')],
        [true, false, true, false], 'a window may cross midnight');
    }],
    ['Taxi: months employed (like DATEDIF "M")', function () {
      assertEq_([taxiMonths_('2026-07-24', '2026-10-24'), taxiMonths_('2026-07-25', '2026-10-24'), taxiMonths_('2026-11-01', '2026-10-24'), taxiMonths_('', '2026-10-24')], [3, 2, -1, -1]);
    }],
    ['Taxi: a request passes or lists every failed rule', function () {
      var since = { 'ann lee': '2026-09-01', 'bob': '2025-01-01', 'cid': '' };
      var ok = taxiEvaluate_({ name: 'Ann  Lee', shiftEnd: '00:30', arrival: '2026-10-25 00:45' }, since, s, '2026-10-24', tz);
      assertEq_([ok.result, ok.message, ok.months], ['OK', '✅ All taxi rules are met.', 1]);
      var bad = taxiEvaluate_({ name: 'Bob', shiftEnd: '22:00', arrival: '' }, since, s, '2026-10-24', tz);
      assertEq_([bad.result, bad.message], ['CHECK', '⚠️ Check before approving: Shift ends 22:00 (taxi only for shifts ending 00:00–06:00); Employed 21 months (taxi only under 3 months)']);
      assertEq_([taxiEvaluate_({ name: 'Dan', shiftEnd: '01:00' }, since, s, '2026-10-24', tz).problems, taxiEvaluate_({ name: 'cid', shiftEnd: '01:00' }, since, s, '2026-10-24', tz).problems],
        [['Not found in the staff sheets'], ['Employee since date missing']]);
    }],
    ['Taxi: the sheet formula uses the chosen columns, staff sheets and rules', function () {
      var f = buildTaxiFormula_(s, { name: 'B', shiftEnd: 'F', arrival: 'G' }, [{ sheet: "Team A's Staff", key: 'B', since: 'H', firstRow: 4 }, { sheet: 'B Staff', key: 'C', since: 'E', firstRow: 4 }]);
      assert_(f.indexOf("reqName,'Taxi Requests'!B2:B") > 0, 'request column');
      assert_(f.indexOf("staffTbl,{'Team A''s Staff'!B4:B,'Team A''s Staff'!H4:H;'B Staff'!C4:C,'B Staff'!E4:E}") > 0, 'staff sheets stacked, quotes escaped');
      assert_(f.indexOf('(endT>=TIME(0,0,0))*(endT<=TIME(6,0,0))') > 0, 'window inside one day');
      assert_(f.indexOf('IF(tenure<3,""') > 0, 'months rule');
      var night = buildTaxiFormula_(normalizeTaxiSettings_({ sinceField: 'x', rules: { shiftEnd: { from: '23:00', to: '06:00' }, tenure: { on: false } } }), { name: 'B', shiftEnd: 'F', arrival: 'G' }, []);
      assert_(night.indexOf('(endT>=TIME(23,0,0))+(endT<=TIME(6,0,0))') > 0 && night.indexOf('months (taxi only under') < 0 && night.indexOf('staffTbl,{"",""}') > 0, 'crossing midnight; rule off; no staff');
      var opens = (f.match(/\(/g) || []).length, closes = (f.match(/\)/g) || []).length;
      assertEq_(opens, closes, 'balanced parentheses');
    }],
    ['Taxi: request columns found by header text', function () {
      assertEq_([taxiColumnLetter_(TAXI_REQUEST_HEADERS, 'sa name'), taxiColumnLetter_(TAXI_REQUEST_HEADERS, 'When the taxi should arrive?'), taxiColumnLetter_(TAXI_REQUEST_HEADERS, 'Nope')], ['B', 'G', '']);
    }]
  ];
}
