/**
 * ScheduleCopy.gs — optional extension (delete this file and ScheduleCopyDialog.html to remove it; nothing else changes).
 * Copies imported shifts into another spreadsheet laid out in weekly blocks, as the old "HUN shifts" tab:
 *
 *     |  Week 44                                            ← week row (B–H merged)
 *     Support Associate | 2026-10-26 | 2026-10-27 | … | 2026-11-01   ← dates, Monday–Sunday (B–H)
 *     Anna Kovács 🇳🇴    | 17:00 - 23:00 | Day Off | …     ← one row per person (name in A)
 *
 *  - After each Quinyx import the imported days of the chosen team(s) are written into the blocks for those
 *    dates: "08:00 - 16:00" (the person's earliest start to latest end that day; meetings are left out) or
 *    "Day Off", in the old colors (shift yellow, shift lead grey, Aircall purple, Day Off green). A cell that
 *    says Vacation / Sick / … is kept when there is no shift. People are matched by name (case, accents,
 *    emojis and "Shift Lead -" ignored); rows of people who are not in the team are never touched.
 *  - New week blocks are added at the bottom (two empty rows, "Week N", the dates, then the team's staff from
 *    this spreadsheet: A–Z, two empty rows, the shift leads), as the old "Create a new weekly block":
 *    scheduleCopyWeeklyTick (on a weekly time-driven trigger the user adds, e.g. Sunday 06:00–07:00) adds next
 *    week's, and an import adds any week it needs first. The other sheet needs no script.
 *  - Who runs the import (and who added the trigger) needs edit access to the other spreadsheet.
 *
 * Settings: _CONFIG SCHEDULE_COPY_SETTINGS (JSON), {copies: [...]}: one entry per target tab.
 * Dependencies: Utils.gs, ConfigService.gs, TeamService.gs, StaffService.gs, ScheduleService.gs, WebDataService.gs (weekStartOf_), Main.gs
 */

var SM_EXTENSIONS = (typeof SM_EXTENSIONS !== 'undefined' && SM_EXTENSIONS) || [];
SM_EXTENSIONS.push({
  id: 'copy', title: 'Schedule Copy',
  menu: [{ label: 'Copy Schedules to Another Sheet', fn: 'menuScheduleCopy' }],
  webPages: { copy: { file: 'ScheduleCopyDialog', title: 'Schedule Copy', nav: 'Copy', prefetch: function () { return [['apiScheduleCopyBootstrap']]; } } },
  // ImportService.gs (commitImport_) calls this after every committed import.
  afterImport: function (info) { return scheduleCopyAfterImport_(info); },
  tests: function () { return scheduleCopyUnitTests_(); }
});

var SCHEDULE_COPY_KEY_ = 'SCHEDULE_COPY_SETTINGS';
/** The old sheet's colors. */
var SC_COLORS = { dayOff: '#b6d7a8', paidLeave: '#ea9999', vacation: '#4283ee', sick: '#e06666', aircall: '#b4a7d6', shift: '#ffe599', lead: '#d9d9d9', other: '#ffffff' };
var SC_MAX_DAYS_ = 62;
var SC_MAX_NEW_BLOCKS_ = 8;

/* ------------------------------------------------------------------------ */
/* Settings (pure)                                                           */
/* ------------------------------------------------------------------------ */

/** One copy with defaults. Pure. */
function normalizeScheduleCopy_(c, i) {
  c = c || {};
  var ar = c.aircall || {};
  var hm = function (v, d) { var m = hmToMinutes_(str_(v)); return m === null ? d : minutesToHm_(m % 1440); };
  return {
    id: str_(c.id) || 'copy' + ((i || 0) + 1),
    name: str_(c.name) || 'Schedule copy',
    on: c.on !== false,
    url: str_(c.url),
    tab: str_(c.tab) || 'HUN shifts',
    teamIds: (Array.isArray(c.teamIds) ? c.teamIds : []).map(str_).filter(Boolean),
    addBlocks: c.addBlocks !== false,
    // Aircall (purple): a shift type ending with typeEnds (as its own word, e.g. "SSC - CS - NOR A"), or, when on,
    // a shift (not a shift lead's) overlapping from–to, as the old NOR rule.
    aircall: { on: ar.on !== false, from: hm(ar.from, '08:00'), to: hm(ar.to, '14:00'), typeEnds: ar.typeEnds === undefined ? 'A' : str_(ar.typeEnds) },
    leadWords: c.leadWords === undefined ? 'shift lead' : str_(c.leadWords),
    // Shift leads (role or name has a lead word) are listed last in a new block, with this before their name.
    leadPrefix: c.leadPrefix === undefined ? 'Shift Lead - ' : String(c.leadPrefix),
    keepWords: c.keepWords === undefined ? 'vacation, sick, paid leave, leave' : str_(c.keepWords)
  };
}

