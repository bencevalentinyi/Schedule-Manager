/**
 * StaffService.gs
 * Team staff sheets (directory + matching reference), employee matching and the
 * derived _STAFF_MASTER index.
 *
 * Column linking (v1.1): every managed header cell carries a note
 * "sm-field: <key>". Columns are resolved by that key first and by header text
 * only as a fallback, so renaming a field (e.g. "Converse ID" -> "CRM ID") changes
 * the header but never loses values. Unknown/user columns are left untouched.
 *
 * Matching rules:
 *  - Employee ID is the primary key (case-insensitive, normalized). A team may
 *    explicitly choose an external identifier field as the import match key.
 *  - Without an ID, the name strategy (team or global) EXACT_FLAGGED matches only
 *    a UNIQUE exact name (case/accent/space folded) and flags it as uncertain.
 *  - Similar names are never merged; ambiguous names stay unmatched.
 *
 * Synchronization: team staff sheets are authoritative. _STAFF_MASTER is rebuilt
 * from them (one-way) and must not be edited.
 *
 * Dependencies: Schema.gs, Utils.gs, SheetStore.gs, ConfigService.gs, TeamService.gs,
 *               StaffFieldService.gs, ScheduleService.gs (queryScheduleRecords_)
 */

var STAFF_NOTE_PREFIX_ = 'sm-field: ';
var EMPLOYEE_ID_PATTERN_ = /^[A-Za-z0-9._\-\/]{1,40}$/;
var EXTERNAL_ID_PATTERN_ = /^\S{1,80}$/;

/* ------------------------------------------------------------------------ */
/* Pure helpers                                                              */
/* ------------------------------------------------------------------------ */

function isActiveValue_(v) {
  if (v === false) return false;
  var s = str_(v).toLowerCase();
  return !(s === 'inactive' || s === 'false' || s === 'no' || s === '0');
}

function staffKeyFromNote_(note) {
  var m = /sm-field:\s*([A-Za-z0-9_:\-]+)/.exec(str_(note));
  return m ? m[1] : '';
}

function isManagedStaffKey_(k) {
  return !!STAFF_FIELD_DEFS[k] || String(k).indexOf(STAFF_REGISTRY_PREFIX) === 0;
}

function isIdentifierStaffKey_(k, registry) {
  if (k === 'employeeId') return true;
  if (String(k).indexOf(STAFF_REGISTRY_PREFIX) !== 0) return false;
  var f = registry && registry[k.substr(STAFF_REGISTRY_PREFIX.length)];
  return !!f && f.fieldType === 'IDENTIFIER';
}

/**
 * Resolves the field key of each staff sheet column: header note first, then the
 * header text (built-in label, registry display name), else "custom:<header>".
 */
function resolveStaffColumns_(header, notes, registry) {
  var regKeys = Object.keys(registry || {});
  var stdKeys = Object.keys(STAFF_FIELD_DEFS);
  return header.map(function (h, i) {
    var k = staffKeyFromNote_(notes && notes[i]);
    if (k) return k;
    var l = str_(h).toLowerCase();
    if (!l) return '';
    for (var a = 0; a < stdKeys.length; a++) if (STAFF_FIELD_DEFS[stdKeys[a]].label.toLowerCase() === l) return stdKeys[a];
    for (var b = 0; b < regKeys.length; b++) if (registry[regKeys[b]].displayName.toLowerCase() === l) return STAFF_REGISTRY_PREFIX + regKeys[b];
    return CUSTOM_FIELD_PREFIX + str_(h);
  });
}

/**
 * @param {Array<{employeeId, employeeName, active, fields?}>} staffRows
 * @param {string=} matchField 'employeeId' (default) or 'field:<key>'
 * @return {{byId, byName, duplicateIds, matchField}}
 */
function buildStaffIndex_(staffRows, matchField) {
  matchField = matchField || 'employeeId';
  var keyOf = function (s) {
    return matchField === 'employeeId' ? s.employeeId : str_(s.fields ? s.fields[matchField] : '');
  };
  var byId = {}, byName = {}, dups = [];
  staffRows.forEach(function (s) {
    var v = keyOf(s);
    if (v) {
      var k = idKey_(v);
      if (byId[k]) dups.push(v);
      else byId[k] = s;
    }
    var n = normName_(s.employeeName);
    if (n) (byName[n] = byName[n] || []).push(s);
  });
  return { byId: byId, byName: byName, duplicateIds: uniq_(dups), matchField: matchField };
}

