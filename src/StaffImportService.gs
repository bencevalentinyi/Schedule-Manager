/**
 * StaffImportService.gs
 * Import Staff Data: fills staff-sheet columns (Employee ID, Email, Role, Notes, any own column…) from a
 * table — an uploaded file (CSV/XLSX), a tab of this spreadsheet, or another Google Sheet by its link.
 * One source column finds each person (Name, Employee ID, Email or any staff column); other source
 * columns fill staff columns. Nothing is written before the preview is confirmed, empty source cells
 * never clear anything, and existing different values are only replaced when that is ticked.
 *
 * The Quinyx "Custom report" (A1 "Custom report", A2 "Badge no.", B2 the name) is recognised: the
 * name finds the person and the badge becomes the Employee ID, as the former Employee ID import did.
 *
 * Dependencies: Utils.gs, ConfigService.gs, TeamService.gs, StaffService.gs, StaffFieldService.gs,
 *   QuinyxParser.gs (file and sheet reading), ImportService.gs (staging)
 */

var STAFF_IMPORT_LAST_PROP_ = 'SM_STAFF_IMPORT_LAST';
var STAFF_IMPORT_NAME_HEADERS_ = ['name', 'employee name', 'full name', 'first name, last name', 'name as first name, last name'];
var STAFF_IMPORT_ID_HEADERS_ = ['badge no.', 'badge no', 'badge number', 'badge', 'employee id', 'employee no.', 'employee number', 'id'];

/* ------------------------------------------------------------------------ */
/* Staff columns (targets)                                                   */
/* ------------------------------------------------------------------------ */

/**
 * Staff columns an import can find people by or fill in: Employee ID, Name (finding only), the standard
 * columns and every own column. kind: ID (Employee ID rules) | IDENTIFIER (no spaces) | EMAIL | TEXT;
 * unique = no two people in one staff sheet may share a value.
 */
function staffImportTargets_() {
  var out = [
    { key: 'employeeId', label: STAFF_FIELD_DEFS.employeeId.label, kind: 'ID', unique: true, fill: true },
    { key: 'employeeName', label: STAFF_FIELD_DEFS.employeeName.label, kind: 'TEXT', unique: false, fill: false }
  ];
  ['email', 'role', 'notes', 'team', 'skills'].forEach(function (k) {
    out.push({ key: k, label: STAFF_FIELD_DEFS[k].label, kind: k === 'email' ? 'EMAIL' : 'TEXT', unique: false, fill: true });
  });
  listStaffFields_().forEach(function (f) {
    var id = f.fieldType === 'IDENTIFIER';
    out.push({ key: STAFF_REGISTRY_PREFIX + f.fieldKey, label: f.displayName, kind: id ? 'IDENTIFIER' : 'TEXT', unique: id, fill: true });
  });
  return out;
}

/* ------------------------------------------------------------------------ */
/* Reading the source (pure helpers)                                         */
/* ------------------------------------------------------------------------ */

/** The column-name row: the first of the first 10 rows with two or more filled cells (1-based), or 1. Pure. */
function detectStaffImportHeader_(table) {
  for (var r = 0; r < Math.min(table.length, 10); r++) {
    var filled = (table[r] || []).filter(function (c) { return str_(c) !== ''; }).length;
    if (filled >= 2) return r + 1;
  }
  return 1;
}

/** The columns of the table under the header row: [{index, label, samples}]. Pure. */
function staffImportColumns_(table, headerRow) {
  var header = buildHeaders_(table[headerRow - 1] || []);
  return header.map(function (label, i) {
    var samples = [];
    for (var r = headerRow; r < table.length && samples.length < 3; r++) {
      var v = str_((table[r] || [])[i]);
      if (v) samples.push(v);
    }
    return { index: i, label: label, samples: samples };
  }).filter(function (c) { return c.samples.length || str_((table[headerRow - 1] || [])[c.index]); });
}

/**
 * A first guess of the mapping from the column names. Pure.
 * Name column → find people by Name; badge / employee ID column → fill (or, without a name column,
 * find by) Employee ID; a column named like a staff column (e.g. "Email", "Slack ID") → fill it.
 * @return {{matchColumn: number, matchField: string, fills: Array<{column: number, field: string}>}}
 */