function normalizeScheduleCopySettings_(s) {
  s = s || {};
  return { copies: (Array.isArray(s.copies) ? s.copies : []).map(normalizeScheduleCopy_) };
}

/** The spreadsheet ID in a link (…/d/<id>/…) or a bare ID, or ''. Pure. */
function scheduleCopySpreadsheetId_(url) {
  var u = str_(url), m = /\/d\/([A-Za-z0-9_-]{20,})/.exec(u) || /^([A-Za-z0-9_-]{20,})$/.exec(u);
  return m ? m[1] : '';
}

/** What is wrong with a copy (empty when it can be saved). Pure. */
function validateScheduleCopy_(c) {
  var e = [];
  if (!scheduleCopySpreadsheetId_(c.url)) e.push('"' + c.name + '": paste the link of the other spreadsheet.');
  if (!c.teamIds.length) e.push('"' + c.name + '": choose at least one team.');
  if (hmToMinutes_(c.aircall.from) >= hmToMinutes_(c.aircall.to)) e.push('"' + c.name + '": the Aircall time must end after it starts.');
  return e;
}

function getScheduleCopySettings_() {
  return normalizeScheduleCopySettings_(parseJson_(getConfig_()[SCHEDULE_COPY_KEY_], {}));
}

/* ------------------------------------------------------------------------ */
/* The other sheet's layout and the cells (pure)                             */
/* ------------------------------------------------------------------------ */

/** ISO week number of a date. Pure. */
function scheduleCopyWeekNo_(iso) {
  var n = dayNumber_(iso), thu = n - (n + 3) % 7 + 3;
  return Math.floor((thu - dayNumber_(isoFromDayNumber_(thu).substr(0, 4) + '-01-01')) / 7) + 1;
}

/** A name as a match key: case, accents, emojis, punctuation, spaces and the shift-lead words ignored. Pure. */
function scheduleCopyKey_(name, leadWords) {
  var t = ' ' + normText_(name) + ' ';
  String(leadWords || '').split(',').map(normText_).filter(Boolean).forEach(function (w) { t = t.split(' ' + w + ' ').join(' '); });
  return t.replace(/\s+/g, '');
}

function scheduleCopyHasWord_(text, words) {
  var t = ' ' + normText_(text) + ' ';
  return String(words || '').split(',').map(normText_).filter(Boolean).some(function (w) { return t.indexOf(' ' + w + ' ') >= 0; });
}

/**
 * The week blocks of the tab: a dates row has consecutive dates in B and C. Rows are 1-based.
 * @param {Array<Array>} values the tab's cells (at least 8 columns)
 * @param {function(*): string} isoOf a cell → "yyyy-MM-dd" or ''
 * @return {Array<{dateRow: number, monday: string, dates: string[], firstRow: number, lastRow: number}>}
 */
function scheduleCopyBlocks_(values, isoOf) {
  var blocks = [];
  for (var r = 0; r < values.length; r++) {
    var d0 = isoOf(values[r][1]);
    if (!d0 || isoOf(values[r][2]) !== addDays_(d0, 1)) continue;
    var dates = [];
    for (var c = 0; c < 7; c++) dates.push(addDays_(d0, c));
    blocks.push({ dateRow: r + 1, monday: d0, dates: dates, firstRow: r + 2 });
  }
  // A block ends before the next block's week row (the row above its dates).
  blocks.forEach(function (b, i) { b.lastRow = blocks[i + 1] ? blocks[i + 1].dateRow - 2 : values.length; });
  return blocks;
}

/**
 * Each person's shifts per day: {key: {date: {start, end, types}}}, start/end in absolute minutes (earliest start,
 * latest end of the day's shifts; meetings and removed records left out). Pure.
 */
function scheduleCopyShifts_(records, leadWords) {
  var out = {};
  records.forEach(function (r) {
    if (r.recordStatus === RECORD_STATUS.REMOVED || activityCategoryOf_(r) !== ACTIVITY_CATEGORY.SHIFT) return;
    if (!r.shiftDate || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(r.shiftStart) || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(r.shiftEnd)) return;
    var key = scheduleCopyKey_(r.employeeName, leadWords);
    if (!key) return;
    var s = wallMinutes_(r.shiftStart), e = wallMinutes_(r.shiftEnd);
    var day = (out[key] = out[key] || {}), x = day[r.shiftDate];
    if (!x) day[r.shiftDate] = { start: s, end: e, types: [r.shiftType], name: r.employeeName };
    else { x.start = Math.min(x.start, s); x.end = Math.max(x.end, e); x.types.push(r.shiftType); }
  });
  return out;
}