/**
 * Matches one schedule row to a staff record.
 * @return {{status: string, staff: Object|null, note: string}}
 */
function matchEmployee_(index, employeeId, employeeName, strategy) {
  if (!index) return { status: STAFF_MATCH.UNKNOWN, staff: null, note: 'No staff directory available.' };
  if (employeeId) {
    var s = index.byId[idKey_(employeeId)];
    if (s) {
      var note = '';
      if (employeeName && s.employeeName && normName_(employeeName) !== normName_(s.employeeName)) {
        note = 'Name in file ("' + employeeName + '") differs from staff directory ("' + s.employeeName + '").';
      }
      return { status: STAFF_MATCH.ID, staff: s, note: note };
    }
    return { status: STAFF_MATCH.UNKNOWN, staff: null, note: 'Identifier not in staff directory.' };
  }
  if (!employeeName || strategy === 'NONE') return { status: STAFF_MATCH.UNKNOWN, staff: null, note: 'No employee identifier.' };
  var c = index.byName[normName_(employeeName)] || [];
  if (c.length === 1) return { status: STAFF_MATCH.NAME, staff: c[0], note: 'Matched by exact name only — verify.' };
  if (c.length > 1) return { status: STAFF_MATCH.AMBIGUOUS, staff: null, note: c.length + ' staff members share this name; not matched.' };
  return { status: STAFF_MATCH.UNKNOWN, staff: null, note: 'Name not in staff directory.' };
}

/** Duplicate values per identifier column: {label: [values]} (pure). */
function findDuplicateIdentifiers_(rows, keys, header, registry) {
  var out = {};
  keys.forEach(function (k, i) {
    if (!isIdentifierStaffKey_(k, registry)) return;
    var seen = {}, dups = [];
    rows.forEach(function (r) {
      var v = k === 'employeeId' ? r.employeeId : str_(r.fields[k]);
      if (!v) return;
      var x = idKey_(v);
      if (seen[x]) dups.push(v); else seen[x] = true;
    });
    if (dups.length) out[header[i]] = uniq_(dups);
  });
  return out;
}

/* ------------------------------------------------------------------------ */
/* Staff sheet layout                                                        */
/* ------------------------------------------------------------------------ */

/**
 * Creates/repairs the staff sheet layout. Never removes columns or data:
 * selected fields are added or renamed, unselected/hidden managed fields are
 * hidden, user columns are left as they are.
 */
