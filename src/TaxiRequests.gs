/**
 * TaxiRequests.gs — optional extension (delete this file and TaxiDialog.html to remove it; nothing else changes).
 * Taxi request rule checks for a Slack workflow, without a Slack app, API calls or triggers:
 *
 *  - The Slack workflow adds each request to the request tab ("Add a row to a spreadsheet"), as it does today.
 *  - The rules (e.g. shift ends between 00:00 and 06:00; employed for less than 3 months, from the staff sheets'
 *    "employee since" column) are written as ONE live formula into the checks tab. It recalculates the moment the
 *    row is added; newest request first, one row per request: Row, the request ID (e.g. "Date ID"), Name,
 *    Result (OK / CHECK), Message, Employee since, Months.
 *  - The workflow reads it back with "Select a spreadsheet row" (checks tab, the ID column = the value it wrote, e.g.
 *    "Time when workflow started") and posts the Message in the request's thread, so the approver sees it before
 *    clicking Prebooked / Deny. Without an ID column it searches by Name (the newest request of that person).
 *  - The request tab's values are never changed; only "Clear old requests" (Requests tab, or Maintenance → Clear Old
 *    Taxi Requests) removes old rows, by default after copying them into an archive tab. The checks tab is rebuilt
 *    by "Save and apply" (and after staff sheets are added or their columns move).
 *
 * Settings: _CONFIG TAXI_SETTINGS (JSON). The same rules also run here (taxiEvaluate_) for the dialog's preview.
 * Dependencies: Utils.gs, ConfigService.gs, TeamService.gs (listTeams_), StaffService.gs (readStaff_), Schema.gs, Main.gs (showHtml_)
 */

var SM_EXTENSIONS = (typeof SM_EXTENSIONS !== 'undefined' && SM_EXTENSIONS) || [];
SM_EXTENSIONS.push({
  id: 'taxi', title: 'Taxi Requests',
  menu: [{ label: 'Taxi Request Rules', fn: 'menuTaxiRules' }],
  maintenance: [{ label: 'Clear Old Taxi Requests', fn: 'menuTaxiClear' }],
  // Web app page (only while this file is present): the same page as the dialog, with the request list.
  webPages: { taxi: { file: 'TaxiDialog', title: 'Taxi Requests', nav: 'Taxi', prefetch: function () { return [['apiTaxiBootstrap']]; } } },
  // Repair Formatting and a theme change restyle the checks tab too.
  repairFormatting: function () { return taxiRepairFormatting_(); },
  tests: function () { return taxiUnitTests_(); }
});

var TAXI_SETTINGS_KEY_ = 'TAXI_SETTINGS';
var TAXI_REQUEST_HEADERS = ['Date ID', 'Date', 'SA Name', 'Team Lead', 'Address', 'Phone Number', 'Shift end', 'When the taxi should arrive',
  'Pet friendly', 'Booking done', 'Made by / Denied by', 'Reason'];

/**
 * The checks tab's headers: Row, the ID column (named as in the request tab), Name, the booking column, Result, … Pure.
 * @param {{id?: string, booking?: string}=} cols the columns found in the request tab (default: the ones set)
 */
function taxiCheckHeaders_(s, cols) {
  var withId = cols ? !!cols.id : !!s.idColumn, withBooking = cols ? !!cols.booking : !!s.bookingColumn;
  return ['Row'].concat(withId ? [s.idColumn] : []).concat(['Name']).concat(withBooking ? [s.bookingColumn] : [])
    .concat(['Result', 'Message', 'Employee since', 'Months']);
}

/**
 * A booking cell → PENDING (empty or an unticked box), DENIED (it, or one of the other cells, contains one of the
 * denied words) or BOOKED. A Slack "Deny" button may write the name of who clicked into the booking column and
 * DENIED into the time columns, so those are passed as others. Pure.
 */
function taxiBookingStatus_(v, deniedWords, others) {
  var words = String(deniedWords || '').split(',').map(normText_).filter(Boolean);
  var has = function (x) { var t = ' ' + normText_(x === false ? '' : x) + ' '; return words.some(function (w) { return t.indexOf(' ' + w) >= 0; }); };
  if (has(v) || (others || []).some(function (x) { return !isDate_(x) && has(x); })) return 'DENIED';
  var t = normText_(v === false ? '' : v);
  return !t || t === 'false' ? 'PENDING' : 'BOOKED';
}

/** The sheet's version of taxiBookingStatus_'s DENIED: TRUE when any of the cells contains a denied word. Pure. */
function taxiDeniedExpr_(s, cells) {
  var words = String(s.deniedWords || '').split(',').map(normText_).filter(Boolean);
  if (!words.length || !cells.length) return 'FALSE';
  var t = '" "&' + cells.map(function (c) { return 'TO_TEXT(' + c + ')'; }).join('&" "&');
  return '((' + words.map(function (w) { return 'ISNUMBER(SEARCH(' + taxiText_(' ' + w) + ',' + t + '))'; }).join('+') + ')>0)';
}

var TAXI_EMAIL_DEFAULTS = {
  intro: 'Hi,\n\nPlease book the following taxis for {taxi date}:\n',
  item: '{n}. {time} – {SA Name}\nAddress: {Address}\nPhone: {Phone Number}\nPet friendly: {Pet friendly}',
  outro: '\nThank you!'
};

/** The failed-rule messages: default text and the {placeholders} it can use. */
var TAXI_TEXTS = {
  shiftEndFail: { label: 'Shift ends outside the window', text: 'Shift ends {end} (taxi only for shifts ending {from}–{to})', vars: ['end', 'from', 'to'] },
  shiftEndUnknown: { label: 'Shift end not readable', text: 'Shift end not understood', vars: [] },
  arrivalFail: { label: 'Taxi not right after the shift', text: 'Taxi at {arrival} but the shift ends {end} (taxi up to {after} min after the shift end)', vars: ['arrival', 'end', 'before', 'after'] },
  arrivalUnknown: { label: 'Taxi time not readable', text: 'Taxi arrival time not understood', vars: [] },
  tenureFail: { label: 'Employed too long', text: 'Employed {months} months (taxi only under {max} months)', vars: ['months', 'max'] },
  notFound: { label: 'Not in any staff sheet', text: 'Not found in the staff sheets', vars: [] },
  sinceMissing: { label: 'No employee-since date', text: 'Employee since date missing', vars: [] }
};
/** How several failed rules are joined (LINE: each on its own line). */
var TAXI_SEPARATORS = {
  SEMI: { label: 'Semicolon ( ; )', text: '; ' }, LINE: { label: 'Each on a new line', text: '\n' },
  DOT: { label: 'Dot ( · )', text: ' · ' }, COMMA: { label: 'Comma ( , )', text: ', ' }
};

/* ------------------------------------------------------------------------ */
/* Settings (pure)                                                           */
/* ------------------------------------------------------------------------ */

/** Settings with defaults. Pure. */
function normalizeTaxiSettings_(s) {
  s = s || {};
  var r = s.rules || {}, se = r.shiftEnd || {}, te = r.tenure || {}, ar = r.arrival || {}, t = s.texts || {}, em = s.email || {}, au = em.auto || {};
  var hm = function (v, d) { var m = hmToMinutes_(str_(v)); return m === null ? d : minutesToHm_(m % 1440); };
  var mins = function (v, d) { return Math.min(720, Math.max(0, Math.floor(toNumber_(v, d)))); };
  return {
    requestTab: str_(s.requestTab) || 'Taxi Requests',
    checksTab: str_(s.checksTab) || 'Taxi Checks',
    // The column that identifies one request (the workflow writes "Time when workflow started"); '' = none.
    idColumn: s.idColumn === undefined ? 'Date ID' : str_(s.idColumn),
    nameColumn: str_(s.nameColumn) || 'SA Name',
    shiftEndColumn: str_(s.shiftEndColumn) || 'Shift end',
    arrivalColumn: str_(s.arrivalColumn) || 'When the taxi should arrive',
    staffMatch: str_(s.staffMatch) || 'employeeName',
    sinceField: str_(s.sinceField),
    // Empty = not decided yet: those come first in the checks tab, colored. '' = no booking column.
    bookingColumn: s.bookingColumn === undefined ? 'Booking done' : str_(s.bookingColumn),
    deniedWords: str_(s.deniedWords) || 'deny, denied, rejected',
    // The day view: a tab with a date cell, like the daily schedule ('' = no day view). A taxi day runs from dayStart
    // to dayStart, so a 00:15 taxi after a late shift belongs to the evening before; the email text uses the same day.
    dayTab: s.dayTab === undefined ? 'Taxi Day' : str_(s.dayTab),
    dayStart: hm(s.dayStart, '06:00'),
    dayColumns: (Array.isArray(s.dayColumns) ? s.dayColumns : ['Address', 'Phone Number', 'Pet friendly']).map(str_).filter(Boolean),
    // The email text: intro, one block per taxi, outro. {Any column name} and {date} {taxi date} {next day} {count}
    // {n} {time} are filled in.
    email: {
      include: em.include === 'BOOKED' ? 'BOOKED' : 'NOT_DENIED',
      intro: em.intro !== undefined ? String(em.intro) : TAXI_EMAIL_DEFAULTS.intro,
      item: str_(em.item) ? String(em.item) : TAXI_EMAIL_DEFAULTS.item,
      outro: em.outro !== undefined ? String(em.outro) : TAXI_EMAIL_DEFAULTS.outro,
      // Kept up to date for a Slack workflow: taxiEmailTick (on a time-driven trigger the user adds) writes today's
      // email text into one row of this tab while the time is inside from–to; the workflow reads the row where Key = key.
      auto: { on: au.on === true, tab: str_(au.tab) || 'Taxi Email', key: str_(au.key) || 'tonight', from: hm(au.from, '04:30'), to: hm(au.to, '22:00') }
    },
    rules: {
      shiftEnd: { on: se.on !== false, from: hm(se.from, '00:00'), to: hm(se.to, '06:00') },
      tenure: { on: te.on !== false, months: Math.max(1, Math.floor(toNumber_(te.months, 3))) },
      // The taxi arrives from `before` minutes before to `after` minutes after the shift end (across midnight too).
      arrival: { on: ar.on !== false, before: mins(ar.before, 0), after: mins(ar.after, 60) }
    },
    okText: s.okText !== undefined ? str_(s.okText) : '✅ All taxi rules are met.',
    failText: s.failText !== undefined ? str_(s.failText) : '⚠️ Check before approving:',
    // One message per failed rule; {placeholders} are filled in (see TAXI_TEXTS). Empty = the default.
    texts: Object.keys(TAXI_TEXTS).reduce(function (o, k) { o[k] = str_(t[k]) || TAXI_TEXTS[k].text; return o; }, {}),
    separator: TAXI_SEPARATORS[s.separator] ? s.separator : 'SEMI'
  };
}