function scheduleCopyShiftText_(x) {
  return minutesToHm_(x.start) + ' - ' + minutesToHm_(x.end);
}

/** Aircall: the shift type ends with typeEnds, or (not for shift leads) the shift overlaps the Aircall time that day. Pure. */
function scheduleCopyIsAircall_(x, isLead, a) {
  var end = normText_(a.typeEnds);
  if (end && x.types.some(function (t) { var n = normText_(t); return n === end || n.slice(-end.length - 1) === ' ' + end; })) return true;
  if (!a.on || isLead) return false;
  var base = Math.floor(x.start / 1440) * 1440;
  return x.start < base + hmToMinutes_(a.to) && x.end > base + hmToMinutes_(a.from);
}

/** Text and colors of one cell, as the old sheet: {value, bg, fc}. Pure. */
function scheduleCopyStyle_(text, isLead, aircall) {
  var t = str_(text), low = t.toLowerCase(), C = SC_COLORS;
  if (!t || low === 'day off') return { value: 'Day Off', bg: C.dayOff, fc: '#000000' };
  if (low.indexOf('paid leave') >= 0) return { value: t, bg: C.paidLeave, fc: '#000000' };
  if (low.indexOf('vacation') >= 0) return { value: t, bg: C.vacation, fc: '#ffffff' };
  if (low.indexOf('sick') >= 0) return { value: t, bg: C.sick, fc: '#000000' };
  if (aircall) return { value: t, bg: C.aircall, fc: '#000000' };
  if (/\d:\d\d/.test(t)) return { value: t, bg: isLead ? C.lead : C.shift, fc: '#000000' };
  return { value: t, bg: C.other, fc: '#000000' };
}

/**
 * Fills one block's cells for the chosen dates. Pure: changes grid in place.
 * @param {{dates: string[]}} block
 * @param {Array} names column A of the block's rows
 * @param {{values: Array<Array>, bgs: Array<Array>, fcs: Array<Array>}} grid columns B–H of the same rows
 * @param {Object<string, boolean>} dates the dates to write
 * @param {Object} shifts scheduleCopyShifts_
 * @param {Object<string, boolean>} known the team's people (keys); other rows are never touched
 * @param {Object} c the copy
 * @return {{shifts: number, dayOff: number, kept: number, matched: Object<string, boolean>}}
 */
function scheduleCopyFill_(block, names, grid, dates, shifts, known, c) {
  var out = { shifts: 0, dayOff: 0, kept: 0, matched: {} };
  var keys = Object.keys(known);
  var resolve = function (key) {
    if (known[key]) return key;
    // A suffix such as "NOR" after the name: the one person whose key starts the same, at most 4 letters apart.
    var hits = keys.filter(function (k) { return (key.indexOf(k) === 0 || k.indexOf(key) === 0) && Math.abs(k.length - key.length) <= 4; });
    return hits.length === 1 ? hits[0] : '';
  };
  names.forEach(function (n, i) {
    var name = str_(n), norm = normText_(name);
    if (!name || norm === 'support associate' || /^week \d+$/.test(norm)) return;
    var key = resolve(scheduleCopyKey_(name, c.leadWords));
    if (!key) return;
    out.matched[key] = true;
    var isLead = scheduleCopyHasWord_(name, c.leadWords);
    block.dates.forEach(function (d, j) {
      if (!dates[d]) return;
      var x = shifts[key] && shifts[key][d];
      if (!x && scheduleCopyHasWord_(grid.values[i][j], c.keepWords)) { out.kept++; return; }
      var st = x ? scheduleCopyStyle_(scheduleCopyShiftText_(x), isLead, scheduleCopyIsAircall_(x, isLead, c.aircall)) : scheduleCopyStyle_('', isLead, false);
      grid.values[i][j] = st.value; grid.bgs[i][j] = st.bg; grid.fcs[i][j] = st.fc;
      if (x) out.shifts++; else out.dayOff++;
    });
  });
  return out;
}

/**
 * Column A of a new block, as the old "Create a new weekly block": the staff A–Z, two empty rows, then the shift
 * leads (role or name has a lead word) A–Z with the lead prefix. Each person once. Pure.
 * @param {Array<{name: string, role: string}>} people
 */