function layoutStaffSheet_(sh, team) {
  var cfg = getConfig_();
  var registry = getStaffFieldMap_();
  var H = STAFF_LAYOUT.HEADER_ROW;
  var lc = Math.max(sh.getLastColumn(), 1);
  var hdr = sh.getRange(H, 1, 1, lc);
  var header = hdr.getValues()[0].map(str_);
  var notes = hdr.getNotes()[0].slice();
  var keys = resolveStaffColumns_(header, notes, registry);
  while (header.length && !header[header.length - 1] && !keys[keys.length - 1]) { header.pop(); keys.pop(); notes.pop(); }

  var selected = team.settings.staffFields;
  selected.forEach(function (f) {
    var label = staffFieldLabel_(f, registry);
    var i = keys.indexOf(f);
    if (i < 0) { header.push(label); keys.push(f); notes.push(''); }
    else if (isManagedStaffKey_(f)) header[i] = label; // follows renames in the registry
  });
  ensureColumns_(sh, header.length);
  ensureRows_(sh, STAFF_LAYOUT.FIRST_DATA_ROW + 50);
  var newNotes = keys.map(function (k, i) {
    return isManagedStaffKey_(k) ? STAFF_NOTE_PREFIX_ + k + '\nSchedule Manager link — keep this note so the column stays connected after renames.' : (notes[i] || '');
  });
  var hdrRange = sh.getRange(H, 1, 1, header.length);
  hdrRange.setValues([header]).setNotes([newNotes]);

  sh.getRange(STAFF_LAYOUT.TITLE_ROW, 1).setValue(team.teamName + ' — Staff Directory')
    .setFontSize(14).setFontWeight('bold').setFontColor(cfg.HEADER_COLOR);
  var sched = resolveTeamSheet_(team, 'schedule');
  sh.getRange(STAFF_LAYOUT.NAV_ROW, 1).setValue(sched ? '=HYPERLINK("#gid=' + sched.getSheetId() + '","→ Daily schedule")' : '');
  sh.getRange(STAFF_LAYOUT.NAV_ROW, 2).setValue('Employee ID is the internal key. Identifier columns are stored as text. Use Schedule Manager → Schedule Management → View Staff Directory to add or edit staff safely.')
    .setFontColor('#5f6368').setFontStyle('italic');

  hdrRange.setFontWeight('bold').setBackground(cfg.HEADER_COLOR).setFontColor(cfg.HEADER_FONT_COLOR).setVerticalAlignment('middle');
  sh.setFrozenRows(H);

  var dataRows = sh.getMaxRows() - H;
  var rules = [];
  var full = sh.getRange(H + 1, 1, dataRows, header.length);
  var r0 = H + 1;
  var textCols = [];
  keys.forEach(function (k, i) {
    var c = i + 1;
    if (isIdentifierStaffKey_(k, registry)) {
      textCols.push(columnLetter_(c) + r0 + ':' + columnLetter_(c) + (H + dataRows));
      var L = columnLetter_(c);
      rules.push(SpreadsheetApp.newConditionalFormatRule()
        .whenFormulaSatisfied('=AND($' + L + r0 + '<>"",COUNTIF($' + L + '$' + r0 + ':$' + L + ',$' + L + r0 + ')>1)')
        .setBackground(cfg.ERROR_COLOR).setRanges([sh.getRange(r0, c, dataRows, 1)]).build());
    }
    if (k === 'active') {
      sh.getRange(r0, c, dataRows, 1).setDataValidation(
        SpreadsheetApp.newDataValidation().requireValueInList(STAFF_ACTIVE_VALUES, true).setAllowInvalid(false)
          .setHelpText('Active or Inactive. Blank is treated as Active.').build());
      rules.push(SpreadsheetApp.newConditionalFormatRule()
        .whenFormulaSatisfied('=$' + columnLetter_(c) + r0 + '="Inactive"')
        .setFontColor('#9aa0a6').setRanges([full]).build());
    }
    if (k === 'email') {
      sh.getRange(r0, c, dataRows, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireTextIsEmail().setAllowInvalid(true).build());
    }
    if (k === 'lastUpdated') sh.getRange(r0, c, dataRows, 1).setNumberFormat('yyyy-mm-dd hh:mm');
    sh.setColumnWidth(c, STAFF_FIELD_DEFS[k] ? STAFF_FIELD_DEFS[k].width : (isIdentifierStaffKey_(k, registry) ? 120 : 150));
  });
  if (textCols.length) sh.getRangeList(textCols).setNumberFormat('@');
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=AND(COUNTA($A' + r0 + ':$' + columnLetter_(header.length) + r0 + ')>0,ISEVEN(ROW()))')
    .setBackground(cfg.BAND_COLOR).setRanges([full]).build());
  sh.setConditionalFormatRules(rules);

  // Visibility: managed fields show only if selected (and visible in the registry).
  keys.forEach(function (k, i) {
    if (!isManagedStaffKey_(k)) return;
    var show = selected.indexOf(k) >= 0;
    if (k.indexOf(STAFF_REGISTRY_PREFIX) === 0) {
      var reg = registry[k.substr(STAFF_REGISTRY_PREFIX.length)];
      if (!reg || !reg.visible) show = false;
    }
    if (MANDATORY_STAFF_FIELDS.indexOf(k) >= 0) show = true;
    if (show) sh.showColumns(i + 1); else sh.hideColumns(i + 1);
  });

  var filter = sh.getFilter();
  if (filter && filter.getRange().getNumColumns() !== header.length) { filter.remove(); filter = null; }
  if (!filter) sh.getRange(H, 1, dataRows + 1, header.length).createFilter();
  sh.setTabColor(cfg.HEADER_COLOR);
}

/* ------------------------------------------------------------------------ */
/* Reading and writing staff                                                 */
/* ------------------------------------------------------------------------ */

/**
 * Reads a team's staff sheet.
 * @return {{sheet, header: string[], keys: string[], registry: Object, rows: Object[]}}
 *   rows: {_row, employeeId, employeeName, active, values: {label: v}, fields: {key: v}}
 */