/** A typed "\n" in a message is a line break (a text box cannot hold real ones). Pure. */
function taxiNl_(s) {
  return String(s).replace(/\\n/g, '\n');
}

/** Fills {placeholders} of a message from vars (unknown ones stay as written); "\n" becomes a line break. Pure. */
function taxiFill_(tpl, vars) {
  return taxiNl_(tpl).replace(/\{(\w+)\}/g, function (all, k) { return Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : all; });
}

/** What follows the "before the failed rules" text: a new line when the rules are on lines, else a space. Pure. */
function taxiFailPrefix_(s) {
  if (!s.failText) return '';
  var p = taxiNl_(s.failText);
  return /\n$/.test(p) ? p : p + (s.separator === 'LINE' ? '\n' : ' ');
}

function validateTaxiSettings_(s) {
  var errors = [];
  if (s.requestTab === s.checksTab) errors.push('The checks tab must be a different tab than the requests.');
  if (s.dayTab && (s.dayTab === s.requestTab || s.dayTab === s.checksTab)) errors.push('The day view must be its own tab, not the requests or the checks tab.');
  var a = s.email.auto;
  if (a.on && [s.requestTab, s.checksTab, s.dayTab].indexOf(a.tab) >= 0) errors.push('The email text tab must be its own tab, not the requests, checks or day view tab.');
  if (a.on && a.from === a.to) errors.push('The email text window starts and ends at the same time.');
  if (s.rules.tenure.on && !s.sinceField) errors.push('Choose the staff column with the employee-since date (or switch the employment rule off).');
  if (s.rules.shiftEnd.on && s.rules.shiftEnd.from === s.rules.shiftEnd.to) errors.push('The shift end window starts and ends at the same time.');
  return errors;
}

function taxiRuleTexts_(s) {
  var out = [];
  if (s.rules.shiftEnd.on) out.push('Shift ends between ' + s.rules.shiftEnd.from + ' and ' + s.rules.shiftEnd.to);
  if (s.rules.tenure.on) out.push('Employed for less than ' + s.rules.tenure.months + ' months');
  if (s.rules.arrival.on) out.push('Taxi arrives ' + s.rules.arrival.before + ' min before to ' + s.rules.arrival.after + ' min after the shift end');
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

/**
 * Taxi arrival (a date/time cell or text) → minutes after 00:00, or null. Takes the hh:mm part, so the date in
 * "25.10.2026 19:20" or "2026-10-25 19:20" is never read as a time. Pure.
 */
function taxiArrivalMinutes_(v, tz) {
  if (isDate_(v)) return hmToMinutes_(Utilities.formatDate(v, tz, 'HH:mm')) % 1440;
  var s = str_(v).toLowerCase(), m = /(\d{1,2}):(\d{2})\s*(am|pm)?/.exec(s);
  if (!m) return null;
  var h = +m[1], mi = +m[2];
  if (m[3] === 'pm' && h < 12) h += 12;
  if (m[3] === 'am' && h === 12) h = 0;
  if (h > 24 || mi > 59) return null;
  return (h * 60 + mi) % 1440;
}

/** The taxi comes from `before` minutes before to `after` minutes after the shift end; times only, across midnight. Pure. */
function taxiArrivalOk_(arrMin, endMin, before, after) {
  var gap = ((arrMin - endMin) % 1440 + 1440) % 1440;
  return gap <= after || (before > 0 && gap >= 1440 - before);
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
    if (m === null) problems.push(taxiFill_(s.texts.shiftEndUnknown, {}));
    else if (!taxiInWindow_(m, s.rules.shiftEnd.from, s.rules.shiftEnd.to)) {
      problems.push(taxiFill_(s.texts.shiftEndFail, { end: minutesToHm_(m), from: s.rules.shiftEnd.from, to: s.rules.shiftEnd.to }));
    }
  }
  if (s.rules.arrival.on) {
    var a = taxiArrivalMinutes_(req.arrival, tz), e = taxiTimeMinutes_(req.shiftEnd, tz), ra = s.rules.arrival;
    if (a === null) problems.push(taxiFill_(s.texts.arrivalUnknown, {}));
    else if (e === null) { if (!s.rules.shiftEnd.on) problems.push(taxiFill_(s.texts.shiftEndUnknown, {})); }
    else if (!taxiArrivalOk_(a, e, ra.before, ra.after)) {
      problems.push(taxiFill_(s.texts.arrivalFail, { arrival: minutesToHm_(a), end: minutesToHm_(e), before: ra.before, after: ra.after }));
    }
  }
  var key = normText_(req.name), found = Object.prototype.hasOwnProperty.call(sinceByName, key);
  var since = found ? sinceByName[key] : '', months = '';
  if (s.rules.tenure.on) {
    var ref = isDate_(req.arrival) ? Utilities.formatDate(req.arrival, tz, 'yyyy-MM-dd') : (cellToIsoDate_(req.arrival, tz) || todayIso);
    var n = taxiMonths_(since, ref);
    if (!found) problems.push(taxiFill_(s.texts.notFound, {}));
    else if (n < 0) problems.push(taxiFill_(s.texts.sinceMissing, {}));
    else {
      months = n;
      if (n >= s.rules.tenure.months) problems.push(taxiFill_(s.texts.tenureFail, { months: n, max: s.rules.tenure.months }));
    }
  }
  return {
    result: problems.length ? 'CHECK' : 'OK', problems: problems, since: since, months: months,
    message: problems.length ? taxiFailPrefix_(s) + problems.join(TAXI_SEPARATORS[s.separator].text) : taxiNl_(s.okText)
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

/** A text as a formula expression; line breaks become CHAR(10). Pure. */
function taxiLit_(s) {
  var parts = [];
  String(s).split('\n').forEach(function (line, i) {
    if (i) parts.push('CHAR(10)');
    if (line) parts.push(taxiText_(line));
  });
  return parts.length ? parts.join('&') : '""';
}

/**
 * A message as a formula expression: {placeholders} in `fixed` are written in, those in `live` become
 * formula parts (e.g. {end} → TEXT(endT,"hh:mm")). Pure.
 */
function taxiTextExpr_(tpl, fixed, live) {
  var text = taxiFill_(tpl, fixed), parts = [], re = /\{(\w+)\}/g, last = 0, m;
  var lit = function (s) { if (s) parts.push(taxiLit_(s)); };
  while ((m = re.exec(text))) {
    if (!live[m[1]]) continue;
    lit(text.slice(last, m.index));
    parts.push(live[m[1]]);
    last = m.index + m[0].length;
  }
  lit(text.slice(last));
  return parts.length ? parts.join('&') : '""';
}

/** The arrival's time of day as a fraction (-1 when unreadable): only the hh:mm part of a text, as taxiArrivalMinutes_. Pure. */
function taxiArrTimeExpr_(v) {
  return 'IFERROR(MOD(IF(ISNUMBER(' + v + '),' + v + ',TIMEVALUE(REGEXEXTRACT(TO_TEXT(' + v + '),"\\d{1,2}:\\d{2}(?:\\s*[AaPp][Mm])?"))),1),-1)';
}

/** The day view's headers: Time, Name, the decision column, Result, Message, the chosen request columns, Row. Pure. */
function taxiDayHeaders_(s, cols, extras) {
  return ['Time', 'Name'].concat(cols.booking ? [s.bookingColumn] : []).concat(['Result', 'Message'])
    .concat(extras.map(function (e) { return e.header; })).concat(['Row']);
}

var TAXI_DAY_SHOW = ['All', 'Not decided', 'To check'];
var TAXI_DAY_FIRST_ROW_ = 5;

/**
 * The day view's formula (cell A5): the taxis of the taxi day in B2 (empty = every day), filtered by D2,
 * undecided first, then by time in the day; Result and Message from the checks tab (by row). Pure.
 * @param {Array<{header: string, letter: string}>} extras request columns to show
 */
function buildTaxiDayFormula_(s, cols, extras) {
  var R = taxiSheetRef_(s.requestTab), C = taxiSheetRef_(s.checksTab);
  var col = function (letter) { return R + '!' + letter + '2:' + letter; };
  var checks = taxiCheckHeaders_(s, cols);
  var cl = function (h) { var l = columnLetter_(checks.indexOf(h) + 1); return C + '!' + l + '2:' + l; };
  var ds = taxiTimeExpr_(s.dayStart);
  // Denied requests (Result DENIED in the checks tab) are decided, whatever the booking column holds.
  var pend = (cols.booking ? '((TO_TEXT(booked)="")+(TO_TEXT(booked)="FALSE")>0)' : '(nm<>"")') + '*(res<>"DENIED")';
  var outCols = ['IF(arrT<0,"",TEXT(arrT,"hh:mm"))', 'nm'].concat(cols.booking ? ['booked'] : []).concat(['res', 'msg'])
    .concat(extras.map(function (e) { return col(e.letter); })).concat(['rowNo']);
  var dateOf = function (v) { return 'IFERROR(INT(IF(ISNUMBER(' + v + '),' + v + ',DATEVALUE(LEFT(' + v + ',10)))),-1)'; };
  // Before the day start the taxi belongs to the day before. Without a readable arrival (a denied request may hold
  // "DENIED" there) the day comes from the ID column, the time the request was sent.
  var tday = 'IF(arrDate<0,-1,arrDate-IF((arrT>=0)*(arrT<' + ds + '),1,0))';
  if (cols.id) tday = 'IF(arrDate>=0,' + tday + ',IF(idDate<0,-1,idDate-IF((idT>=0)*(idT<' + ds + '),1,0)))';
  return '=ARRAYFORMULA(LET(' + [
    'nm,' + col(cols.name),
    'arr,' + col(cols.arrival)
  ].concat(cols.booking ? ['booked,' + col(cols.booking)] : []).concat([
    'rowNo,ROW(' + col(cols.name) + ')',
    'arrT,' + taxiArrTimeExpr_('arr'),
    'arrDate,' + dateOf('arr')
  ]).concat(cols.id ? ['idv,' + col(cols.id), 'idT,' + taxiArrTimeExpr_('idv'), 'idDate,' + dateOf('idv')] : []).concat([
    'tday,' + tday,
    'res,IFERROR(VLOOKUP(rowNo,{' + cl('Row') + ',' + cl('Result') + '},2,FALSE),"")',
    'msg,IFERROR(VLOOKUP(rowNo,{' + cl('Row') + ',' + cl('Message') + '},2,FALSE),"")',
    'pend,' + pend,
    'pick,$B$2',
    'show,$D$2',
    'keep,(nm<>"")*IF(ISNUMBER(pick),tday=INT(pick),1)*IF(show="' + TAXI_DAY_SHOW[1] + '",pend,IF(show="' + TAXI_DAY_SHOW[2] + '",pend*(res="CHECK"),1))',
    'out,{' + outCols.join(',') + '}',
    'IFERROR(SORT(FILTER(out,keep),FILTER(IF(pend,0,1),keep),TRUE,FILTER(IF(arrT<0,2,MOD(arrT-' + ds + ',1)),keep),TRUE),"No taxi requests for this day.")'
  ]).join(',') + '))';
}

function taxiTimeExpr_(hm) {
  var m = hmToMinutes_(hm);
  return 'TIME(' + Math.floor(m / 60) + ',' + (m % 60) + ',0)';
}

/**
 * The checks tab's formula (cell A1; English function names, as Apps Script writes formulas). Pure.
 * @param {Object} s normalized settings
 * @param {{id?: string, name: string, shiftEnd: string, arrival: string}} cols column letters in the request tab
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
  // Each failed rule ends with the separator; the last one is cut off at the end.
  var sepText = TAXI_SEPARATORS[s.separator].text, sep = taxiLit_(sepText);
  var parts = [];
  if (s.rules.shiftEnd.on) {
    var f = taxiTimeExpr_(s.rules.shiftEnd.from), t = taxiTimeExpr_(s.rules.shiftEnd.to);
    var inside = hmToMinutes_(s.rules.shiftEnd.from) <= hmToMinutes_(s.rules.shiftEnd.to)
      ? '(endT>=' + f + ')*(endT<=' + t + ')' : '(endT>=' + f + ')+(endT<=' + t + ')';
    parts.push('IF(endT<0,' + taxiTextExpr_(s.texts.shiftEndUnknown, {}, {}) + '&' + sep + ',IF(' + inside + ',"",' +
      taxiTextExpr_(s.texts.shiftEndFail, { from: s.rules.shiftEnd.from, to: s.rules.shiftEnd.to }, { end: 'TEXT(endT,"hh:mm")' }) + '&' + sep + '))');
  }
  if (s.rules.arrival.on) {
    var ra = s.rules.arrival, gap = 'MOD(arrT-endT,1)';
    // A second of slack so equal times count as inside (times are fractions of a day).
    var ok = '(' + gap + '<=' + ra.after + '/1440+1/86400)' + (ra.before > 0 ? '+(' + gap + '>=1-' + ra.before + '/1440-1/86400)' : '');
    parts.push('IF(arrT<0,' + taxiTextExpr_(s.texts.arrivalUnknown, {}, {}) + '&' + sep + ',IF(endT<0,' +
      (s.rules.shiftEnd.on ? '""' : taxiTextExpr_(s.texts.shiftEndUnknown, {}, {}) + '&' + sep) + ',IF(' + ok + ',"",' +
      taxiTextExpr_(s.texts.arrivalFail, { before: ra.before, after: ra.after }, { arrival: 'TEXT(arrT,"hh:mm")', end: 'TEXT(endT,"hh:mm")' }) + '&' + sep + ')))');
  }
  if (s.rules.tenure.on) {
    var n = s.rules.tenure.months;
    parts.push('IF(NOT(found),' + taxiTextExpr_(s.texts.notFound, {}, {}) + '&' + sep + ',IF(tenure<0,' + taxiTextExpr_(s.texts.sinceMissing, {}, {}) + '&' + sep +
      ',IF(tenure<' + n + ',"",' + taxiTextExpr_(s.texts.tenureFail, { max: n }, { months: 'tenure' }) + '&' + sep + ')))');
  }
  var msg = parts.length ? parts.join('&') : '""';
  var fail = s.failText ? taxiLit_(taxiFailPrefix_(s)) + '&' : '';
  // The ID as text, exactly as the request tab shows it (a date the workflow wrote stays "2026-10-25 22:15:03", never a number),
  // so "Select a spreadsheet row" finds the value the workflow searches for.
  var withId = !!(s.idColumn && cols.id), withBooking = !!(s.bookingColumn && cols.booking);
  var headers = taxiCheckHeaders_(s, { id: withId, booking: withBooking });
  // Not decided yet (booking empty or an unticked box, and not denied) first, then newest first.
  var sorted = withBooking
    ? 'SORT(FILTER(out,keep),FILTER(IF(((TO_TEXT(booked)="")+(TO_TEXT(booked)="FALSE"))*(1-denied),0,1),keep),TRUE,FILTER(rowNo,keep),FALSE)'
    : 'SORT(FILTER(out,keep),1,FALSE)';
  // A denied request is DENIED whatever the rules say (its time columns may hold "DENIED" instead of a time).
  var denied = taxiDeniedExpr_(s, (withBooking ? ['booked'] : []).concat(['shiftEnd', 'arrival']));
  return '=ARRAYFORMULA(LET(' + [].concat(withId ? ['reqId,TO_TEXT(' + col(cols.id) + ')'] : [])
    .concat(withBooking ? ['booked,' + col(cols.booking)] : []).concat([
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
    // Only the hh:mm part of a text arrival (as taxiArrivalMinutes_), so a date like 25.10.2026 is never read as a time.
    'arrT,' + taxiArrTimeExpr_('arrival'),
    'refDay,IFERROR(INT(IF(ISNUMBER(arrival),arrival,DATEVALUE(LEFT(arrival,10)))),TODAY())',
    'tenure,IF(since="",-1,IFERROR(DATEDIF(since,refDay,"M"),-1))',
    'msg,' + msg,
    'denied,' + denied,
    'keep,reqName<>""',
    'out,{rowNo,' + (withId ? 'reqId,' : '') + 'reqName,' + (withBooking ? 'booked,' : '') + 'IF(denied,"DENIED",IF(msg="","OK","CHECK")),' +
      'IF(denied,"Request denied",IF(msg="",' + taxiLit_(taxiNl_(s.okText)) + ',' + fail + 'LEFT(msg,LEN(msg)-' + sepText.length + '))),' +
      'IF(since="","",TEXT(since,"yyyy-mm-dd")),IF(tenure<0,"",tenure)}',
    'VSTACK({' + headers.map(taxiText_).join(',') + '},IFERROR(' + sorted + ',{' +
      headers.map(function () { return '""'; }).join(',') + '}))'
  ]).join(',') + '))';
}

/* ------------------------------------------------------------------------ */
/* Email text (pure)                                                         */
/* ------------------------------------------------------------------------ */

/** A taxi arrival cell → its date "yyyy-MM-dd" or '' (yyyy-MM-dd…, dd.MM.yyyy…, dd/MM/yyyy…; MM/dd when the day > 12). Pure. */
function taxiDateIso_(v, tz) {
  if (isDate_(v)) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  var s = str_(v);
  if (isIsoDate_(s.substr(0, 10))) return s.substr(0, 10);
  var m = /^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})/.exec(s);
  if (!m) return '';
  var d = +m[1], mo = +m[2];
  if (mo > 12 && d <= 12) { var x = d; d = mo; mo = x; }
  return isValidYmd_(+m[3], mo, d) ? ymd_(+m[3], mo, d) : '';
}