function scheduleCopyBlockNames_(people, c) {
  var seen = {}, regular = [], leads = [];
  people.forEach(function (p) {
    var k = scheduleCopyKey_(p.name, c.leadWords);
    if (!k || seen[k]) return;
    seen[k] = true;
    if (scheduleCopyHasWord_(p.role, c.leadWords) || scheduleCopyHasWord_(p.name, c.leadWords)) {
      leads.push(scheduleCopyHasWord_(p.name, c.leadWords) ? p.name : c.leadPrefix + p.name);
    } else regular.push(p.name);
  });
  var byName = function (a, b) { return a.localeCompare(b); };
  regular.sort(byName); leads.sort(byName);
  return regular.concat(leads.length && regular.length ? ['', ''] : [], leads).map(function (n) { return [n]; });
}

/* ------------------------------------------------------------------------ */
/* Copying                                                                   */
/* ------------------------------------------------------------------------ */

function scheduleCopyOpen_(c) {
  var id = scheduleCopySpreadsheetId_(c.url);
  if (!id) fail_('VALIDATION', '"' + c.name + '": no spreadsheet link.');
  var ss;
  try { ss = SpreadsheetApp.openById(id); } catch (e) {
    fail_('NO_ACCESS', '"' + c.name + '": the other spreadsheet cannot be opened. Check the link, and that you can edit it.');
  }
  var sh = ss.getSheetByName(c.tab);
  if (!sh) fail_('NOT_FOUND', '"' + c.name + '": the other spreadsheet has no tab "' + c.tab + '".');
  return { ss: ss, sh: sh, tz: ss.getSpreadsheetTimeZone() };
}

function scheduleCopyRead_(t) {
  if (t.sh.getMaxColumns() < 8) t.sh.insertColumnsAfter(t.sh.getMaxColumns(), 8 - t.sh.getMaxColumns());
  var lr = Math.max(1, t.sh.getLastRow());
  var values = t.sh.getRange(1, 1, lr, 8).getValues();
  var isoOf = function (v) { return cellToIsoDate_(v, t.tz); };
  return { values: values, blocks: scheduleCopyBlocks_(values, isoOf) };
}

/** The team's people from their staff sheets: {people: [{name, role}], known: {key: true}}. */
function scheduleCopyStaff_(c) {
  var out = { people: [], known: {} };
  listTeams_().filter(function (t) { return c.teamIds.indexOf(t.teamId) >= 0; }).forEach(function (t) {
    try {
      readStaff_(t).rows.forEach(function (p) {
        var k = scheduleCopyKey_(p.employeeName, c.leadWords);
        if (!k) return;
        out.known[k] = true;
        out.people.push({ name: p.employeeName, role: str_(p.fields.role) });
      });
    } catch (e) { logError_('scheduleCopyStaff_', e); }
  });
  return out;
}

/**
 * Adds a week block at the bottom, as the old "Create a new weekly block": two empty rows, the week row, the
 * dates row, the names (scheduleCopyBlockNames_); Nunito 10 with light grey borders.
 */
function scheduleCopyAddBlock_(sh, names, monday) {
  var start = sh.getLastRow() === 0 ? 1 : sh.getLastRow() + 3;
  var height = 2 + Math.max(1, names.length);
  if (sh.getMaxRows() < start + height - 1) sh.insertRowsAfter(sh.getMaxRows(), start + height - 1 - sh.getMaxRows());
  sh.getRange(start, 1, 1, 8).setBackground('#d9d9d9').setFontFamily('Nunito');
  sh.getRange(start, 2, 1, 7).merge().setValue('Week ' + scheduleCopyWeekNo_(monday)).setFontColor('black').setFontWeight('normal').setHorizontalAlignment('center');
  var dates = [];
  for (var i = 0; i < 7; i++) dates.push(addDays_(monday, i));
  sh.getRange(start + 1, 1, 1, 8).setBackground('#efefef').setFontFamily('Nunito');
  sh.getRange(start + 1, 1).setValue('Support Associate');
  sh.getRange(start + 1, 2, 1, 7).setNumberFormat('yyyy-mm-dd').setValues([dates]).setFontColor('black').setFontWeight('normal').setHorizontalAlignment('right');
  if (names.length) sh.getRange(start + 2, 1, names.length, 1).setValues(names);
  sh.getRange(start, 1, height, 8).setFontFamily('Nunito').setFontSize(10)
    .setBorder(true, true, true, true, true, true, '#cccccc', SpreadsheetApp.BorderStyle.SOLID);
}

/**
 * Writes the shifts of from–to into the other sheet (adding missing week blocks first when set).
 * @return {{text: string, shifts: number, dayOff: number, kept: number, added: string[], missingWeeks: string[], notFound: string[]}}
 */