function readStaff_(team) {
  var sh = resolveTeamSheet_(team, 'staff');
  if (!sh) fail_('MISSING_SHEET', 'The staff sheet of team "' + team.teamName + '" is missing. Run Maintenance → Rebuild Missing Sheets.');
  var cfg = getConfig_();
  var registry = getStaffFieldMap_();
  var H = STAFF_LAYOUT.HEADER_ROW;
  var lr = sh.getLastRow(), lc = sh.getLastColumn();
  if (lr < H || lc < 1) fail_('SCHEMA', 'The staff sheet "' + sh.getName() + '" has no header row. Run Maintenance → Repair Formatting.');
  var values = sh.getRange(H, 1, lr - H + 1, lc).getValues();
  var notes = sh.getRange(H, 1, 1, lc).getNotes()[0];
  var header = values[0].map(str_);
  var keys = resolveStaffColumns_(header, notes, registry);
  var iId = keys.indexOf('employeeId'), iName = keys.indexOf('employeeName'), iActive = keys.indexOf('active');
  if (iId < 0 || iName < 0) fail_('SCHEMA', 'The staff sheet "' + sh.getName() + '" must have "Employee ID" and "Employee Name" columns in row ' + H + '. Run Maintenance → Repair Formatting.');
  var strip = cfgBool_(cfg, 'STRIP_LEADING_ZEROS');
  var rows = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    if (row.every(isBlank_)) continue;
    var o = { _row: H + r, values: {}, fields: {} };
    header.forEach(function (h, i) {
      var v = isDate_(row[i]) ? row[i] : str_(row[i]);
      if (h) o.values[h] = v;
      if (keys[i] && o.fields[keys[i]] === undefined) o.fields[keys[i]] = v;
    });
    o.employeeId = normalizeEmployeeId_(row[iId], strip);
    o.employeeName = str_(row[iName]).replace(/\s+/g, ' ');
    o.active = iActive < 0 ? true : isActiveValue_(row[iActive]);
    rows.push(o);
  }
  return { sheet: sh, header: header, keys: keys, registry: registry, rows: rows };
}

/**
 * Staff index for a team, or null if the sheet cannot be read.
 * @param {boolean=} forImport use the team's configured import match key and name strategy
 */
function tryStaffIndex_(team, forImport) {
  try {
    var st = readStaff_(team);
    var imp = team.settings.import || DEFAULT_TEAM_IMPORT;
    var matchField = forImport ? (imp.matchField || 'employeeId') : 'employeeId';
    var idx = buildStaffIndex_(st.rows, matchField);
    idx.rows = st.rows;
    idx.nameMatch = imp.nameMatch || '';
    idx.matchFieldLabel = staffFieldLabel_(matchField, st.registry);
    idx.matchFieldMissing = matchField !== 'employeeId' && st.keys.indexOf(matchField) < 0;
    return idx;
  } catch (e) {
    logError_('tryStaffIndex_', e);
    return null;
  }
}

/**
 * Adds or updates a staff member. Never creates a duplicate Employee ID or a
 * duplicate external identifier within the team.
 * @param {Object} team
 * @param {Object} values header label -> value
 * @param {string=} originalId Employee ID of the record being edited ('' for new)
 */