/**
 * The taxi day of an arrival and its place in that day: before dayStart it belongs to the day before.
 * @return {{day: string, order: number|undefined, time: string}} order = minutes after dayStart. Pure.
 */
function taxiDayOf_(v, dayStart, tz) {
  var date = taxiDateIso_(v, tz), min = taxiArrivalMinutes_(v, tz), ds = hmToMinutes_(dayStart);
  if (min === null) return { day: date, order: undefined, time: '' };
  return { day: date && min < ds ? addDays_(date, -1) : date, order: (min - ds + 1440) % 1440, time: minutesToHm_(min) };
}

/** Fills {Any column name} (case and punctuation ignored) and the other {placeholders}; "\n" is a line break. Pure. */
function taxiFillColumns_(tpl, values) {
  var byKey = {};
  Object.keys(values).forEach(function (k) { byKey[normText_(k)] = values[k]; });
  return taxiNl_(tpl).replace(/\{([^{}\n]+)\}/g, function (all, k) {
    var n = normText_(k);
    return Object.prototype.hasOwnProperty.call(byKey, n) ? String(byKey[n]) : all;
  });
}

/** Sort key of a taxi in its day: minutes after the day start, else the clock time, else last. Pure. */
function taxiOrderKey_(r) {
  if (r.order !== undefined) return r.order;
  var m = r.time ? hmToMinutes_(r.time) : null;
  return m === null ? 9999 : m;
}

/**
 * The email text for one taxi date. {date} is the taxi day (it runs from dayStart, so a 00:15 taxi belongs to the
 * evening before); {taxi date} is the date the taxi actually drives: each taxi's own in its block, the taxis' dates
 * in the intro and outro ({date} when no date is known); {next day} is the day after {date}. Pure.
 * @param {Array<{values: Object<string,string>, time: string, taxiDate: string, status: string}>} rows request rows of that date (header → shown value)
 * @return {{text: string, count: number, denied: number, pending: number}}
 */