function scheduleCopyRun_(c, from, to) {
  if (!isIsoDate_(from) || !isIsoDate_(to) || to < from) fail_('VALIDATION', 'Choose a date range.');
  if (dayNumber_(to) - dayNumber_(from) >= SC_MAX_DAYS_) fail_('VALIDATION', 'At most ' + SC_MAX_DAYS_ + ' days at a time.');
  var dates = [], dateSet = {};
  for (var d = from; d <= to; d = addDays_(d, 1)) { dates.push(d); dateSet[d] = true; }
  var records = queryScheduleRecords_({ teamIds: c.teamIds, dates: dates });
  var shifts = scheduleCopyShifts_(records, c.leadWords);
  // The team's people: everyone in their staff sheets, and everyone with a shift in these days.
  var staff = scheduleCopyStaff_(c), known = staff.known;
  Object.keys(shifts).forEach(function (k) { known[k] = true; });

  var t = scheduleCopyOpen_(c), data = scheduleCopyRead_(t), added = [];
  if (c.addBlocks) {
    added = scheduleCopyAddWeeks_(c, t, data, weekStartOf_(from), weekStartOf_(to), staff);
    if (added.length) data = scheduleCopyRead_(t);
  }
  if (!data.blocks.length) fail_('NOT_FOUND', '"' + c.tab + '" has no week block yet (a row with "Support Associate" and the dates in B–H).');

  var res = { shifts: 0, dayOff: 0, kept: 0, added: added, missingWeeks: [], notFound: [] }, matched = {}, covered = {};
  data.blocks.forEach(function (b) {
    var cols = b.dates.map(function (x, j) { return dateSet[x] ? j : -1; }).filter(function (j) { return j >= 0; });
    if (!cols.length) return;
    b.dates.forEach(function (x) { if (dateSet[x]) covered[x] = true; });
    var rows = b.lastRow - b.firstRow + 1;
    if (rows < 1) return;
    var range = t.sh.getRange(b.firstRow, 2, rows, 7);
    var grid = { values: range.getValues(), bgs: range.getBackgrounds(), fcs: range.getFontColors() };
    var names = data.values.slice(b.firstRow - 1, b.lastRow).map(function (r) { return r[0]; });
    var f = scheduleCopyFill_(b, names, grid, dateSet, shifts, known, c);
    Object.keys(f.matched).forEach(function (k) { matched[k] = true; });
    res.shifts += f.shifts; res.dayOff += f.dayOff; res.kept += f.kept;
    if (!f.shifts && !f.dayOff) return;
    // Only the columns of the chosen dates are written back (a contiguous run inside the week).
    var c0 = cols[0], n = cols[cols.length - 1] - c0 + 1, cut = function (g) { return g.map(function (r) { return r.slice(c0, c0 + n); }); };
    t.sh.getRange(b.firstRow, 2 + c0, rows, n).setValues(cut(grid.values)).setBackgrounds(cut(grid.bgs)).setFontColors(cut(grid.fcs))
      .setFontFamily('Arial').setFontSize(10).setHorizontalAlignment('center').setVerticalAlignment('middle');
  });
  var weeks = {};
  dates.forEach(function (x) { if (!covered[x]) weeks[weekStartOf_(x)] = true; });
  res.missingWeeks = Object.keys(weeks).sort().map(function (m) { return 'Week ' + scheduleCopyWeekNo_(m) + ' (' + m + ')'; });
  Object.keys(shifts).forEach(function (k) {
    if (matched[k]) return;
    var any = shifts[k][Object.keys(shifts[k])[0]];
    res.notFound.push(any.name);
  });
  res.notFound.sort();
  res.text = 'Copied ' + from + (to !== from ? ' – ' + to : '') + ' into "' + c.tab + '": ' + res.shifts + ' shift(s), ' + res.dayOff + ' day(s) off' +
    (res.kept ? ', ' + res.kept + ' absence(s) kept' : '') + '.' +
    (added.length ? ' Added ' + added.join(', ') + '.' : '') +
    (res.missingWeeks.length ? ' No block for ' + res.missingWeeks.join(', ') + '.' : '') +
    (res.notFound.length ? ' Not in the sheet: ' + res.notFound.slice(0, 10).join(', ') + (res.notFound.length > 10 ? ' and ' + (res.notFound.length - 10) + ' more' : '') + '.' : '');
  return res;
}

/**
 * Adds the week blocks after the last one up to the week of monday (each with the team's staff). An empty tab
 * starts with the week of firstMonday. @return {string[]} the weeks added, e.g. "Week 45"
 */
function scheduleCopyAddWeeks_(c, t, data, firstMonday, monday, staff) {
  var names = scheduleCopyBlockNames_(staff.people, c), added = [];
  var last = data.blocks.length ? data.blocks[data.blocks.length - 1].monday : addDays_(firstMonday, -7);
  while (last < monday && added.length < SC_MAX_NEW_BLOCKS_) {
    last = addDays_(last, 7);
    scheduleCopyAddBlock_(t.sh, names, last);
    added.push('Week ' + scheduleCopyWeekNo_(last));
  }
  if (added.length) SpreadsheetApp.flush();
  return added;
}