function upsertStaff_(team, values, originalId) {
  var cfg = getConfig_();
  var strip = cfgBool_(cfg, 'STRIP_LEADING_ZEROS');
  var st = readStaff_(team);
  values = values || {};
  var byLabel = {};
  Object.keys(values).forEach(function (k) { byLabel[k.toLowerCase()] = values[k]; });
  var valueFor = function (i) { var v = byLabel[String(st.header[i]).toLowerCase()]; return v === undefined ? undefined : str_(v); };
  var colOf = function (key) { return st.keys.indexOf(key); };

  var id = normalizeEmployeeId_(valueFor(colOf('employeeId')), strip);
  var name = str_(valueFor(colOf('employeeName'))).replace(/\s+/g, ' ');
  var rep = newReport_();
  if (!id) rep.fatal.push('Employee ID is required.');
  else if (!EMPLOYEE_ID_PATTERN_.test(id)) rep.fatal.push('Employee ID may contain only letters, digits and . _ - / (max 40 characters).');
  if (!name) rep.fatal.push('Employee name is required.');
  var iEmail = colOf('email');
  var email = iEmail >= 0 ? str_(valueFor(iEmail)) : '';
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) rep.fatal.push('Email address is not valid.');

  var origKey = idKey_(normalizeEmployeeId_(originalId, strip));
  var target = null;
  st.rows.forEach(function (r) { if (origKey && idKey_(r.employeeId) === origKey) target = r; });
  if (origKey && !target) rep.fatal.push('The employee being edited (' + originalId + ') no longer exists in the staff sheet.');
  st.rows.forEach(function (r) {
    if (idKey_(r.employeeId) === idKey_(id) && r !== target) {
      rep.fatal.push('Employee ID ' + id + ' already exists (row ' + r._row + ', ' + r.employeeName + '). Edit that record instead of creating a duplicate.');
    }
  });
  // External identifiers and required registry fields.
  st.keys.forEach(function (k, i) {
    if (k.indexOf(STAFF_REGISTRY_PREFIX) !== 0) return;
    var reg = st.registry[k.substr(STAFF_REGISTRY_PREFIX.length)];
    if (!reg) return;
    var v = valueFor(i);
    if (v === undefined) v = target ? str_(target.fields[k]) : '';
    if (reg.required && !v) rep.fatal.push(reg.displayName + ' is required.');
    if (reg.fieldType !== 'IDENTIFIER' || !v) return;
    if (!EXTERNAL_ID_PATTERN_.test(v)) rep.fatal.push(reg.displayName + ' must not contain spaces (max 80 characters).');
    st.rows.forEach(function (r) {
      if (r !== target && idKey_(r.fields[k]) === idKey_(v)) rep.fatal.push(reg.displayName + ' "' + v + '" is already used by ' + r.employeeName + ' (row ' + r._row + ').');
    });
  });
  if (rep.fatal.length) fail_('VALIDATION', rep.fatal.join(' '), rep);

  var sh = st.sheet;
  var width = st.header.length;
  var rowNum = target ? target._row : Math.max(sh.getLastRow() + 1, STAFF_LAYOUT.FIRST_DATA_ROW);
  var existingRow = target ? sh.getRange(rowNum, 1, 1, width).getValues()[0] : st.header.map(function () { return ''; });
  var out = existingRow.slice();
  var textCells = [];
  st.keys.forEach(function (k, i) {
    if (!st.header[i]) return;
    var v = valueFor(i);
    if (k === 'employeeId') out[i] = id;
    else if (k === 'employeeName') out[i] = safeCell_(name);
    else if (k === 'lastUpdated') out[i] = new Date();
    else if (k === 'active') out[i] = isActiveValue_(v === undefined ? existingRow[i] : v) ? 'Active' : 'Inactive';
    else if (k === 'team' && !target && !v) out[i] = team.teamName;
    else if (v !== undefined) out[i] = isIdentifierStaffKey_(k, st.registry) ? v : safeCell_(v);
    if (isIdentifierStaffKey_(k, st.registry)) textCells.push(columnLetter_(i + 1) + rowNum);
  });
  ensureRows_(sh, rowNum);
  if (textCells.length) sh.getRangeList(textCells).setNumberFormat('@');
  sh.getRange(rowNum, 1, 1, width).setValues([out]);
  return { employeeId: id, employeeName: name, row: rowNum, created: !target };
}

function setStaffActive_(team, employeeId, active) {
  var st = readStaff_(team);
  var iActive = st.keys.indexOf('active');
  var iUpd = st.keys.indexOf('lastUpdated');
  if (iActive < 0) fail_('SCHEMA', 'The staff sheet has no "Active" column. Run Maintenance → Repair Formatting.');
  var row = null;
  st.rows.forEach(function (r) { if (idKey_(r.employeeId) === idKey_(employeeId)) row = r; });
  if (!row) fail_('NOT_FOUND', 'Employee ' + employeeId + ' was not found in the staff sheet.');
  st.sheet.getRange(row._row, iActive + 1).setValue(active ? 'Active' : 'Inactive');
  if (iUpd >= 0) st.sheet.getRange(row._row, iUpd + 1).setValue(new Date());
  return { employeeId: row.employeeId, active: !!active };
}

/**
 * Employees in the team's stored schedule who are missing from its staff sheet.
 * Entries with an Employee ID can be added automatically; name-only entries are
 * listed for manual review (an ID must be entered).
 */