function buildTaxiEmail_(rows, email, dateIso) {
  var out = { denied: 0, pending: 0 };
  var list = rows.filter(function (r) {
    if (r.status === 'DENIED') { out.denied++; return false; }
    if (r.status === 'PENDING') { out.pending++; if (email.include === 'BOOKED') return false; }
    return true;
  }).sort(function (a, b) { return taxiOrderKey_(a) - taxiOrderKey_(b); });
  var taxiDates = [];
  list.forEach(function (r) { if (r.taxiDate && taxiDates.indexOf(r.taxiDate) < 0) taxiDates.push(r.taxiDate); });
  var common = { date: dateIso, 'taxi date': taxiDates.sort().join(', ') || dateIso, 'next day': addDays_(dateIso, 1), count: list.length };
  var items = list.map(function (r, i) {
    var v = {};
    Object.keys(r.values).forEach(function (k) { v[k] = r.values[k]; });
    v.n = i + 1; v.time = r.time; v.date = dateIso; v.count = list.length;
    v['taxi date'] = r.taxiDate || dateIso; v['next day'] = common['next day'];
    return taxiFillColumns_(email.item, v);
  });
  out.count = list.length;
  out.taxiDate = common['taxi date'];
  out.text = [taxiFillColumns_(email.intro, common)].concat(items.length ? [items.join('\n\n')] : []).concat([taxiFillColumns_(email.outro, common)])
    .filter(function (p) { return p !== ''; }).join('\n');
  return out;
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
  if (s.idColumn) {
    cols.id = taxiColumnLetter_(headers, s.idColumn);
    if (!cols.id) missing.push(s.idColumn);
  }
  if (!cols.name) missing.push(s.nameColumn);
  if (!cols.shiftEnd) missing.push(s.shiftEndColumn);
  if (!cols.arrival) missing.push(s.arrivalColumn);
  if (missing.length) fail_('VALIDATION', 'The tab "' + s.requestTab + '" has no column ' + missing.map(function (m) { return '"' + m + '"'; }).join(', ') + '.');
  // The booking column is optional: without it nothing is sorted or colored by decision.
  cols.booking = s.bookingColumn ? taxiColumnLetter_(headers, s.bookingColumn) : '';
  cols.warnings = s.bookingColumn && !cols.booking
    ? ['The tab "' + s.requestTab + '" has no column "' + s.bookingColumn + '", so requests are not sorted or colored by decision.'] : [];
  return cols;
}

/** Theme colors and font on the checks tab: header row, and undecided requests colored (those to check in the warning color). */
function formatTaxiChecks_(sh, s, headers, cols) {
  var th = sheetTheme_();
  applySheetFont_(sh, th);
  sh.getRange(1, 1, 1, headers.length).setBackground(th.header).setFontColor(th.headerText).setFontWeight('bold');
  sh.setTabColor(th.accent);
  sh.setFrozenRows(1);
  sh.setColumnWidth(headers.indexOf('Message') + 1, 420);
  sh.getRange(1, headers.indexOf('Message') + 1, sh.getMaxRows(), 1).setWrap(true);
  var L = function (h) { return '$' + columnLetter_(headers.indexOf(h) + 1) + '2'; };
  var range = sh.getRange(2, 1, Math.max(1, sh.getMaxRows() - 1), headers.length);
  var st = taxiRowStyles_(th);
  var rule = function (formula, style) { return taxiColorRule_(formula, style, range); };
  var name = L('Name'), result = L('Result');
  // The first rule that matches colors the row, so denied comes before the undecided ones.
  var rules = [rule('=AND(' + name + '<>"",' + result + '="DENIED")', st.denied)];
  if (cols.booking) {
    var b = L(s.bookingColumn), open = '(' + b + '="",' + b + '=FALSE)';
    rules.push(rule('=AND(' + name + '<>"",OR' + open + ',' + result + '="CHECK")', st.check));
    rules.push(rule('=AND(' + name + '<>"",OR' + open + ')', st.open));
    rules.push(rule('=AND(' + name + '<>"",' + b + '<>"",' + b + '<>FALSE)', st.booked));
  } else {
    rules.push(rule('=AND(' + name + '<>"",' + result + '="CHECK")', st.check));
  }
  sh.setConditionalFormatRules(rules); // the checks tab holds only the formula, so its rules are all ours
}

/**
 * Row colors. Undecided, from the theme: to check = the theme's error tint with dark red bold text, all rules
 * met = the theme's light tint with dark text. Decided: booked = green, denied = grey. The text color is set too,
 * so a row stays readable whatever the tab's own text color is. Pure.
 */
function taxiRowStyles_(th) {
  return { check: { bg: th.error, text: '#8c1d18', bold: true }, open: { bg: th.soft, text: '#1f1f1f', bold: false },
    booked: { bg: '#e6f4ea', text: '#0d652d', bold: false }, denied: { bg: '#eeeeee', text: '#757575', bold: false } };
}

function taxiColorRule_(formula, style, range) {
  return SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied(formula)
    .setBackground(style.bg).setFontColor(style.text).setBold(style.bold).setRanges([range]).build();
}

/** Marks this file's color rules in the request tab, so a restyle replaces them and keeps the tab's other rules. */
var TAXI_RULE_MARK_ = 'N("sm-taxi")=0';

/**
 * Theme look of the request tab (the workflow writes it; only its look changes, never a value): header row, font,
 * tab color, and requests not decided yet colored, in the warning color when the checks tab says CHECK.
 * The rows are not reordered (that needs a trigger and could clash with the workflow adding a row); Taxi Checks is the sorted view.
 */
function formatTaxiRequestTab_(s, cols) {
  var sh = getSs_().getSheetByName(s.requestTab);
  if (!sh) return;
  var th = sheetTheme_(), width = Math.max(1, sh.getLastColumn());
  applySheetFont_(sh, th);
  sh.getRange(1, 1, 1, width).setBackground(th.header).setFontColor(th.headerText).setFontWeight('bold');
  sh.setTabColor(th.accent);
  sh.setFrozenRows(1);
  var keep = sh.getConditionalFormatRules().filter(function (r) {
    var b = r.getBooleanCondition();
    return !(b && String((b.getCriteriaValues() || [])[0] || '').indexOf(TAXI_RULE_MARK_) >= 0);
  });
  if (!cols.booking) { sh.setConditionalFormatRules(keep); return; }
  var f = taxiRequestColorFormulas_(s, cols);
  var range = sh.getRange(2, 1, Math.max(1, sh.getMaxRows() - 1), width);
  var st = taxiRowStyles_(th);
  var rule = function (formula, style) { return taxiColorRule_(formula, style, range); };
  // The first rule that matches colors the row: denied, then undecided (to check, then all rules met), then booked.
  sh.setConditionalFormatRules([rule(f.denied, st.denied), rule(f.check, st.check), rule(f.open, st.open), rule(f.booked, st.booked)].concat(keep));
}

/** The request tab's color rules: denied; not decided yet and CHECK in the checks tab; not decided yet; booked. Pure. */
function taxiRequestColorFormulas_(s, cols) {
  var name = '$' + cols.name + '2', b = '$' + cols.booking + '2', open = 'OR(' + b + '="",' + b + '=FALSE)';
  // The checks tab's Row column (A) holds the request's row number; its Result column says OK / CHECK.
  // Conditional formatting reaches another tab only through INDIRECT.
  var checks = taxiCheckHeaders_(s, cols), q = taxiSheetRef_(s.checksTab).replace(/"/g, '""');
  var res = columnLetter_(checks.indexOf('Result') + 1);
  var isCheck = 'IFERROR(INDEX(INDIRECT("' + q + '!' + res + ':' + res + '"),MATCH(ROW(),INDIRECT("' + q + '!A:A"),0))="CHECK",FALSE)';
  var denied = taxiDeniedExpr_(s, [b].concat([cols.shiftEnd, cols.arrival].filter(Boolean).map(function (l) { return '$' + l + '2'; })));
  return {
    denied: '=AND(' + TAXI_RULE_MARK_ + ',' + name + '<>"",' + denied + ')',
    check: '=AND(' + TAXI_RULE_MARK_ + ',' + name + '<>"",' + open + ',' + isCheck + ')',
    open: '=AND(' + TAXI_RULE_MARK_ + ',' + name + '<>"",' + open + ')',
    booked: '=AND(' + TAXI_RULE_MARK_ + ',' + name + '<>"",' + b + '<>"",' + b + '<>FALSE)'
  };
}

/** Repair Formatting / theme change: the checks tab again (only when the rules were saved and the tab exists). */
function taxiRepairFormatting_() {
  if (!getConfig_()[TAXI_SETTINGS_KEY_]) return '';
  var s = getTaxiSettings_();
  if (!getSs_().getSheetByName(s.checksTab)) return '';
  applyTaxiChecks_(s);
  return 'Repaired "' + s.checksTab + '" and "' + s.requestTab + '".';
}

/** Writes the formula into the checks tab (created when missing; it holds nothing else). */
function applyTaxiChecks_(s) {
  var cols = taxiRequestColumns_(s);
  var staff = taxiStaffSources_(s);
  var ss = getSs_();
  var sh = ss.getSheetByName(s.checksTab) || ss.insertSheet(s.checksTab);
  var headers = taxiCheckHeaders_(s, cols);
  sh.clear();
  sh.getRange(1, 1).setFormula(buildTaxiFormula_(s, cols, staff.sources));
  formatTaxiChecks_(sh, s, headers, cols);
  formatTaxiRequestTab_(s, cols);
  var day = s.dayTab ? applyTaxiDayTab_(s, cols) : null;
  return { sheetUrl: sheetLink_(sh), dayUrl: day ? sheetLink_(day) : '', teams: staff.sources.length, missingTeams: staff.missing, warnings: cols.warnings };
}

/**
 * The day view tab, like a daily schedule: B2 the date (a date picker; =TODAY() at first), D2 what to show,
 * row 4 the headers, A5 the formula. The chosen date and filter are kept when the tab is rebuilt.
 */
function applyTaxiDayTab_(s, cols) {
  var ss = getSs_(), th = sheetTheme_();
  var headers = taxiHeaders_(s.requestTab) || [];
  var extras = s.dayColumns.map(function (h) { return { header: h, letter: taxiColumnLetter_(headers, h) }; }).filter(function (e) { return e.letter; });
  var sh = ss.getSheetByName(s.dayTab), keptDate = '=TODAY()', keptShow = TAXI_DAY_SHOW[0];
  if (sh) {
    var b2 = sh.getRange('B2');
    keptDate = b2.getFormula() || (isDate_(b2.getValue()) ? b2.getValue() : keptDate);
    if (TAXI_DAY_SHOW.indexOf(str_(sh.getRange('D2').getValue())) >= 0) keptShow = str_(sh.getRange('D2').getValue());
  } else {
    sh = ss.insertSheet(s.dayTab);
  }
  var dh = taxiDayHeaders_(s, cols, extras);
  sh.clear();
  sh.setConditionalFormatRules([]);
  sh.getRange(1, 1).setValue('Taxi requests').setFontSize(14).setFontWeight('bold').setFontColor(th.accent);
  sh.getRange('A2').setValue('Date');
  if (typeof keptDate === 'string' && keptDate.charAt(0) === '=') sh.getRange('B2').setFormula(keptDate); else sh.getRange('B2').setValue(keptDate);
  sh.getRange('C2').setValue('Show');
  sh.getRange('D2').setValue(keptShow);
  sh.getRange('E2').setValue('A taxi day runs from ' + s.dayStart + ' to ' + s.dayStart + '. Clear the date to see every day.').setFontColor('#5f6368').setFontStyle('italic');
  sh.getRange('A2:D2').setFontWeight('bold');
  sh.getRange('B2').setNumberFormat('yyyy-mm-dd').setBackground(th.soft)
    .setDataValidation(SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(false).setHelpText('Choose a date (double-click for the calendar).').build());
  sh.getRange('D2').setBackground(th.soft)
    .setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(TAXI_DAY_SHOW, true).setAllowInvalid(false).build());
  sh.getRange(4, 1, 1, dh.length).setValues([dh]).setBackground(th.header).setFontColor(th.headerText).setFontWeight('bold');
  sh.getRange(TAXI_DAY_FIRST_ROW_, 1).setFormula(buildTaxiDayFormula_(s, cols, extras));
  applySheetFont_(sh, th);
  sh.setFrozenRows(4);
  sh.setTabColor(th.accent);
  sh.setColumnWidth(dh.indexOf('Message') + 1, 380);
  sh.getRange(TAXI_DAY_FIRST_ROW_, dh.indexOf('Message') + 1, Math.max(1, sh.getMaxRows() - 4), 1).setWrap(true);
  var range = sh.getRange(TAXI_DAY_FIRST_ROW_, 1, Math.max(1, sh.getMaxRows() - 4), dh.length);
  var st = taxiRowStyles_(th), f = taxiDayColorFormulas_(s, cols, dh);
  var rule = function (formula, style) { return formula ? [taxiColorRule_(formula, style, range)] : []; };
  sh.setConditionalFormatRules([].concat(rule(f.denied, st.denied), rule(f.check, st.check), rule(f.open, st.open), rule(f.booked, st.booked)));
  return sh;
}