function guessStaffImportMapping_(columns, targets) {
  var norm = function (s) { return str_(s).toLowerCase().replace(/\s+/g, ' ').trim(); };
  var nameCol = columns.filter(function (c) { return STAFF_IMPORT_NAME_HEADERS_.indexOf(norm(c.label)) >= 0 || /name/.test(norm(c.label)); })[0];
  var idCol = columns.filter(function (c) { return c !== nameCol && (STAFF_IMPORT_ID_HEADERS_.indexOf(norm(c.label)) >= 0 || /badge/.test(norm(c.label))); })[0];
  var out = { matchColumn: -1, matchField: 'employeeName', fills: [] };
  if (nameCol) { out.matchColumn = nameCol.index; if (idCol) out.fills.push({ column: idCol.index, field: 'employeeId' }); }
  else if (idCol) { out.matchColumn = idCol.index; out.matchField = 'employeeId'; }
  columns.forEach(function (c) {
    if (c === nameCol || c === idCol) return;
    var t = targets.filter(function (x) { return x.fill && norm(x.label) === norm(c.label); })[0];
    if (t && !out.fills.some(function (f) { return f.field === t.key; })) out.fills.push({ column: c.index, field: t.key });
  });
  return out;
}

/** The value a person is looked up by, for comparing: names ignore order of "Last, First" (see keys), IDs and others ignore case and spaces. Pure. */
function staffImportKey_(field, value, stripZeros) {
  var v = str_(value);
  if (!v) return '';
  if (field === 'employeeId') return idKey_(normalizeEmployeeId_(v, stripZeros));
  if (field === 'employeeName') return normName_(v.replace(/,/g, ' '));
  return v.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Name keys to try: as written (a comma is only a separator), then swapped for "Last, First". Pure. */
function staffImportNameKeys_(name) {
  var plain = normName_(name.replace(/,/g, ' '));
  var parts = name.split(',');
  var swapped = parts.length === 2 ? normName_(parts[1] + ' ' + parts[0]) : '';
  return { plain: plain, swapped: swapped && swapped !== plain ? swapped : '' };
}

/** The value as it will be written, or {error}. Pure. */
function staffImportValue_(target, raw, stripZeros) {
  var v = str_(raw).replace(/\s+/g, ' ').trim();
  if (target.kind === 'ID') {
    v = normalizeEmployeeId_(v, stripZeros);
    return EMPLOYEE_ID_PATTERN_.test(v) ? { value: v } : { error: 'An Employee ID may contain only letters, digits and . _ - / (max 40).' };
  }
  if (target.kind === 'IDENTIFIER') return EXTERNAL_ID_PATTERN_.test(v) ? { value: v } : { error: target.label + ' must not contain spaces (max 80 characters).' };
  if (target.kind === 'EMAIL') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? { value: v } : { error: '"' + v + '" is not an email address.' };
  return { value: v };
}

/* ------------------------------------------------------------------------ */
/* Planning (pure)                                                           */
/* ------------------------------------------------------------------------ */

/**
 * Plans an import. Pure.
 * @param {string[][]} table the source
 * @param {{headerRow, matchColumn, matchField, fills: [{column, field}], overwrite, stripZeros, teamIds?}} opts
 * @param {Array<{teamId, teamName, keys: string[], rows: [{_row, employeeId, employeeName, fields}]}>} sheets staff of every team
 * @param {Object[]} targets staffImportTargets_()
 * @return {{items, summary, errors}} item: {row, key, label, status, note, changes: [{teamId, teamName, row, field, fieldLabel, current, value, status, note}]}
 *   item status: NOT_FOUND | AMBIGUOUS | NO_KEY | DUPLICATE_IN_FILE | EMPTY, or the most important change status;
 *   change status: SET | SAME | CONFLICT | NO_COLUMN | IN_USE | INVALID_VALUE | DUP_VALUE
 */
function planStaffImport_(table, opts, sheets, targets) {
  opts = opts || {};
  var errors = [];
  var tById = {};
  targets.forEach(function (t) { tById[t.key] = t; });
  var headerRow = Math.max(1, Math.floor(toNumber_(opts.headerRow, 1)));
  var width = (table[headerRow - 1] || []).length;
  var matchT = tById[opts.matchField];
  if (!matchT) errors.push('Choose the staff column that finds each person.');
  if (!(opts.matchColumn >= 0 && opts.matchColumn < width)) errors.push('Choose the column that finds each person.');
  var fills = (opts.fills || []).filter(function (f) { return f && f.field && f.column >= 0; });
  fills.forEach(function (f) {
    if (!tById[f.field] || !tById[f.field].fill) errors.push('"' + f.field + '" cannot be filled in.');
    if (f.column === opts.matchColumn && f.field === opts.matchField) errors.push('The column that finds people cannot also overwrite itself.');
  });
  var dupTargets = fills.map(function (f) { return f.field; }).filter(function (k, i, a) { return a.indexOf(k) !== i; });
  if (dupTargets.length) errors.push('Each staff column can be filled from one column only (' + uniq_(dupTargets).map(function (k) { return tById[k] ? tById[k].label : k; }).join(', ') + ').');
  if (!fills.length) errors.push('Choose at least one column to fill in.');
  if (errors.length) return { items: [], summary: emptyStaffImportSummary_(), errors: errors };

  var chosen = (opts.teamIds || []).filter(Boolean);
  var use = sheets.filter(function (s) { return !chosen.length || chosen.indexOf(s.teamId) >= 0; });
  var strip = !!opts.stripZeros;
  /** Comparable form of a value of a unique column (Employee ID rules for that column, else case/space-insensitive). */
  var uniqueKey = function (t, v) { return staffImportKey_(t.key === 'employeeId' ? 'employeeId' : 'value', v, strip); };
  // Index every staff sheet by the matching column.
  var index = {}; // key -> [{si, r}]
  use.forEach(function (s, si) {
    s.rows.forEach(function (r) {
      var v = opts.matchField === 'employeeId' ? r.employeeId : opts.matchField === 'employeeName' ? r.employeeName : r.fields[opts.matchField];
      var k = staffImportKey_(opts.matchField, v, strip);
      if (k) (index[k] = index[k] || []).push({ si: si, r: r });
    });
  });

  var rows = [];
  for (var i = headerRow; i < table.length; i++) {
    var row = table[i] || [];
    if (row.every(function (c) { return str_(c) === ''; })) continue;
    rows.push({ row: i + 1, cells: row });
  }
  var keyCount = {}, valueCount = {};
  rows.forEach(function (x) {
    var k = staffImportKey_(opts.matchField, x.cells[opts.matchColumn], strip);
    if (k) keyCount[k] = (keyCount[k] || 0) + 1;
    fills.forEach(function (f) {
      var t = tById[f.field];
      if (!t.unique) return;
      var v = uniqueKey(t, x.cells[f.column]);
      if (v) { var vk = f.field + '|' + v; valueCount[vk] = (valueCount[vk] || 0) + 1; }
    });
  });

  var items = rows.map(function (x) {
    var raw = str_(x.cells[opts.matchColumn]).replace(/\s+/g, ' ').trim();
    var it = { row: x.row, key: raw, label: raw, status: '', note: '', changes: [] };
    if (!raw) { it.status = 'NO_KEY'; it.note = 'No ' + matchT.label + ' in this row.'; return it; }
    var key = staffImportKey_(opts.matchField, raw, strip);
    if (keyCount[key] > 1) { it.status = 'DUPLICATE_IN_FILE'; it.note = 'This ' + matchT.label + ' appears in several rows.'; return it; }
    var found = index[key] || [];
    if (!found.length && opts.matchField === 'employeeName') {
      var sw = staffImportNameKeys_(raw).swapped;
      if (sw && index[sw]) { found = index[sw]; it.note = 'Matched as "Last, First".'; }
    }
    if (!found.length) { it.status = 'NOT_FOUND'; it.note = 'Not in ' + (chosen.length ? 'the chosen' : 'any') + ' staff sheet.'; return it; }
    var perSheet = {};
    found.forEach(function (f) { perSheet[f.si] = (perSheet[f.si] || 0) + 1; });
    var dup = Object.keys(perSheet).filter(function (si) { return perSheet[si] > 1; })[0];
    if (dup !== undefined) { it.status = 'AMBIGUOUS'; it.note = 'Several people have this ' + matchT.label + ' in the staff sheet of ' + use[dup].teamName + '.'; return it; }
    it.label = found[0].r.employeeName || raw;
    found.forEach(function (f) {
      var s = use[f.si];
      fills.forEach(function (fl) {
        var t = tById[fl.field];
        var src = str_(x.cells[fl.column]);
        if (!src) return; // an empty cell never clears anything
        var ch = { teamId: s.teamId, teamName: s.teamName, row: f.r._row, field: t.key, fieldLabel: t.label, current: '', value: '', status: '', note: '' };
        it.changes.push(ch);
        if (s.keys.indexOf(t.key) < 0) { ch.status = 'NO_COLUMN'; ch.note = 'The staff sheet of ' + s.teamName + ' has no ' + t.label + ' column.'; return; }
        var v = staffImportValue_(t, src, strip);
        if (v.error) { ch.status = 'INVALID_VALUE'; ch.value = src; ch.note = v.error; return; }
        ch.value = v.value;
        ch.current = str_(t.key === 'employeeId' ? f.r.employeeId : f.r.fields[t.key]);
        if (t.unique) {
          var mine = uniqueKey(t, v.value);
          if (valueCount[t.key + '|' + mine] > 1) { ch.status = 'DUP_VALUE'; ch.note = 'This ' + t.label + ' is given to several people in the file.'; return; }
          var other = s.rows.filter(function (o) {
            var ov = t.key === 'employeeId' ? o.employeeId : o.fields[t.key];
            return o !== f.r && ov && uniqueKey(t, ov) === mine;
          })[0];
          if (other) { ch.status = 'IN_USE'; ch.note = 'Already used by ' + other.employeeName + ' in ' + s.teamName + '.'; return; }
        }
        // Same value already there: IDs by their ID rules, emails ignoring capitals, other text exactly.
        var same = t.unique ? uniqueKey(t, ch.current) === uniqueKey(t, ch.value)
          : t.kind === 'EMAIL' ? ch.current.toLowerCase() === ch.value.toLowerCase() : ch.current === ch.value;
        ch.status = !ch.current ? 'SET' : same ? 'SAME' : 'CONFLICT';
        if (ch.status === 'CONFLICT') ch.note = 'Now "' + ch.current + '".';
      });
    });
    var order = ['INVALID_VALUE', 'DUP_VALUE', 'IN_USE', 'CONFLICT', 'NO_COLUMN', 'SET', 'SAME'];
    it.status = order.filter(function (st) { return it.changes.some(function (c) { return c.status === st; }); })[0] || 'EMPTY';
    if (it.status === 'EMPTY') it.note = 'Nothing to fill in (the columns are empty in this row).';
    else if (!it.note) it.note = (it.changes.filter(function (c) { return c.status === it.status && c.note; })[0] || {}).note || '';
    return it;
  });

  // Two rows of the file that find the same person (e.g. "Ann Lee" and "Lee, Ann") would write
  // different values into one row: neither is used.
  var byPerson = {};
  items.forEach(function (it) {
    uniq_(it.changes.map(function (c) { return c.teamId + '|' + c.row; })).forEach(function (k) { (byPerson[k] = byPerson[k] || []).push(it); });
  });
  Object.keys(byPerson).forEach(function (k) {
    if (byPerson[k].length < 2) return;
    var rowsOf = byPerson[k].map(function (it) { return it.row; }).join(', ');
    byPerson[k].forEach(function (it) {
      it.status = 'DUPLICATE_IN_FILE'; it.changes = [];
      it.note = 'Rows ' + rowsOf + ' of the file are the same person; fix them so only one row is left.';
    });
  });

  var S = emptyStaffImportSummary_();
  S.rows = items.length;
  items.forEach(function (it) {
    if (it.status === 'NOT_FOUND') S.notFound++;
    else if (['AMBIGUOUS', 'NO_KEY', 'DUPLICATE_IN_FILE'].indexOf(it.status) >= 0) S.problems++;
    else S.matched++;
    it.changes.forEach(function (c) {
      if (c.status === 'SET') S.set++;
      else if (c.status === 'SAME') S.same++;
      else if (c.status === 'CONFLICT') S.conflict++;
      else S.problems++;
      if (c.status === 'SET' || (c.status === 'CONFLICT' && opts.overwrite)) S.writes++;
    });
  });
  return { items: items, summary: S, errors: [] };
}

function emptyStaffImportSummary_() {
  return { rows: 0, matched: 0, notFound: 0, set: 0, same: 0, conflict: 0, problems: 0, writes: 0 };
}

/* ------------------------------------------------------------------------ */
/* Spreadsheet side                                                          */
/* ------------------------------------------------------------------------ */

/** Staff of every READY team, as planStaffImport_ expects (plus the read sheet for writing). */
function staffSheetsForImport_() {
  return listTeams_().filter(function (t) { return t.status === TEAM_STATUS.READY; }).map(function (t) {
    var st = null;
    try { st = readStaff_(t); } catch (e) { logError_('staffSheetsForImport_', e); }
    return { teamId: t.teamId, teamName: t.teamName, staff: st, keys: st ? st.keys : [],
      rows: st ? st.rows.map(function (r) { return { _row: r._row, employeeId: r.employeeId, employeeName: r.employeeName, fields: r.fields }; }) : [] };
  });
}

/** Reads a tab of another Google Sheet (link or ID); without a tab name, its first tab. */
function readOtherSpreadsheetTable_(urlOrId, tabName) {
  var ref = str_(urlOrId);
  if (!ref) fail_('VALIDATION', 'Paste the link of the Google Sheet.');
  var m = /\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(ref);
  var id = m ? m[1] : (/^[A-Za-z0-9_-]{20,}$/.test(ref) ? ref : '');
  if (!id) fail_('VALIDATION', 'That is not a Google Sheets link. Copy it from the browser\'s address bar (it contains /spreadsheets/d/…).');
  var ss;
  try { ss = SpreadsheetApp.openById(id); } catch (e) {
    fail_('NO_ACCESS', 'That Google Sheet cannot be opened. Check the link and that you (the account running this) can open it.');
  }
  var sh = tabName ? ss.getSheetByName(tabName) : ss.getSheets()[0];
  if (!sh) fail_('NOT_FOUND', 'The tab "' + tabName + '" is not in "' + ss.getName() + '".');
  if (sh.getLastRow() < 1) fail_('VALIDATION', 'The tab "' + sh.getName() + '" is empty.');
  return { table: trimTable_(valuesToStrings_(sh.getDataRange().getValues(), getTz_())), name: ss.getName() + ' › ' + sh.getName(), tabs: ss.getSheets().map(function (s) { return s.getName(); }) };
}

function staffImportOptions_(o) {
  o = o || {};
  return {
    headerRow: Math.max(1, Math.floor(toNumber_(o.headerRow, 1))), matchColumn: Math.floor(toNumber_(o.matchColumn, -1)), matchField: str_(o.matchField),
    fills: (Array.isArray(o.fills) ? o.fills : []).map(function (f) { return { column: Math.floor(toNumber_(f && f.column, -1)), field: str_(f && f.field) }; }),
    overwrite: !!o.overwrite, teamIds: (Array.isArray(o.teamIds) ? o.teamIds : []).map(str_).filter(Boolean),
    stripZeros: cfgBool_(getConfig_(), 'STRIP_LEADING_ZEROS')
  };
}

function staffImportPlanFor_(stageId, o) {
  var staged = loadStaged_(stageId);
  var opts = staffImportOptions_(o);
  var sheets = staffSheetsForImport_();
  var targets = staffImportTargets_();
  return { staged: staged, opts: opts, sheets: sheets, targets: targets, plan: planStaffImport_(staged.table, opts, sheets, targets) };
}

/** What the dialog shows for a staged source: its columns (for a header row), a guessed or remembered mapping. */
function staffImportSourceForClient_(stageId, staged, headerRow) {
  var table = staged.table;
  var hr = headerRow || detectStaffImportHeader_(table);
  var columns = staffImportColumns_(table, hr);
  var targets = staffImportTargets_();
  var mapping = guessStaffImportMapping_(columns, targets);
  // A layout seen before (same column names, e.g. a Quinyx or an Aircall report): reuse its mapping.
  var remembered = rememberedStaffImportMapping_(loadStaffImportMemory_(), columns.map(function (c) { return c.label; }));
  if (remembered) mapping = remembered;
  return { stageId: stageId, name: staged.meta.fileName, headerRow: hr, rows: table.length, columns: columns, mapping: mapping,
    remembered: !!remembered, quinyx: /custom report/i.test(str_((table[0] || [])[0])) };
}

/* ---------- remembered column choices, one per column layout ---------- */

var STAFF_IMPORT_MEMORY_MAX_ = 20;

/** The layout key of a source: its column names, ignoring capitals and spaces. Pure. */
function staffImportLayoutKey_(labels) {
  return labels.map(function (l) { return str_(l).toLowerCase().replace(/\s+/g, ' ').trim(); }).join('\u0001');
}

/** The mapping remembered for these column names, or null. Pure. */
function rememberedStaffImportMapping_(memory, labels) {
  var key = staffImportLayoutKey_(labels);
  var hit = (memory || []).filter(function (m) { return m.key === key; })[0];
  return hit ? hit.mapping : null;
}

/** The memory with this layout's mapping first (newest), at most STAFF_IMPORT_MEMORY_MAX_ layouts. Pure. */
function rememberStaffImportMapping_(memory, labels, mapping) {
  var key = staffImportLayoutKey_(labels);
  return [{ key: key, mapping: mapping }].concat((memory || []).filter(function (m) { return m.key !== key; })).slice(0, STAFF_IMPORT_MEMORY_MAX_);
}

function loadStaffImportMemory_() {
  try {
    var v = parseJson_(PropertiesService.getScriptProperties().getProperty(STAFF_IMPORT_LAST_PROP_), null);
    if (Array.isArray(v)) return v;
    // Stored before several layouts were remembered: one {labels, mapping}.
    return v && v.labels && v.mapping ? [{ key: staffImportLayoutKey_(v.labels), mapping: v.mapping }] : [];
  } catch (e) { return []; }
}

/* ---------- client API ---------- */

function apiStaffImportBootstrap() {
  return apiCall_('apiStaffImportBootstrap', function () {
    requireInitialized_();
    var cfg = getConfig_();
    var teamSheetIds = {};
    var teams = listTeams_();
    teams.forEach(function (t) { [t.settings.scheduleSheetId, t.settings.staffSheetId].forEach(function (id) { if (id) teamSheetIds[id] = true; }); });
    return {
      targets: staffImportTargets_(),
      teams: teams.filter(function (t) { return t.status === TEAM_STATUS.READY; }).map(function (t) { return { teamId: t.teamId, teamName: t.teamName }; }),
      maxFileMb: cfgNum_(cfg, 'MAX_FILE_MB', 10),
      driveAvailable: typeof Drive !== 'undefined',
      sourceSheets: getSs_().getSheets().filter(function (s) {
        var n = s.getName();
        return n.charAt(0) !== '_' && !teamSheetIds[s.getSheetId()] && n !== cfg.DASHBOARD_SHEET && n !== LINKS_SHEET_;
      }).map(function (s) { return s.getName(); })
    };
  });
}

/** The tabs of another Google Sheet, so the right one can be chosen. */
function apiStaffImportTabs(url) {
  return apiCall_('apiStaffImportTabs', function () {
    requireInitialized_();
    var r = readOtherSpreadsheetTable_(url, '');
    return { tabs: r.tabs, name: r.name.split(' › ')[0] };
  });
}

/** Reads the source (FILE | TAB | URL), stages it and returns its columns with a first mapping. */
function apiStaffImportRead(payload) {
  return apiCall_('apiStaffImportRead', function () {
    requireInitialized_();
    payload = payload || {};
    var cfg = getConfig_();
    var table, name;
    if (payload.source === 'TAB') { var s = readSheetAsTable_(str_(payload.sheetName)); table = s.table; name = 'Sheet tab: ' + s.sheetName; }
    else if (payload.source === 'URL') { var o = readOtherSpreadsheetTable_(payload.url, str_(payload.tab)); table = o.table; name = o.name; }
    else { table = parseUploadedFile_(payload, cfgNum_(cfg, 'MAX_FILE_MB', 10) * 1048576).table; name = str_(payload.fileName); }
    if (!table.length) fail_('VALIDATION', 'The source is empty.');
    var stageId = newId_('STF');
    var staged = { meta: { fileName: name }, table: table };
    withLock_(function () {
      purgeOldStaging_(cfgNum_(cfg, 'STAGING_RETENTION_HOURS', 24));
      stageTable_(stageId, staged);
    });
    return staffImportSourceForClient_(stageId, staged, 0);
  });
}

/** The columns under another header row. */
function apiStaffImportColumns(stageId, headerRow) {
  return apiCall_('apiStaffImportColumns', function () {
    requireInitialized_();
    return staffImportSourceForClient_(stageId, loadStaged_(stageId), Math.max(1, Math.floor(toNumber_(headerRow, 1))));
  });
}

function apiStaffImportPreview(stageId, opts) {
  return apiCall_('apiStaffImportPreview', function () {
    requireInitialized_();
    var r = staffImportPlanFor_(stageId, opts);
    if (r.plan.errors.length) fail_('VALIDATION', r.plan.errors.join(' '));
    return { summary: r.plan.summary, items: r.plan.items.slice(0, 500), more: Math.max(0, r.plan.items.length - 500) };
  });
}

/**
 * Writes the planned values: empty cells, plus different ones when overwrite is set. Identifiers are
 * stored as text (leading zeros kept); Last Updated is stamped on every changed row.
 */
function apiStaffImportApply(stageId, opts) {
  return apiCall_('apiStaffImportApply', function () {
    requireInitialized_();
    return withLock_(function () {
      var r = staffImportPlanFor_(stageId, opts);
      if (r.plan.errors.length) fail_('VALIDATION', r.plan.errors.join(' '));
      var byTeam = {}, tById = {};
      r.sheets.forEach(function (s) { byTeam[s.teamId] = s; });
      r.targets.forEach(function (t) { tById[t.key] = t; });
      var cells = {}; // teamId -> [{row, col, value, text}]
      r.plan.items.forEach(function (it) {
        it.changes.forEach(function (c) {
          if (!(c.status === 'SET' || (c.status === 'CONFLICT' && r.opts.overwrite))) return;
          var s = byTeam[c.teamId];
          var t = tById[c.field];
          (cells[c.teamId] = cells[c.teamId] || []).push({ row: c.row, col: s.staff.keys.indexOf(c.field) + 1, value: c.value, text: t.kind === 'ID' || t.kind === 'IDENTIFIER' });
        });
      });
      var written = 0, teams = [];
      Object.keys(cells).forEach(function (teamId) {
        var s = byTeam[teamId];
        var list = cells[teamId];
        var iUpd = s.staff.keys.indexOf('lastUpdated');
        var stamp = new Date();
        writeStaffCells_(s.staff.sheet, list);
        if (iUpd >= 0) writeStaffCells_(s.staff.sheet, uniq_(list.map(function (x) { return x.row; })).map(function (row) { return { row: row, col: iUpd + 1, value: stamp, text: false }; }));
        written += list.length;
        teams.push(s.teamName);
      });
      clearStaged_(stageId);
      try {
        var labels = staffImportColumns_(r.staged.table, r.opts.headerRow).map(function (c) { return c.label; });
        var memory = rememberStaffImportMapping_(loadStaffImportMemory_(), labels,
          { matchColumn: r.opts.matchColumn, matchField: r.opts.matchField, fills: r.opts.fills });
        PropertiesService.getScriptProperties().setProperty(STAFF_IMPORT_LAST_PROP_, JSON.stringify(memory));
      } catch (e) { /* only a convenience */ }
      if (written) rebuildStaffMasterSafe_();
      return { written: written, teams: teams, summary: r.plan.summary };
    }, 120000);
  });
}

/**
 * Writes cells of one staff sheet, a column at a time (one read + one write per column) instead of
 * cell by cell. A column holding formulas is written cell by cell, so its formulas are kept.
 * @param {Array<{row, col, value, text}>} list
 */
function writeStaffCells_(sh, list) {
  var byCol = {};
  list.forEach(function (x) { (byCol[x.col] = byCol[x.col] || []).push(x); });
  Object.keys(byCol).forEach(function (k) {
    var col = +k, items = byCol[k];
    var first = Math.min.apply(null, items.map(function (x) { return x.row; }));
    var last = Math.max.apply(null, items.map(function (x) { return x.row; }));
    var rng = sh.getRange(first, col, last - first + 1, 1);
    var text = items.some(function (x) { return x.text; });
    var hasFormula = rng.getFormulas().some(function (r) { return r[0]; });
    if (hasFormula) {
      items.forEach(function (x) {
        var cell = sh.getRange(x.row, col);
        if (x.text) cell.setNumberFormat('@');
        cell.setValue(x.text ? x.value : (x.value instanceof Date ? x.value : safeCell_(x.value)));
      });
      return;
    }
    var vals = rng.getValues();
    items.forEach(function (x) { vals[x.row - first][0] = x.text ? x.value : (x.value instanceof Date ? x.value : safeCell_(x.value)); });
    if (text) rng.setNumberFormat('@'); // identifiers stay text, so leading zeros are kept
    rng.setValues(vals);
  });
}

function apiStaffImportCancel(stageId) {
  return apiCall_('apiStaffImportCancel', function () {
    if (!stageId) return { cleared: 0 };
    return withLock_(function () { return { cleared: clearStaged_(stageId) }; });
  });
}

function apiShowStaffImportDialog() {
  return apiCall_('apiShowStaffImportDialog', function () {
    showHtml_('StaffImportDialog', 'Import Staff Data', {}, DIALOG_SIZE.LARGE);
    return true;
  });
}