function unknownStaffCandidates_(team) {
  var idx = buildStaffIndex_(readStaff_(team).rows);
  var strategy = (team.settings.import && team.settings.import.nameMatch) || getConfig_().NAME_MATCH_STRATEGY;
  var out = {};
  queryScheduleRecords_({ teamIds: [team.teamId] }).forEach(function (r) {
    if (r.recordStatus !== RECORD_STATUS.ACTIVE) return;
    var m = matchEmployee_(idx, r.employeeId, r.employeeName, strategy);
    if (m.status === STAFF_MATCH.ID || m.status === STAFF_MATCH.NAME) return;
    var k = r.employeeId ? 'ID:' + idKey_(r.employeeId) : 'NM:' + normName_(r.employeeName);
    if (!out[k]) out[k] = { employeeId: r.employeeId, employeeName: r.employeeName, shifts: 0, lastDate: r.shiftDate, canAdd: !!r.employeeId };
    out[k].shifts++;
    if (r.shiftDate > out[k].lastDate) out[k].lastDate = r.shiftDate;
    if (!out[k].employeeName && r.employeeName) out[k].employeeName = r.employeeName;
  });
  return Object.keys(out).map(function (k) { return out[k]; })
    .sort(function (a, b) { return a.employeeName.localeCompare(b.employeeName); });
}

function addUnknownStaff_(team, employeeIds) {
  var wanted = (employeeIds || []).map(idKey_);
  var candidates = unknownStaffCandidates_(team).filter(function (c) { return c.canAdd && wanted.indexOf(idKey_(c.employeeId)) >= 0; });
  var added = [];
  candidates.forEach(function (c) {
    var v = {};
    v[STAFF_FIELD_DEFS.employeeId.label] = c.employeeId;
    v[STAFF_FIELD_DEFS.employeeName.label] = c.employeeName || c.employeeId;
    v[STAFF_FIELD_DEFS.active.label] = 'Active';
    v[STAFF_FIELD_DEFS.notes.label] = 'Added from imported schedule';
    added.push(upsertStaff_(team, v, '').employeeId);
  });
  return added;
}

/** Rebuilds _STAFF_MASTER from all READY team staff sheets (one-way). */
function rebuildStaffMaster_() {
  var agg = {};
  var problems = [];
  listTeams_().forEach(function (team) {
    if (team.status !== TEAM_STATUS.READY) return;
    var st;
    try { st = readStaff_(team); } catch (e) { problems.push(team.teamName + ': ' + toUserError_(e).message); return; }
    st.rows.forEach(function (r) {
      if (!r.employeeId) return;
      var k = idKey_(r.employeeId);
      var email = str_(r.fields.email);
      var a = agg[k] = agg[k] || { employeeId: r.employeeId, names: [], emails: [], teamIds: [], activeIn: [] };
      if (r.employeeName && a.names.indexOf(r.employeeName) < 0) a.names.push(r.employeeName);
      if (email && a.emails.indexOf(email) < 0) a.emails.push(email);
      if (a.teamIds.indexOf(team.teamId) < 0) a.teamIds.push(team.teamId);
      if (r.active && a.activeIn.indexOf(team.teamId) < 0) a.activeIn.push(team.teamId);
    });
  });
  var now = new Date();
  var t = readTable_(T_STAFF_MASTER);
  var rows = Object.keys(agg).sort().map(function (k) {
    var a = agg[k];
    var conflicts = [];
    if (a.names.length > 1) conflicts.push('Different names: ' + a.names.join(' / '));
    if (a.emails.length > 1) conflicts.push('Different emails: ' + a.emails.join(' / '));
    return objectToRow_(T_STAFF_MASTER, t.header, {
      employeeId: a.employeeId, employeeName: a.names[0] || '', email: a.emails[0] || '',
      teamIds: a.teamIds.join(', '), activeIn: a.activeIn.join(', '), conflicts: conflicts.join('; '), updatedAt: now
    }, null);
  });
  replaceAllRows_(t.sheet, T_STAFF_MASTER, t.header, rows, t.lastRow);
  return { employees: rows.length, problems: problems };
}

function rebuildStaffMasterSafe_() {
  try { return rebuildStaffMaster_(); } catch (e) { logError_('rebuildStaffMasterSafe_', e); return null; }
}