/**
 * The day view's color rules (rows from row 5), the first that matches wins: denied; undecided and CHECK;
 * undecided; booked ('' for the last two without a decision column). Pure.
 */
function taxiDayColorFormulas_(s, cols, dh) {
  var r = TAXI_DAY_FIRST_ROW_, L = function (h) { return '$' + columnLetter_(dh.indexOf(h) + 1) + r; };
  var name = L('Name'), result = L('Result'), denied = '=AND(' + name + '<>"",' + result + '="DENIED")';
  if (!cols.booking) return { denied: denied, check: '=AND(' + name + '<>"",' + result + '="CHECK")', open: '', booked: '' };
  var b = L(s.bookingColumn), open = 'OR(' + b + '="",' + b + '=FALSE)';
  return { denied: denied, check: '=AND(' + name + '<>"",' + open + ',' + result + '="CHECK")', open: '=AND(' + name + '<>"",' + open + ')',
    booked: '=AND(' + name + '<>"",' + b + '<>"",' + b + '<>FALSE)' };
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
      headers: taxiHeaders_(s.requestTab) || [], staffFields: fields, requestHeaders: TAXI_REQUEST_HEADERS, checkHeaders: taxiCheckHeaders_(s), emailDefaults: TAXI_EMAIL_DEFAULTS, today: todayIso_(),
      texts: TAXI_TEXTS, separators: TAXI_SEPARATORS
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
/**
 * @param {Object} settings the (unsaved) settings
 * @param {{limit?: number, onlyCheck?: boolean}=} opts how many of the newest requests (25 by default, at most 500)
 */
function apiTaxiPreview(settings, opts) {
  return apiCall_('apiTaxiPreview', function () {
    opts = opts || {};
    var limit = Math.min(500, Math.max(1, Math.floor(toNumber_(opts.limit, 25))));
    var s = normalizeTaxiSettings_(settings);
    var cols = taxiRequestColumns_(s);
    var staff = taxiStaffSources_(s);
    var sh = getSs_().getSheetByName(s.requestTab), tz = getTz_(), today = todayIso_(tz);
    var last = sh.getLastRow(), rows = [];
    if (last >= 2) {
      var first = Math.max(2, last - limit + 1);
      var values = sh.getRange(first, 1, last - first + 1, sh.getLastColumn()).getValues();
      var at = function (row, letter) { return row[columnNumber_(letter) - 1]; };
      for (var i = values.length - 1; i >= 0; i--) {
        var req = { name: str_(at(values[i], cols.name)), shiftEnd: at(values[i], cols.shiftEnd), arrival: at(values[i], cols.arrival) };
        if (!req.name) continue;
        var e = taxiEvaluate_(req, staff.sinceByName, s, today, tz);
        var idv = cols.id ? at(values[i], cols.id) : '', bk = cols.booking ? at(values[i], cols.booking) : '';
        var status = taxiBookingStatus_(bk, s.deniedWords, [req.shiftEnd, req.arrival]);
        // As the checks tab: a denied request is DENIED whatever the rules say.
        if (status === 'DENIED') e = { result: 'DENIED', message: 'Request denied', since: e.since, months: e.months };
        if (opts.onlyCheck && e.result !== 'CHECK') continue;
        rows.push({ row: first + i, id: isDate_(idv) ? Utilities.formatDate(idv, tz, 'yyyy-MM-dd HH:mm:ss') : str_(idv), name: req.name, shiftEnd: isDate_(req.shiftEnd) ? Utilities.formatDate(req.shiftEnd, tz, 'HH:mm') : str_(req.shiftEnd),
          arrival: isDate_(req.arrival) ? Utilities.formatDate(req.arrival, tz, 'yyyy-MM-dd HH:mm') : str_(req.arrival),
          booking: bk === false ? '' : str_(bk), status: cols.booking || status === 'DENIED' ? status : '',
          result: e.result, message: e.message, since: e.since, months: e.months });
      }
    }
    // As the checks tab: not decided yet first (then newest first).
    if (cols.booking) rows.sort(function (a, b) { return (a.status === 'PENDING' ? 0 : 1) - (b.status === 'PENDING' ? 0 : 1) || b.row - a.row; });
    return { rows: rows, rules: taxiRuleTexts_(s), missingTeams: staff.missing, errors: validateTaxiSettings_(s), warnings: cols.warnings };
  });
}

/**
 * The email text for the taxis of one date (from the request tab; denied requests are left out, and with
 * include BOOKED also those not decided yet). Nothing is sent; the page shows the text to copy.
 */
function apiTaxiEmailText(settings, dateIso) {
  return apiCall_('apiTaxiEmailText', function () {
    var s = normalizeTaxiSettings_(settings);
    return taxiEmailFor_(s, isIsoDate_(str_(dateIso)) ? str_(dateIso) : todayIso_(getTz_()));
  });
}

/** The email text for one taxi day, read from the request tab (see buildTaxiEmail_). */
function taxiEmailFor_(s, date) {
  var tz = getTz_();
  var cols = taxiRequestColumns_(s);
  var sh = getSs_().getSheetByName(s.requestTab);
  var rows = [];
  if (sh.getLastRow() >= 2) {
    var range = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn());
    var values = range.getValues(), shown = range.getDisplayValues(), headers = shown[0];
    var ia = columnNumber_(cols.arrival) - 1, ib = cols.booking ? columnNumber_(cols.booking) - 1 : -1, iname = columnNumber_(cols.name) - 1;
    var ise = columnNumber_(cols.shiftEnd) - 1;
    for (var r = 1; r < values.length; r++) {
      var when = taxiDayOf_(values[r][ia], s.dayStart, tz);
      if (!str_(values[r][iname]) || when.day !== date) continue;
      var v = {};
      headers.forEach(function (h, i) { if (h) v[h] = shown[r][i]; });
      rows.push({ values: v, time: when.time, order: when.order, taxiDate: taxiDateIso_(values[r][ia], tz),
        status: taxiBookingStatus_(ib >= 0 ? values[r][ib] : 'BOOKED', s.deniedWords, [values[r][ise], values[r][ia]]) });
    }
  }
  var out = buildTaxiEmail_(rows, s.email, date);
  out.date = date;
  out.warnings = cols.warnings;
  return out;
}

/* ------------------------------------------------------------------------ */
/* Email text for a Slack workflow                                           */
/* ------------------------------------------------------------------------ */

var TAXI_EMAIL_TAB_HEADERS = ['Key', 'Taxi day', 'Taxi date', 'Count', 'Text', 'Updated', 'Status'];

/** A cell value that Sheets keeps as text (a leading = + - @ would make it a formula). Pure. */
function taxiCellText_(v) {
  var t = String(v === null || v === undefined ? '' : v);
  return /^[=+\-@]/.test(t) ? "'" + t : t;
}

/**
 * The row of the email text tab: Key, Taxi day, Taxi date, Count, Text, Updated, Status. Pure.
 * @param {{text: string, count: number, taxiDate: string, date: string}} out buildTaxiEmail_'s result for the taxi day
 */
function taxiEmailRow_(key, out, updated) {
  return [key, out.date, out.taxiDate, String(out.count), out.text, updated, 'OK'].map(taxiCellText_);
}

/**
 * Writes today's email text into its tab (created when missing; row 1 the headers, row 2 the text). Today is the
 * taxi day in the spreadsheet's time zone, so in the evening it holds the taxis of the coming night.
 * @return {{sheetUrl: Object, count: number}}
 */