/**
 * Weekly time-driven trigger (added by the user: Triggers → scheduleCopyWeeklyTick, Week timer, Sunday, 6am–7am):
 * adds next week's block to every switched-on copy that has none yet. Run again, it adds nothing.
 */
function scheduleCopyWeeklyTick() {
  try {
    if (!getConfig_()[SCHEDULE_COPY_KEY_]) return;
    var next = addDays_(weekStartOf_(todayIso_()), 7);
    getScheduleCopySettings_().copies.forEach(function (c) {
      if (!c.on || !c.addBlocks || validateScheduleCopy_(c).length) return;
      try {
        withLock_(function () { var t = scheduleCopyOpen_(c); scheduleCopyAddWeeks_(c, t, scheduleCopyRead_(t), next, next, scheduleCopyStaff_(c)); }, 60000);
      } catch (e) { logError_('scheduleCopyWeeklyTick.' + c.id, e); }
    });
  } catch (e2) { logError_('scheduleCopyWeeklyTick', e2); }
}

/** After an import (ImportService.gs): every switched-on copy of the imported teams, for the imported days. Never throws. */
function scheduleCopyAfterImport_(info) {
  var out = { notes: [], warnings: [] };
  if (!info || !info.dateFrom || !getConfig_()[SCHEDULE_COPY_KEY_]) return out;
  getScheduleCopySettings_().copies.forEach(function (c) {
    if (!c.on || !c.teamIds.some(function (id) { return (info.teamIds || []).indexOf(id) >= 0; })) return;
    try {
      var r = scheduleCopyRun_(c, info.dateFrom, info.dateTo || info.dateFrom);
      (r.notFound.length || r.missingWeeks.length ? out.warnings : out.notes).push(c.name + ': ' + r.text);
    } catch (e) {
      logError_('scheduleCopyAfterImport_', e);
      out.warnings.push(c.name + ': not copied. ' + toUserError_(e).message + ' Copy it later from Extensions → Copy Schedules to Another Sheet.');
    }
  });
  return out;
}

/* ------------------------------------------------------------------------ */
/* APIs                                                                      */
/* ------------------------------------------------------------------------ */

function menuScheduleCopy() {
  menuRun_('menuScheduleCopy', function () { showHtml_('ScheduleCopyDialog', 'Copy Schedules to Another Sheet', {}, DIALOG_SIZE.LARGE); });
}

function apiScheduleCopyBootstrap() {
  return apiCall_('apiScheduleCopyBootstrap', function () {
    requireInitialized_();
    return { settings: getScheduleCopySettings_(), teams: listTeams_().map(function (t) { return { teamId: t.teamId, teamName: t.teamName }; }),
      today: todayIso_(), defaults: normalizeScheduleCopy_({}) };
  });
}

function apiScheduleCopySave(settings) {
  return apiCall_('apiScheduleCopySave', function () {
    var s = normalizeScheduleCopySettings_(settings);
    var errors = [];
    s.copies.forEach(function (c) { errors = errors.concat(validateScheduleCopy_(c)); });
    if (errors.length) fail_('VALIDATION', errors.join(' '));
    return withLock_(function () {
      var u = {};
      u[SCHEDULE_COPY_KEY_] = JSON.stringify(s);
      setConfigValues_(u);
      return { settings: s };
    });
  });
}

/** Opens the other sheet and describes what it found (nothing is written). */
function apiScheduleCopyCheck(copy) {
  return apiCall_('apiScheduleCopyCheck', function () {
    var c = normalizeScheduleCopy_(copy);
    var t = scheduleCopyOpen_(c), data = scheduleCopyRead_(t), last = data.blocks[data.blocks.length - 1];
    var people = last ? data.values.slice(last.firstRow - 1, last.lastRow).filter(function (r) { return str_(r[0]); }).length : 0;
    return { title: t.ss.getName(), url: t.ss.getUrl() + '#gid=' + t.sh.getSheetId(), blocks: data.blocks.length,
      last: last ? { week: 'Week ' + scheduleCopyWeekNo_(last.monday), from: last.monday, to: last.dates[6], people: people } : null };
  });
}