/** onEdit helper: stamps "Last Updated" on edited data rows of a staff sheet (if that column exists). */
function stampStaffRows_(sh, range) {
  var H = STAFF_LAYOUT.HEADER_ROW;
  var first = Math.max(range.getRow(), H + 1);
  var last = range.getLastRow();
  if (last < first) return;
  var lc = sh.getLastColumn();
  var hdr = sh.getRange(H, 1, 1, lc);
  var keys = resolveStaffColumns_(hdr.getValues()[0].map(str_), hdr.getNotes()[0], {});
  var c = keys.indexOf('lastUpdated') + 1;
  if (c < 1 || (range.getColumn() === c && range.getNumColumns() === 1)) return;
  var n = last - first + 1;
  if (n > 500) return; // bulk pastes: skip stamping rather than slow the editor down
  var now = new Date();
  var block = sh.getRange(first, 1, n, lc).getValues();
  sh.getRange(first, c, n, 1).setValues(block.map(function (row) { return [row.every(isBlank_) ? '' : now]; }));
}

/* ------------------------------------------------------------------------ */
/* Client API (StaffSidebar.html)                                            */
/* ------------------------------------------------------------------------ */

function apiStaffBootstrap() {
  return apiCall_('apiStaffBootstrap', function () {
    requireInitialized_();
    var current = teamForSheet_(getSs_().getActiveSheet());
    return {
      teams: listTeams_().filter(function (t) { return t.status === TEAM_STATUS.READY; })
        .map(function (t) { return { teamId: t.teamId, teamName: t.teamName, active: t.active }; }),
      currentTeamId: current ? current.team.teamId : ''
    };
  });
}

function apiStaffList(teamId, query, includeInactive) {
  return apiCall_('apiStaffList', function () {
    var team = requireTeam_(teamId);
    var st = readStaff_(team);
    var selected = team.settings.staffFields;
    var visible = [];
    st.keys.forEach(function (k, i) {
      var h = st.header[i];
      if (!h || k === 'lastUpdated') return;
      if (isManagedStaffKey_(k)) {
        if (selected.indexOf(k) < 0 && MANDATORY_STAFF_FIELDS.indexOf(k) < 0) return;
        if (k.indexOf(STAFF_REGISTRY_PREFIX) === 0) {
          var reg = st.registry[k.substr(STAFF_REGISTRY_PREFIX.length)];
          if (!reg || !reg.visible) return;
        }
      }
      visible.push({ label: h, key: k, identifier: isIdentifierStaffKey_(k, st.registry) });
    });
    var q = normText_(query);
    var rows = st.rows.filter(function (r) {
      if (!includeInactive && !r.active) return false;
      if (!q) return true;
      return Object.keys(r.values).some(function (h) { return normText_(r.values[h]).indexOf(q) >= 0; });
    });
    var total = rows.length;
    rows.sort(function (a, b) { return a.employeeName.localeCompare(b.employeeName); });
    var dupMap = findDuplicateIdentifiers_(st.rows, st.keys, st.header, st.registry);
    return {
      fields: visible,
      rows: rows.slice(0, 200).map(function (r) {
        var v = {};
        Object.keys(r.values).forEach(function (h) { v[h] = isDate_(r.values[h]) ? formatTimestamp_(r.values[h]) : r.values[h]; });
        return { employeeId: r.employeeId, employeeName: r.employeeName, active: r.active, row: r._row, values: v };
      }),
      total: total,
      duplicates: Object.keys(dupMap).map(function (l) { return l + ': ' + dupMap[l].join(', '); })
    };
  });
}

function apiStaffSave(teamId, values, originalId) {
  return apiCall_('apiStaffSave', function () {
    return withLock_(function () {
      var r = upsertStaff_(requireTeam_(teamId), values, originalId);
      rebuildStaffMasterSafe_();
      return r;
    });
  });
}

function apiStaffSetActive(teamId, employeeId, active) {
  return apiCall_('apiStaffSetActive', function () {
    return withLock_(function () {
      var r = setStaffActive_(requireTeam_(teamId), employeeId, active);
      rebuildStaffMasterSafe_();
      return r;
    });
  });
}

function apiStaffUnknownCandidates(teamId) {
  return apiCall_('apiStaffUnknownCandidates', function () {
    return unknownStaffCandidates_(requireTeam_(teamId));
  });
}

function apiStaffAddUnknown(teamId, employeeIds) {
  return apiCall_('apiStaffAddUnknown', function () {
    return withLock_(function () {
      var team = requireTeam_(teamId);
      var added = addUnknownStaff_(team, employeeIds);
      rebuildStaffMasterSafe_();
      try { renderTeamView_(team, {}); } catch (e) { logError_('apiStaffAddUnknown.render', e); }
      return { added: added };
    });
  });
}