function writeTaxiEmailTab_(s) {
  var a = s.email.auto, tz = getTz_(), ss = getSs_(), th = sheetTheme_();
  var out = taxiEmailFor_(s, todayIso_(tz));
  var sh = ss.getSheetByName(a.tab) || ss.insertSheet(a.tab);
  var n = TAXI_EMAIL_TAB_HEADERS.length;
  sh.getRange(1, 1, 1, n).setValues([TAXI_EMAIL_TAB_HEADERS]).setFontWeight('bold').setBackground(th.header).setFontColor(th.headerText).setFontFamily(th.font);
  sh.getRange(2, 1, 1, n).setNumberFormat('@').setValues([taxiEmailRow_(a.key, out, Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm'))])
    .setVerticalAlignment('top').setFontFamily(th.font);
  sh.getRange(2, 5).setWrap(true);
  sh.setFrozenRows(1);
  sh.setColumnWidth(5, 420);
  return { sheetUrl: sheetLink_(sh), count: out.count };
}

/**
 * Entry point for a time-driven trigger (Apps Script → Triggers → Add trigger → taxiEmailTick, time-driven,
 * every 10 minutes). While the time is inside the window of Email text → "Keep up to date", writes today's email
 * text into its tab for a Slack workflow to read; outside the window it does nothing. On an error the last text
 * stays and the Status column shows the error. Never shows UI.
 */
function taxiEmailTick() {
  var s = null;
  try {
    requireInitialized_();
    s = getTaxiSettings_();
    var a = s.email.auto;
    if (!a.on) return 'off';
    var now = hmToMinutes_(Utilities.formatDate(new Date(), getTz_(), 'HH:mm'));
    if (!taxiInWindow_(now, a.from, a.to)) return 'outside ' + a.from + '–' + a.to;
    var r = writeTaxiEmailTab_(s);
    console.log('Taxi email text: ' + r.count + ' taxi(s) written to "' + a.tab + '".');
    return r.count;
  } catch (e) {
    logError_('taxiEmailTick', e);
    try {
      var sh = s && getSs_().getSheetByName(s.email.auto.tab);
      if (sh) sh.getRange(2, 7).setValue(taxiCellText_('Error ' + Utilities.formatDate(new Date(), getTz_(), 'HH:mm') + ': ' + (e && e.message ? e.message : e)));
    } catch (e2) { /* nothing more to do */ }
    throw e;
  }
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
      // Fill the email text tab at once, so the Slack step can be set up before the trigger first runs.
      if (s.email.auto.on) res.emailTab = writeTaxiEmailTab_(s);
      res.settings = s;
      return res;
    });
  });
}

/* ------------------------------------------------------------------------ */
/* Clearing old requests                                                     */
/* ------------------------------------------------------------------------ */

/** Options of a clear with defaults: older than days (taxi day), DECIDED (booked and denied) or ALL, a copy kept in archiveTab. Pure. */
function normalizeTaxiClear_(o) {
  o = o || {};
  return { days: Math.min(3650, Math.max(1, Math.floor(toNumber_(o.days, 30)))), which: o.which === 'ALL' ? 'ALL' : 'DECIDED',
    archive: o.archive !== false, archiveTab: str_(o.archiveTab) || 'Taxi Archive' };
}

/**
 * The requests to clear: taxi day before today minus days; with DECIDED only booked and denied ones. A row
 * without a readable date (arrival or ID) is never cleared. Pure.
 * @param {Array<{row: number, day: string, status: string}>} rows
 */
function taxiClearPick_(rows, o, today) {
  var cut = addDays_(today, -o.days);
  return rows.filter(function (r) { return r.day && r.day < cut && (o.which === 'ALL' || r.status !== 'PENDING'); });
}

/** The request tab's rows with their taxi day (from the arrival, else the ID: a denied request may hold no time) and status. */
function taxiClearRows_(s, cols, values, tz) {
  var at = function (row, letter) { return letter ? row[columnNumber_(letter) - 1] : ''; };
  var rows = [];
  for (var r = 1; r < values.length; r++) {
    var v = values[r];
    if (!str_(at(v, cols.name))) continue;
    var day = taxiDayOf_(at(v, cols.arrival), s.dayStart, tz).day || (cols.id ? taxiDayOf_(at(v, cols.id), s.dayStart, tz).day : '');
    rows.push({ row: r + 1, day: day, status: taxiBookingStatus_(cols.booking ? at(v, cols.booking) : 'BOOKED', s.deniedWords, [at(v, cols.shiftEnd), at(v, cols.arrival)]) });
  }
  return rows;
}

function taxiClearValidate_(s, o) {
  var own = [s.requestTab, s.checksTab, s.dayTab, s.email.auto.tab].filter(Boolean).map(normText_);
  if (o.archive && own.indexOf(normText_(o.archiveTab)) >= 0) fail_('VALIDATION', 'The archive needs its own tab, not "' + o.archiveTab + '".');
}

/** What a clear would remove (nothing is changed), with the saved settings. */
function apiTaxiClearPreview(opts) {
  return apiCall_('apiTaxiClearPreview', function () {
    var s = getTaxiSettings_(), o = normalizeTaxiClear_(opts), tz = getTz_();
    taxiClearValidate_(s, o);
    var cols = taxiRequestColumns_(s), sh = getSs_().getSheetByName(s.requestTab);
    var values = sh.getLastRow() >= 2 ? sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getValues() : [];
    var rows = taxiClearRows_(s, cols, values, tz), pick = taxiClearPick_(rows, o, todayIso_(tz));
    var n = function (st) { return pick.filter(function (r) { return r.status === st; }).length; };
    var days = pick.map(function (r) { return r.day; }).sort();
    return { count: pick.length, total: rows.length, booked: n('BOOKED'), denied: n('DENIED'), pending: n('PENDING'),
      from: days[0] || '', to: days[days.length - 1] || '', before: addDays_(todayIso_(tz), -o.days), options: o };
  });
}

/**
 * Clears old requests from the request tab (copied first into the archive tab when asked; it gets the same header
 * row). Rows are deleted bottom-up, so a row the workflow adds meanwhile is never touched; Taxi Checks and Taxi Day
 * recalculate by themselves.
 */
function apiTaxiClear(opts) {
  return apiCall_('apiTaxiClear', function () {
    var s = getTaxiSettings_(), o = normalizeTaxiClear_(opts), tz = getTz_();
    taxiClearValidate_(s, o);
    return withLock_(function () {
      var cols = taxiRequestColumns_(s), ss = getSs_(), sh = ss.getSheetByName(s.requestTab);
      var last = sh.getLastRow(), width = Math.max(1, sh.getLastColumn());
      if (last < 2) return { cleared: 0, archived: 0 };
      var values = sh.getRange(1, 1, last, width).getValues();
      var pick = taxiClearPick_(taxiClearRows_(s, cols, values, tz), o, todayIso_(tz));
      if (!pick.length) return { cleared: 0, archived: 0 };
      var out = { cleared: pick.length, archived: 0 };
      if (o.archive) {
        var ar = ss.getSheetByName(o.archiveTab) || ss.insertSheet(o.archiveTab);
        if (ar.getMaxColumns() < width) ar.insertColumnsAfter(ar.getMaxColumns(), width - ar.getMaxColumns());
        if (ar.getLastRow() < 1) {
          ar.getRange(1, 1, 1, width).setValues([values[0]]).setFontWeight('bold');
          ar.setFrozenRows(1);
        } else if (ar.getRange(1, 1, 1, width).getDisplayValues()[0].map(normText_).join('|') !== values[0].map(normText_).join('|')) {
          // Never append to some other tab by a typing mistake: an existing archive has the request tab's header row.
          fail_('VALIDATION', 'The tab "' + o.archiveTab + '" is not an archive of "' + s.requestTab + '" (its first row has other column names). Choose another archive tab.');
        }
        // Text stays text (a phone number "+36…" or "06…" would otherwise turn into a number); dates and numbers keep
        // the request tab's number formats.
        var copy = pick.map(function (r) { return values[r.row - 1].map(function (x) { return typeof x === 'string' && x ? "'" + x : x; }); });
        var formats = sh.getRange(pick[0].row, 1, 1, width).getNumberFormats()[0];
        var room = ar.getMaxRows() - ar.getLastRow();
        if (room < copy.length) ar.insertRowsAfter(ar.getMaxRows(), copy.length - room);
        ar.getRange(ar.getLastRow() + 1, 1, copy.length, width).setNumberFormats(copy.map(function () { return formats; })).setValues(copy);
        out.archived = copy.length;
        out.archiveUrl = sheetLink_(ar);
      }
      // A sheet must keep one row below the frozen header, so add an empty one when every request goes.
      if (sh.getMaxRows() - 1 <= pick.length) sh.insertRowsAfter(sh.getMaxRows(), 1);
      var nums = pick.map(function (r) { return r.row; }).sort(function (a, b) { return b - a; });
      for (var i = 0; i < nums.length;) {
        var j = i;
        while (j + 1 < nums.length && nums[j + 1] === nums[j] - 1) j++;
        sh.deleteRows(nums[j], nums[i] - nums[j] + 1);
        i = j + 1;
      }
      return out;
    }, 60000);
  });
}