/** Copies the days from–to now, with the (unsaved) copy settings. */
function apiScheduleCopyNow(copy, from, to) {
  return apiCall_('apiScheduleCopyNow', function () {
    requireInitialized_();
    var c = normalizeScheduleCopy_(copy), errors = validateScheduleCopy_(c);
    if (errors.length) fail_('VALIDATION', errors.join(' '));
    return withLock_(function () { return scheduleCopyRun_(c, str_(from), str_(to) || str_(from)); }, 60000);
  });
}

/* ------------------------------------------------------------------------ */
/* Tests                                                                     */
/* ------------------------------------------------------------------------ */

function scheduleCopyUnitTests_() {
  var c = normalizeScheduleCopy_({ url: 'https://docs.google.com/spreadsheets/d/13EJoMcNtT4DxT4Kc17F-myjnGUAIZsHgACdc3e8MFB0/edit#gid=0', teamIds: ['T1'] });
  var rec = function (name, start, end, type, extra) {
    return Object.assign({ employeeName: name, shiftDate: start.substr(0, 10), shiftStart: start, shiftEnd: end, shiftType: type || 'SSC - CS - NOR', recordStatus: 'ACTIVE', activityCategory: 'SHIFT' }, extra || {});
  };
  return [
    ['Schedule copy: settings, link and week numbers', function () {
      assertEq_([c.tab, c.on, c.addBlocks, c.aircall.on, c.aircall.from, c.aircall.to, c.aircall.typeEnds, c.leadWords], ['HUN shifts', true, true, true, '08:00', '14:00', 'A', 'shift lead']);
      assertEq_([scheduleCopySpreadsheetId_(c.url), scheduleCopySpreadsheetId_('nope')], ['13EJoMcNtT4DxT4Kc17F-myjnGUAIZsHgACdc3e8MFB0', '']);
      assertEq_(validateScheduleCopy_(c), []);
      assertEq_(validateScheduleCopy_(normalizeScheduleCopy_({ name: 'X' })).length, 2, 'a link and a team are needed');
      assertEq_([scheduleCopyWeekNo_('2026-10-26'), scheduleCopyWeekNo_('2026-01-01'), scheduleCopyWeekNo_('2025-12-29'), scheduleCopyWeekNo_('2027-01-03')], [44, 1, 1, 53]);
    }],
    ['Schedule copy: names match ignoring case, accents, emojis and "Shift Lead -"', function () {
      assertEq_([scheduleCopyKey_('Anna Kovács 🇳🇴', 'shift lead'), scheduleCopyKey_('Shift Lead - ANNA kovacs', 'shift lead'), scheduleCopyKey_('anna  kovacs', 'shift lead')],
        ['annakovacs', 'annakovacs', 'annakovacs']);
      assert_(scheduleCopyHasWord_('Shift Lead - Ben', 'shift lead') && !scheduleCopyHasWord_('Ben Shiftleader', 'shift lead'));
    }],
    ['Schedule copy: week blocks found by their dates row', function () {
      var dates = function (m) { var r = ['Support Associate']; for (var i = 0; i < 7; i++) r.push(addDays_(m, i)); return r; };
      var blank = ['', '', '', '', '', '', '', ''];
      var values = [['', 'Week 43', '', '', '', '', '', ''], dates('2026-10-19'), ['Anna', '', '', '', '', '', '', ''], ['Ben', '', '', '', '', '', '', ''], blank, blank,
        ['', 'Week 44', '', '', '', '', '', ''], dates('2026-10-26'), ['Anna', '17:00 - 23:00', '', '', '', '', '', ''], blank, ['Shift Lead - Cid', '', '', '', '', '', '', '']];
      var b = scheduleCopyBlocks_(values, function (v) { return isIsoDate_(str_(v)) ? str_(v) : ''; });
      assertEq_(b.map(function (x) { return [x.dateRow, x.monday, x.firstRow, x.lastRow, x.dates[6]]; }), [[2, '2026-10-19', 3, 6, '2026-10-25'], [8, '2026-10-26', 9, 11, '2026-11-01']]);
      var people = [{ name: 'Ben Ray', role: '' }, { name: 'Cid Moe', role: 'Support Shift Lead' }, { name: 'Anna Kovács', role: 'Agent' }, { name: 'Shift Lead - Dee Fox', role: '' }, { name: 'ben  ray', role: '' }];
      assertEq_(scheduleCopyBlockNames_(people, c), [['Anna Kovács'], ['Ben Ray'], [''], [''], ['Shift Lead - Cid Moe'], ['Shift Lead - Dee Fox']],
        'a new block: staff A–Z, two empty rows, the shift leads (by role or name) with the prefix; each person once');
      assertEq_(scheduleCopyBlockNames_([{ name: 'Ann', role: '' }], c), [['Ann']], 'no shift leads: no gap');
    }],
    ['Schedule copy: one cell per day, in the old colors', function () {
      var shifts = scheduleCopyShifts_([rec('Anna Kovács', '2026-10-26 17:00', '2026-10-26 23:00'), rec('Anna Kovács', '2026-10-27 08:00', '2026-10-27 12:00'),
        rec('Anna Kovács', '2026-10-27 12:30', '2026-10-27 16:00'), rec('Ben Ray', '2026-10-26 23:40', '2026-10-27 08:00'),
        rec('Ben Ray', '2026-10-26 10:00', '2026-10-26 11:00', 'Meeting', { activityCategory: 'MEETING' }), rec('Ben Ray', '2026-10-27 09:00', '2026-10-27 15:00', 'SSC - CS - NOR', { recordStatus: 'REMOVED' })], 'shift lead');
      assertEq_(scheduleCopyShiftText_(shifts.annakovacs['2026-10-27']), '08:00 - 16:00', 'earliest start to latest end');
      assertEq_(scheduleCopyShiftText_(shifts.benray['2026-10-26']), '23:40 - 08:00', 'overnight, meetings left out');
      assert_(!shifts.benray['2026-10-27'], 'removed records left out');
      var a = c.aircall;
      assertEq_([scheduleCopyIsAircall_(shifts.annakovacs['2026-10-27'], false, a), scheduleCopyIsAircall_(shifts.annakovacs['2026-10-26'], false, a),
        scheduleCopyIsAircall_(shifts.annakovacs['2026-10-27'], true, a), scheduleCopyIsAircall_({ start: 14 * 60, end: 22 * 60, types: [] }, false, a),
        scheduleCopyIsAircall_({ start: 17 * 60, end: 23 * 60, types: ['SSC - CS - NOR A'] }, true, a)], [true, false, false, false, true],
        'overlapping 08:00–14:00 (not shift leads; starting at 14:00 is not), or a type ending with A');
      assertEq_([scheduleCopyStyle_('', false, false), scheduleCopyStyle_('17:00 - 23:00', false, false), scheduleCopyStyle_('17:00 - 23:00', true, false),
        scheduleCopyStyle_('08:00 - 14:00', false, true), scheduleCopyStyle_('Vacation', false, false)].map(function (x) { return [x.value, x.bg, x.fc]; }),
        [['Day Off', '#b6d7a8', '#000000'], ['17:00 - 23:00', '#ffe599', '#000000'], ['17:00 - 23:00', '#d9d9d9', '#000000'], ['08:00 - 14:00', '#b4a7d6', '#000000'], ['Vacation', '#4283ee', '#ffffff']]);
    }],
    ['Schedule copy: only the chosen days and the team\'s people are written; absences are kept', function () {
      var shifts = scheduleCopyShifts_([rec('Anna Kovács', '2026-10-26 17:00', '2026-10-26 23:00'), rec('Ben Ray', '2026-10-27 09:00', '2026-10-27 15:00')], 'shift lead');
      var known = { annakovacs: true, benray: true, cidmoe: true };
      var block = { dates: ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01'] };
      var row = function (v) { return [v, v, v, v, v, v, v]; };
      var grid = { values: [row('x'), row('x'), row('Vacation'), row('x'), row('x')], bgs: [row('#fff'), row('#fff'), row('#fff'), row('#fff'), row('#fff')], fcs: [row('k'), row('k'), row('k'), row('k'), row('k')] };
      var names = ['Anna Kovács 🇳🇴', 'Shift Lead - Ben Ray', 'Cid Moe', 'Someone Else', ''];
      var f = scheduleCopyFill_(block, names, grid, { '2026-10-26': true, '2026-10-27': true }, shifts, known, c);
      assertEq_(grid.values.map(function (r) { return r.slice(0, 3); }), [['17:00 - 23:00', 'Day Off', 'x'], ['Day Off', '09:00 - 15:00', 'x'], ['Vacation', 'Vacation', 'Vacation'], ['x', 'x', 'x'], ['x', 'x', 'x']]);
      assertEq_([grid.bgs[1][1], grid.bgs[0][0]], ['#d9d9d9', '#ffe599'], 'a shift lead\'s shift is grey (not Aircall)');
      assertEq_([f.shifts, f.dayOff, f.kept, Object.keys(f.matched).sort()], [2, 2, 2, ['annakovacs', 'benray', 'cidmoe']]);
      var g2 = { values: [row('x')], bgs: [row('')], fcs: [row('')] };
      scheduleCopyFill_(block, ['Anna Kovács NOR'], g2, { '2026-10-26': true }, shifts, known, c);
      assertEq_(g2.values[0][0], '17:00 - 23:00', 'a short suffix after the name still matches');
    }]
  ];
}