function menuTaxiClear() {
  menuRun_('menuTaxiClear', function () { showHtml_('TaxiDialog', 'Taxi Request Rules', { tab: 'requests', clear: true }, DIALOG_SIZE.LARGE); });
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
      var bad = taxiEvaluate_({ name: 'Bob', shiftEnd: '22:00', arrival: '22:30' }, since, s, '2026-10-24', tz);
      assertEq_([bad.result, bad.message], ['CHECK', '⚠️ Check before approving: Shift ends 22:00 (taxi only for shifts ending 00:00–06:00); Employed 21 months (taxi only under 3 months)']);
      assertEq_([taxiEvaluate_({ name: 'Dan', shiftEnd: '01:00', arrival: '01:15' }, since, s, '2026-10-24', tz).problems, taxiEvaluate_({ name: 'cid', shiftEnd: '01:00', arrival: '01:15' }, since, s, '2026-10-24', tz).problems],
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
    ['Taxi: the request ID (Date ID) is copied next to Row, so the workflow finds the exact request', function () {
      var f = buildTaxiFormula_(s, { id: 'A', name: 'C', shiftEnd: 'G', arrival: 'H' }, []);
      assert_(f.indexOf("=ARRAYFORMULA(LET(reqId,TO_TEXT('Taxi Requests'!A2:A),") === 0 && f.indexOf('out,{rowNo,reqId,reqName,') > 0, 'ID column in the output');
      assert_(f.indexOf('{"Row","Date ID","Name","Result","Message","Employee since","Months"}') > 0, 'headed like the request tab');
      var none = buildTaxiFormula_(normalizeTaxiSettings_({ sinceField: 'x', idColumn: '' }), { name: 'C', shiftEnd: 'G', arrival: 'H' }, []);
      assert_(none.indexOf('reqId') < 0 && none.indexOf('{"Row","Name",') > 0, 'no ID column: search by Name');
      assertEq_(taxiCheckHeaders_(s), ['Row', 'Date ID', 'Name', 'Booking done', 'Result', 'Message', 'Employee since', 'Months']);
    }],
    ['Taxi: a web app page and nav link only while this file is present', function () {
      var p = webPages_().taxi;
      assertEq_([p.file, p.nav, WEB_PAGES.taxi], ['TaxiDialog', 'Taxi', undefined]);
      assertEq_(p.prefetch({}, {}), [['apiTaxiBootstrap']], 'same call as load() in the page');
    }],
    ['Taxi: own messages per rule with {placeholders}, joined by the chosen separator', function () {
      var own = normalizeTaxiSettings_({ sinceField: 'x', separator: 'LINE', failText: 'Please check:',
        texts: { shiftEndFail: 'Ends at {end}, needs {from}-{to}', tenureFail: '{months} months "in" (max {max})', notFound: '' } });
      assertEq_(own.texts.notFound, 'Not found in the staff sheets', 'an empty message falls back to the default');
      var e = taxiEvaluate_({ name: 'Bob', shiftEnd: '22:00', arrival: '22:10' }, { bob: '2025-01-01' }, own, '2026-10-24', tz);
      assertEq_(e.message, 'Please check:\nEnds at 22:00, needs 00:00-06:00\n21 months "in" (max 3)');
      var f = buildTaxiFormula_(own, { name: 'C', shiftEnd: 'G', arrival: 'H' }, []);
      assert_(f.indexOf('"Ends at "&TEXT(endT,"hh:mm")&", needs 00:00-06:00"&CHAR(10)') > 0, 'live {end}, fixed {from}/{to}, new line');
      assert_(f.indexOf('tenure&" months ""in"" (max 3)"') > 0, 'live {months}, quotes escaped');
      assert_(f.indexOf('"Please check:"&CHAR(10)&LEFT(') > 0 && f.indexOf('LEFT(msg,LEN(msg)-1)') > 0, 'prefix on its own line; one-character separator cut');
      assertEq_((f.match(/\(/g) || []).length, (f.match(/\)/g) || []).length, 'balanced parentheses');
      assertEq_(normalizeTaxiSettings_({ separator: 'NOPE' }).separator, 'SEMI');
      var nl = normalizeTaxiSettings_({ sinceField: 'x', okText: 'All good\\nBook it', failText: 'Check:\\n', texts: { notFound: 'Unknown\\nperson' } });
      assertEq_([taxiEvaluate_({ name: 'Ann', shiftEnd: '01:00', arrival: '01:10' }, { ann: '2026-10-01' }, nl, '2026-10-24', tz).message,
        taxiEvaluate_({ name: 'Zed', shiftEnd: '01:00', arrival: '01:10' }, {}, nl, '2026-10-24', tz).message], ['All good\nBook it', 'Check:\nUnknown\nperson'], 'a typed \\n is a line break');
      var fn = buildTaxiFormula_(nl, { name: 'C', shiftEnd: 'G', arrival: 'H' }, []);
      assert_(fn.indexOf('"All good"&CHAR(10)&"Book it"') > 0 && fn.indexOf('"Unknown"&CHAR(10)&"person"') > 0, 'also in the sheet formula');
    }],
    ['Taxi: the taxi must come right after the shift end (also across midnight)', function () {
      var since = { ann: '2026-10-01' };
      var msgOf = function (end, arr, st) { return taxiEvaluate_({ name: 'Ann', shiftEnd: end, arrival: arr }, since, st || s, '2026-10-24', tz).problems; };
      assertEq_(msgOf('00:01', '2026-10-25 19:20'), ['Taxi at 19:20 but the shift ends 00:01 (taxi up to 60 min after the shift end)'], 'the reported bug: taxi long before the shift end');
      assertEq_([msgOf('00:01', '2026-10-25 00:20'), msgOf('23:50', '26.10.2026 00:30', normalizeTaxiSettings_({ sinceField: 'x', rules: { shiftEnd: { from: '23:00', to: '06:00' } } })), msgOf('00:30', '12:45 AM')], [[], [], []], 'after the end, across midnight, dotted dates and am/pm');
      assertEq_(msgOf('01:00', '2026-10-25 00:50'), ['Taxi at 00:50 but the shift ends 01:00 (taxi up to 60 min after the shift end)'], 'before the end is not allowed by default');
      var early = normalizeTaxiSettings_({ sinceField: 'x', rules: { arrival: { before: 15, after: 30 } } });
      assertEq_([msgOf('01:00', '00:50', early).length, msgOf('01:00', '01:45', early).length, msgOf('01:00', 'soon', early)], [0, 1, ['Taxi arrival time not understood']]);
      assertEq_([taxiArrivalOk_(5, 1435, 0, 60), taxiArrivalOk_(1435, 5, 0, 60), taxiArrivalOk_(1435, 5, 15, 60)], [true, false, true]);
      var f = buildTaxiFormula_(early, { name: 'C', shiftEnd: 'G', arrival: 'H' }, []);
      assert_(f.indexOf('(MOD(arrT-endT,1)<=30/1440+1/86400)+(MOD(arrT-endT,1)>=1-15/1440-1/86400)') > 0, 'the same window in the sheet');
      assert_(f.indexOf('REGEXEXTRACT(TO_TEXT(arrival),"\\d{1,2}:\\d{2}') > 0, 'the sheet reads only the hh:mm part');
      assertEq_((f.match(/\(/g) || []).length, (f.match(/\)/g) || []).length, 'balanced parentheses');
      var off = normalizeTaxiSettings_({ sinceField: 'x', rules: { arrival: { on: false } } });
      assertEq_(msgOf('00:01', '19:20', off), [], 'rule switched off');
    }],
    ['Taxi: undecided requests (booking empty) come first in the checks tab', function () {
      assertEq_(['', false, 'FALSE', 'Prebooked', 'Denied by Anna', 'deny', 'TRUE', 'Rejected'].map(function (v) { return taxiBookingStatus_(v, s.deniedWords); }),
        ['PENDING', 'PENDING', 'PENDING', 'BOOKED', 'DENIED', 'DENIED', 'BOOKED', 'DENIED']);
      assertEq_([taxiBookingStatus_('Anna Smith', s.deniedWords, ['DENIED', 'DENIED']), taxiBookingStatus_('Anna Smith', s.deniedWords, ['01:00', '01:10']), taxiBookingStatus_('', s.deniedWords, ['', 'denied'])],
        ['DENIED', 'BOOKED', 'DENIED'], 'a Deny button writes the name in the booking column and DENIED in the time columns');
      assertEq_(taxiDeniedExpr_(s, ['booked', 'arrival']), '((ISNUMBER(SEARCH(" deny"," "&TO_TEXT(booked)&" "&TO_TEXT(arrival)))+ISNUMBER(SEARCH(" denied"," "&TO_TEXT(booked)&" "&TO_TEXT(arrival)))+' +
        'ISNUMBER(SEARCH(" rejected"," "&TO_TEXT(booked)&" "&TO_TEXT(arrival))))>0)');
      var f = buildTaxiFormula_(s, { id: 'A', name: 'C', shiftEnd: 'G', arrival: 'H', booking: 'J' }, []);
      assert_(f.indexOf("booked,'Taxi Requests'!J2:J") > 0 && f.indexOf('out,{rowNo,reqId,reqName,booked,IF(denied,"DENIED",IF(msg="","OK","CHECK")),IF(denied,"Request denied",') > 0, 'booking column after Name; denied');
      assert_(f.indexOf('SORT(FILTER(out,keep),FILTER(IF(((TO_TEXT(booked)="")+(TO_TEXT(booked)="FALSE"))*(1-denied),0,1),keep),TRUE,FILTER(rowNo,keep),FALSE)') > 0, 'undecided first, then newest');
      assert_(f.indexOf('{"Row","Date ID","Name","Booking done","Result"') > 0, 'headers');
      assertEq_((f.match(/\(/g) || []).length, (f.match(/\)/g) || []).length, 'balanced parentheses');
      var none = buildTaxiFormula_(normalizeTaxiSettings_({ sinceField: 'x', bookingColumn: '' }), { name: 'C', shiftEnd: 'G', arrival: 'H' }, []);
      assert_(none.indexOf('booked') < 0 && none.indexOf('SORT(FILTER(out,keep),1,FALSE)') > 0, 'without a booking column: newest first');
    }],
    ['Taxi: the request tab colors denied, undecided, flagged and booked requests', function () {
      var f = taxiRequestColorFormulas_(normalizeTaxiSettings_({ sinceField: 'x', checksTab: "Ann's Checks", deniedWords: 'denied' }), { id: 'A', name: 'C', shiftEnd: 'G', arrival: 'H', booking: 'J' });
      assertEq_(f.denied, '=AND(N("sm-taxi")=0,$C2<>"",((ISNUMBER(SEARCH(" denied"," "&TO_TEXT($J2)&" "&TO_TEXT($G2)&" "&TO_TEXT($H2))))>0))');
      assertEq_(f.booked, '=AND(N("sm-taxi")=0,$C2<>"",$J2<>"",$J2<>FALSE)');
      assertEq_(f.open, '=AND(N("sm-taxi")=0,$C2<>"",OR($J2="",$J2=FALSE))');
      assertEq_(f.check, '=AND(N("sm-taxi")=0,$C2<>"",OR($J2="",$J2=FALSE),IFERROR(INDEX(INDIRECT("\'Ann\'\'s Checks\'!E:E"),' +
        'MATCH(ROW(),INDIRECT("\'Ann\'\'s Checks\'!A:A"),0))="CHECK",FALSE))', 'Result is column E (Row, Date ID, Name, Booking done, Result)');
    }],
    ['Taxi: email text for one date — sorted by time, denied left out, any column as {placeholder}', function () {
      assertEq_(['2026-10-25 19:20', '25.10.2026 19:20', '10/25/2026', 'soon'].map(function (v) { return taxiDateIso_(v, tz); }), ['2026-10-25', '2026-10-25', '2026-10-25', '']);
      var row = function (name, time, status) { return { values: { 'SA Name': name, 'Address': name + ' street 1', 'Phone Number': '123', 'Pet friendly': 'No' }, time: time, status: status }; };
      var rows = [row('Bob', '23:30', 'BOOKED'), row('Ann', '22:10', 'PENDING'), row('Cid', '21:00', 'DENIED')];
      var e = buildTaxiEmail_(rows, s.email, '2026-10-25');
      assertEq_([e.count, e.denied, e.pending], [2, 1, 1]);
      assertEq_(e.text, 'Hi,\n\nPlease book the following taxis for 2026-10-25:\n\n1. 22:10 – Ann\nAddress: Ann street 1\nPhone: 123\nPet friendly: No\n\n' +
        '2. 23:30 – Bob\nAddress: Bob street 1\nPhone: 123\nPet friendly: No\n\nThank you!');
      var booked = buildTaxiEmail_(rows, normalizeTaxiSettings_({ email: { include: 'BOOKED', intro: '{count} taxi(s) on {date}', item: '{time} {sa name} {Unknown}', outro: '' } }).email, '2026-10-25');
      assertEq_(booked.text, '1 taxi(s) on 2026-10-25\n23:30 Bob {Unknown}', 'only booked; names in any case; unknown placeholders stay');
      var night = [row('Dan', '00:40', 'BOOKED'), row('Eve', '04:10', 'BOOKED')];
      night.forEach(function (r) { r.taxiDate = '2026-10-26'; });
      var tpl = normalizeTaxiSettings_({ email: { intro: '{date} | {Taxi date} | {next_day}', item: '{n}. {taxi date} {time} {SA Name}', outro: '' } }).email;
      assertEq_(buildTaxiEmail_(night, tpl, '2026-10-25').text, '2026-10-25 | 2026-10-26 | 2026-10-26\n1. 2026-10-26 00:40 Dan\n\n2. 2026-10-26 04:10 Eve',
        'taxis after midnight: {date} is the taxi day, {taxi date} the date they drive');
      assertEq_(buildTaxiEmail_([], tpl, '2026-10-25').text, '2026-10-25 | 2026-10-25 | 2026-10-26', 'no taxis: {taxi date} falls back to {date}');
    }],
    ['Taxi: the email text tab for a Slack workflow — settings, row, text kept as text', function () {
      var a = normalizeTaxiSettings_({}).email.auto;
      assertEq_([a.on, a.tab, a.key, a.from, a.to], [false, 'Taxi Email', 'tonight', '04:30', '22:00'], 'off by default; 04:30–22:00');
      var b = normalizeTaxiSettings_({ email: { auto: { on: true, tab: 'Mail', key: 'next', from: '5:00', to: 'x' } } }).email.auto;
      assertEq_([b.on, b.tab, b.key, b.from, b.to], [true, 'Mail', 'next', '05:00', '22:00']);
      assertEq_(validateTaxiSettings_(normalizeTaxiSettings_({ rules: { tenure: { on: false } }, email: { auto: { on: true, tab: 'Taxi Checks' } } })).length, 1, 'its own tab');
      assertEq_(taxiEmailRow_('tonight', { date: '2026-10-25', taxiDate: '2026-10-26', count: 2, text: '=Hi\n1. Ann' }, '2026-10-25 21:50'),
        ['tonight', '2026-10-25', '2026-10-26', '2', "'=Hi\n1. Ann", '2026-10-25 21:50', 'OK'], 'a text starting with = stays text');
      assertEq_([taxiInWindow_(hmToMinutes_('04:29'), '04:30', '22:00'), taxiInWindow_(hmToMinutes_('21:59'), '04:30', '22:00'), taxiInWindow_(hmToMinutes_('22:01'), '04:30', '22:00')],
        [false, true, false], 'the trigger writes only inside the window');
    }],
    ['Taxi: a taxi day runs from the day start, so a 00:15 taxi belongs to the evening before', function () {
      assertEq_([taxiDayOf_('2026-10-25 19:20', '06:00', tz), taxiDayOf_('2026-10-26 00:15', '06:00', tz), taxiDayOf_('26.10.2026 07:00', '06:00', tz)],
        [{ day: '2026-10-25', order: 800, time: '19:20' }, { day: '2026-10-25', order: 1095, time: '00:15' }, { day: '2026-10-26', order: 60, time: '07:00' }]);
      assertEq_(taxiDayOf_('2026-10-26', '06:00', tz), { day: '2026-10-26', order: undefined, time: '' }, 'a date without a time');
      assertEq_([taxiOrderKey_({ order: 5, time: '23:00' }), taxiOrderKey_({ time: '01:30' }), taxiOrderKey_({})], [5, 90, 9999]);
      assertEq_(validateTaxiSettings_(normalizeTaxiSettings_({ rules: { tenure: { on: false } }, dayTab: 'Taxi Checks' })).length, 1, 'the day view needs its own tab');
    }],
    ['Taxi: the day view lists one taxi day, undecided first, then by time in the day', function () {
      var cols = { id: 'A', name: 'C', shiftEnd: 'G', arrival: 'H', booking: 'J' };
      var extras = [{ header: 'Address', letter: 'E' }, { header: 'Phone Number', letter: 'F' }];
      assertEq_(taxiDayHeaders_(s, cols, extras), ['Time', 'Name', 'Booking done', 'Result', 'Message', 'Address', 'Phone Number', 'Row']);
      var f = buildTaxiDayFormula_(s, cols, extras);
      assert_(f.indexOf("nm,'Taxi Requests'!C2:C,arr,'Taxi Requests'!H2:H,booked,'Taxi Requests'!J2:J,") > 0, 'request columns');
      assert_(f.indexOf("tday,IF(arrDate>=0,IF(arrDate<0,-1,arrDate-IF((arrT>=0)*(arrT<TIME(6,0,0)),1,0)),IF(idDate<0,-1,idDate-IF((idT>=0)*(idT<TIME(6,0,0)),1,0)))") > 0, 'day start; without a readable arrival, the day of the ID');
      assert_(f.indexOf('pend,((TO_TEXT(booked)="")+(TO_TEXT(booked)="FALSE")>0)*(res<>"DENIED")') > 0, 'denied is decided');
      assert_(f.indexOf("res,IFERROR(VLOOKUP(rowNo,{'Taxi Checks'!A2:A,'Taxi Checks'!E2:E},2,FALSE),\"\")") > 0, 'Result from the checks tab by row');
      assert_(f.indexOf('keep,(nm<>"")*IF(ISNUMBER(pick),tday=INT(pick),1)*IF(show="Not decided",pend,IF(show="To check",pend*(res="CHECK"),1))') > 0, 'date and Show filters');
      assert_(f.indexOf("out,{IF(arrT<0,\"\",TEXT(arrT,\"hh:mm\")),nm,booked,res,msg,'Taxi Requests'!E2:E,'Taxi Requests'!F2:F,rowNo}") > 0, 'columns shown');
      assert_(f.indexOf('FILTER(IF(arrT<0,2,MOD(arrT-TIME(6,0,0),1)),keep),TRUE),"No taxi requests for this day.")') > 0, 'sorted in the taxi day');
      assertEq_((f.match(/\(/g) || []).length, (f.match(/\)/g) || []).length, 'balanced parentheses');
      var c = taxiDayColorFormulas_(s, cols, taxiDayHeaders_(s, cols, extras));
      assertEq_([c.denied, c.open, c.check, c.booked], ['=AND($B5<>"",$D5="DENIED")', '=AND($B5<>"",OR($C5="",$C5=FALSE))', '=AND($B5<>"",OR($C5="",$C5=FALSE),$D5="CHECK")', '=AND($B5<>"",$C5<>"",$C5<>FALSE)']);
      var plain = buildTaxiDayFormula_(normalizeTaxiSettings_({ sinceField: 'x', bookingColumn: '' }), { name: 'C', shiftEnd: 'G', arrival: 'H', booking: '' }, []);
      assert_(plain.indexOf('booked') < 0 && plain.indexOf('pend,(nm<>"")*(res<>"DENIED")') > 0, 'without a decision column everything not denied counts as not decided');
      assert_(plain.indexOf('idDate') < 0, 'without an ID column the day comes from the arrival only');
    }],
    ['Taxi: clearing old requests keeps undecided ones and rows without a date', function () {
      var o = normalizeTaxiClear_({});
      assertEq_([o.days, o.which, o.archive, o.archiveTab], [30, 'DECIDED', true, 'Taxi Archive'], 'defaults: 30 days, decided only, with a copy');
      assertEq_([normalizeTaxiClear_({ days: 0 }).days, normalizeTaxiClear_({ days: 'x', which: 'ALL', archive: false }).which], [1, 'ALL']);
      var cols = { id: 'A', name: 'C', shiftEnd: 'G', arrival: 'H', booking: 'J' };
      var r = function (id, name, end, arr, bk) { return [id, '', name, '', '', '', end, arr, '', bk, '', '']; };
      var values = [TAXI_REQUEST_HEADERS,
        r('2026-09-01 21:00:00', 'Ann', '00:00', '2026-09-02 00:20', 'Ben'),      // booked, taxi day 2026-09-01
        r('2026-09-01 21:05:00', 'Bob', 'DENIED', 'DENIED', 'Ben'),             // denied: the day from the ID
        r('2026-09-01 21:10:00', 'Cid', '00:00', '2026-09-02 00:30', ''),       // not decided yet
        r('', 'Dan', '00:00', 'soon', 'Ben'),                                    // no readable date
        r('2026-10-28 21:00:00', 'Eve', '00:00', '2026-10-29 00:10', 'Ben'),    // too new
        r('', '', '', '', '')];
      var rows = taxiClearRows_(s, cols, values, tz);
      assertEq_(rows.map(function (x) { return [x.row, x.day, x.status]; }), [[2, '2026-09-01', 'BOOKED'], [3, '2026-09-01', 'DENIED'], [4, '2026-09-01', 'PENDING'], [5, '', 'BOOKED'], [6, '2026-10-28', 'BOOKED']]);
      assertEq_(taxiClearPick_(rows, o, '2026-10-29').map(function (x) { return x.row; }), [2, 3], 'decided and older than 30 days');
      assertEq_(taxiClearPick_(rows, normalizeTaxiClear_({ which: 'ALL' }), '2026-10-29').map(function (x) { return x.row; }), [2, 3, 4], 'all, also not decided yet');
      assertEq_(taxiClearPick_(rows, normalizeTaxiClear_({ days: 60 }), '2026-10-29').length, 0, 'nothing older than 60 days');
    }],
    ['Taxi: request columns found by header text', function () {
      assertEq_([taxiColumnLetter_(TAXI_REQUEST_HEADERS, 'sa name'), taxiColumnLetter_(TAXI_REQUEST_HEADERS, 'When the taxi should arrive?'), taxiColumnLetter_(TAXI_REQUEST_HEADERS, 'Nope')], ['C', 'H', '']);
    }]
  ];
}
