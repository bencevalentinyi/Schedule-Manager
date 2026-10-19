/**
 * ScheduleService.gs
 * Reads normalized schedule records from _SCHEDULE_DATA and renders team views.
 * Team daily sheets are presentation only: they can be re-rendered at any time
 * from _SCHEDULE_DATA without duplicating or losing records.
 *
 * Rendering is done by Apps Script (not formulas) because flags, overnight
 * handling, overlap detection and headcount need logic that would be slow and
 * fragile as QUERY/FILTER formulas over a growing data sheet. Trade-off: the view
 * refreshes on date/filter edits (onEdit), after imports and on Refresh.
 *
 * Dependencies: Schema.gs, Utils.gs, SheetStore.gs, ConfigService.gs,
 *               TeamService.gs, StaffService.gs, AuditService.gs
 */

/* ------------------------------------------------------------------------ */
/* Data access                                                               */
/* ------------------------------------------------------------------------ */

/** Converts a raw _SCHEDULE_DATA row into a record object. */
function rowToRecord_(row, idx, tz, rowNumber) {
  var g = function (k) { return idx[k] >= 0 ? row[idx[k]] : ''; };
  return {
    _row: rowNumber,
    recordKey: str_(g('recordKey')),
    teamId: str_(g('teamId')),
    shiftDate: cellToIsoDate_(g('shiftDate'), tz),
    employeeId: str_(g('employeeId')),
    employeeName: str_(g('employeeName')),
    staffMatch: str_(g('staffMatch')),
    activity: str_(g('activity')),
    role: str_(g('role')),
    shiftStart: cellToIsoDateTime_(g('shiftStart'), tz),
    shiftEnd: cellToIsoDateTime_(g('shiftEnd'), tz),
    grossMinutes: toNumber_(g('grossMinutes'), 0),
    shiftStatus: str_(g('shiftStatus')),
    recordStatus: str_(g('recordStatus')) || RECORD_STATUS.ACTIVE,
    sourceShiftId: str_(g('sourceShiftId')),
    comment: str_(g('comment')),
    createdImportId: str_(g('createdImportId')),
    lastImportId: str_(g('lastImportId')),
    updatedAt: g('updatedAt'),
    extra: parseJson_(g('extra'), {}) || {},
    shiftType: str_(g('shiftType')),
    sourceShiftInfo: str_(g('sourceShiftInfo')),
    sourceHours: str_(g('sourceHours')),
    scheduledMinutes: str_(g('scheduledMinutes')) === '' ? '' : toNumber_(g('scheduledMinutes'), ''),
    activityCategory: str_(g('activityCategory')) || ACTIVITY_CATEGORY.SHIFT
  };
}

/** Reads every record (used by imports, undo and data validation). */
function readAllScheduleRecords_() {
  var t = readTable_(T_SCHEDULE);
  var tz = getTz_();
  var records = [];
  for (var r = 1; r < t.values.length; r++) {
    if (t.values[r].every(isBlank_)) continue;
    records.push(rowToRecord_(t.values[r], t.idx, tz, r + 1));
  }
  return { table: t, records: records };
}

/**
 * Reads only the records matching team and/or date filters. Reads the Team ID
 * and Shift Date columns first, then only the matching contiguous row blocks,
 * so a render does not load the whole data sheet.
 * @param {{teamIds?: string[], dates?: string[]}} filter
 */
function queryScheduleRecords_(filter) {
  var sh = requireSheet_(T_SCHEDULE.sheet);
  var lr = sh.getLastRow();
  if (lr < 2) return [];
  var header = readHeader_(sh);
  var hi = headerIndex_(T_SCHEDULE, header);
  if (hi.missing.length) fail_('SCHEMA', '_SCHEDULE_DATA is missing column(s): ' + hi.missing.join(', ') + '. Run Setup → Repair.');
  var tz = getTz_();
  var n = lr - 1;
  var teams = filter.teamIds ? filter.teamIds : null;
  var dates = filter.dates ? filter.dates : null;
  var teamCol = teams ? sh.getRange(2, hi.idx.teamId + 1, n, 1).getValues() : null;
  var dateCol = dates ? sh.getRange(2, hi.idx.shiftDate + 1, n, 1).getValues() : null;
  var matches = [];
  for (var i = 0; i < n; i++) {
    if (teams && teams.indexOf(str_(teamCol[i][0])) < 0) continue;
    if (dates && dates.indexOf(cellToIsoDate_(dateCol[i][0], tz)) < 0) continue;
    matches.push(i);
  }
  if (!matches.length) return [];
  var runs = [];
  matches.forEach(function (i) {
    var last = runs[runs.length - 1];
    if (last && i === last.end + 1) last.end = i; else runs.push({ start: i, end: i });
  });
  var out = [];
  var width = header.length;
  if (runs.length > 40) {
    var all = sh.getRange(2, 1, n, width).getValues();
    matches.forEach(function (i) { out.push(rowToRecord_(all[i], hi.idx, tz, i + 2)); });
    return out;
  }
  runs.forEach(function (run) {
    var vals = sh.getRange(run.start + 2, 1, run.end - run.start + 1, width).getValues();
    vals.forEach(function (row, k) { out.push(rowToRecord_(row, hi.idx, tz, run.start + 2 + k)); });
  });
  return out;
}

/* ------------------------------------------------------------------------ */
/* Pure view-model helpers                                                   */
/* ------------------------------------------------------------------------ */

/** Identity used to compare shifts of the same person (ID preferred). */
function employeeIdentity_(rec) {
  return rec.employeeId ? 'ID:' + idKey_(rec.employeeId) : 'NM:' + rec.teamId + ':' + normName_(rec.employeeName);
}

/**
 * All pairs of overlapping assignments of the same employee (pairwise, so two
 * meetings inside one shift are compared with each other too). Records need
 * startMin/endMin.
 * @return {Array<[Object, Object]>} overlapping pairs
 */
function findOverlaps_(records) {
  var groups = {};
  records.forEach(function (r) {
    var id = employeeIdentity_(r.rec || r);
    (groups[id] = groups[id] || []).push(r);
  });
  var pairs = [];
  Object.keys(groups).forEach(function (k) {
    var list = groups[k].slice().sort(function (a, b) { return a.startMin - b.startMin || a.endMin - b.endMin; });
    for (var i = 0; i < list.length; i++) {
      for (var j = i + 1; j < list.length && list[j].startMin < list[i].endMin; j++) pairs.push([list[i], list[j]]);
    }
  });
  return pairs;
}

function activityCategoryOf_(r) {
  var rec = r.rec || r;
  return str_(rec.activityCategory).toUpperCase() === ACTIVITY_CATEGORY.MEETING ? ACTIVITY_CATEGORY.MEETING : ACTIVITY_CATEGORY.SHIFT;
}

/**
 * Classifies an overlapping pair:
 *  - MEETING_IN_SHIFT: a meeting entirely inside a normal shift (expected, not a conflict);
 *  - CONFLICT: two shifts, two meetings, or a meeting only partly inside a shift.
 * (Identical copies never reach this point: they share a record key.)
 */
function classifyOverlap_(a, b) {
  var ca = activityCategoryOf_(a), cb = activityCategoryOf_(b);
  if (ca !== cb) {
    var meeting = ca === ACTIVITY_CATEGORY.MEETING ? a : b, shift = meeting === a ? b : a;
    if (meeting.startMin >= shift.startMin && meeting.endMin <= shift.endMin) return 'MEETING_IN_SHIFT';
  }
  return 'CONFLICT';
}

/** Overlapping pairs that are real conflicts (meetings inside shifts excluded). */
function findConflicts_(records) {
  return findOverlaps_(records).filter(function (p) { return classifyOverlap_(p[0], p[1]) === 'CONFLICT'; });
}

/**
 * Working minutes per employee for a set of assignments (documented rule):
 *   shifts:   the full length of every SHIFT;
 *   meetings: only the part of a MEETING not covered by any of the employee's
 *             shifts is added (a meeting inside a shift is already paid time).
 * Activity durations themselves are never changed.
 * @param {Object[]} rows items with rec, startMin, endMin
 * @return {Object} identity -> minutes
 */
function workMinutesByEmployee_(rows) {
  var groups = {};
  rows.forEach(function (r) { var id = employeeIdentity_(r.rec || r); (groups[id] = groups[id] || []).push(r); });
  var out = {};
  Object.keys(groups).forEach(function (id) {
    var shifts = groups[id].filter(function (r) { return activityCategoryOf_(r) === ACTIVITY_CATEGORY.SHIFT; });
    var total = 0;
    shifts.forEach(function (s) { total += s.endMin - s.startMin; });
    groups[id].forEach(function (m) {
      if (activityCategoryOf_(m) !== ACTIVITY_CATEGORY.MEETING) return;
      // Subtract the covered parts: walk the meeting interval against the sorted shift intervals.
      var covered = 0;
      var segs = shifts.map(function (s) { return [Math.max(s.startMin, m.startMin), Math.min(s.endMin, m.endMin)]; })
        .filter(function (x) { return x[1] > x[0]; }).sort(function (x, y) { return x[0] - y[0]; });
      var cur = -Infinity;
      segs.forEach(function (x) {
        var s0 = Math.max(x[0], cur);
        if (x[1] > s0) covered += x[1] - s0;
        cur = Math.max(cur, x[1]);
      });
      total += (m.endMin - m.startMin) - covered;
    });
    out[id] = total;
  });
  return out;
}

/**
 * Builds display rows for a date from stored records.
 *
 * Rows shown for date D with operating window W = [D+start, D+end):
 *  - shifts dated D (always);
 *  - shifts dated D-1 still running after 00:00 of D ("From previous day") when
 *    the window is 24/7, when they reach into W, or when SHOW_CARRY_OVER is on;
 *  - shifts dated D+1 starting inside W, for windows that cross midnight
 *    ("Starts next day").
 * Shifts of D lying completely outside a partial window are flagged
 * "Outside operating hours" (never hidden).
 *
 * @param {Object[]} records records of the team for D-1, D and D+1
 * @param {string} dateIso selected date
 * @param {Object|null} staffIdx staff index (null = staff sheet unavailable)
 * @param {Object} opts {maxShiftMinutes, nameStrategy, showCarryOver, window?, hoursToleranceMinutes?}
 */
function buildDayRows_(records, dateIso, staffIdx, opts) {
  var dayStart = dayNumber_(dateIso) * 1440;
  var prev = addDays_(dateIso, -1), next = addDays_(dateIso, 1);
  var w = opts.window || { startMin: 0, endMin: 1440, fullDay: true, crossesMidnight: false };
  var winStart = dayStart + w.startMin, winEnd = dayStart + w.endMin;
  var tol = opts.hoursToleranceMinutes === undefined ? 15 : opts.hoursToleranceMinutes;
  var rows = [];
  records.forEach(function (r) {
    if (r.recordStatus !== RECORD_STATUS.ACTIVE) return;
    if (!isIsoDateTime_(r.shiftStart) || !isIsoDateTime_(r.shiftEnd)) return;
    var startMin = wallMinutes_(r.shiftStart), endMin = wallMinutes_(r.shiftEnd);
    var overlapsWindow = startMin < winEnd && endMin > winStart;
    var carry = r.shiftDate === prev && endMin > dayStart && (w.fullDay || overlapsWindow || opts.showCarryOver);
    var nextDay = r.shiftDate === next && w.crossesMidnight && overlapsWindow;
    if (r.shiftDate !== dateIso && !carry && !nextDay) return;
    var flags = [];
    if (carry) flags.push('From previous day');
    if (nextDay) flags.push('Starts next day');
    if (endMin > (Math.floor(startMin / 1440) + 1) * 1440) flags.push('Overnight'); // ending exactly at 24:00 is not overnight
    if (!w.fullDay && r.shiftDate === dateIso && !overlapsWindow) flags.push('Outside operating hours');
    if (endMin - startMin > opts.maxShiftMinutes) flags.push('Long shift');
    var sched = r.scheduledMinutes;
    if (sched !== '' && sched !== null && sched !== undefined && isFinite(sched)) {
      var gross = endMin - startMin;
      if (Math.abs(sched - gross) > tol) flags.push('Hours differ');
    }
    var m = matchEmployee_(staffIdx, r.employeeId, r.employeeName, opts.nameStrategy);
    if (staffIdx) {
      if (m.status === STAFF_MATCH.UNKNOWN || m.status === STAFF_MATCH.AMBIGUOUS) flags.push('Unknown employee');
      if (m.staff && !m.staff.active) flags.push('Inactive employee');
    }
    rows.push({
      rec: r, startMin: startMin, endMin: endMin, carry: carry || nextDay, flags: flags,
      staffMatch: m.status, staffName: m.staff ? m.staff.employeeName : ''
    });
  });
  // Meetings: label them; a meeting inside a shift is expected, not an overlap.
  var inShift = {};
  findOverlaps_(rows).forEach(function (p) {
    if (classifyOverlap_(p[0], p[1]) === 'MEETING_IN_SHIFT') {
      inShift[rows.indexOf(activityCategoryOf_(p[0]) === ACTIVITY_CATEGORY.MEETING ? p[0] : p[1])] = true;
      return;
    }
    p.forEach(function (x) { if (x.flags.indexOf('Overlap') < 0) x.flags.push('Overlap'); });
  });
  rows.forEach(function (x, i) {
    if (activityCategoryOf_(x) === ACTIVITY_CATEGORY.MEETING) x.flags.unshift(inShift[i] ? 'Meeting (in shift)' : 'Meeting (outside shift)');
  });
  rows.sort(function (a, b) {
    return a.startMin - b.startMin || displayName_(a).localeCompare(displayName_(b));
  });
  return rows;
}

function displayName_(row) {
  return row.rec.employeeName || row.staffName || row.rec.employeeId || '';
}

function rowMatchesFilters_(row, f) {
  if (f.employee && f.employee !== ALL_OPTION && employeeOptionLabel_(row) !== f.employee) return false;
  if (f.activity && f.activity !== ALL_OPTION && typeOptionLabel_(row) !== f.activity) return false;
  if (f.status && f.status !== ALL_OPTION) {
    if (f.status === 'OK') return row.flags.length === 0;
    if (f.status === 'Has warnings') return row.flags.length > 0;
    return row.flags.some(function (x) { return x.indexOf(f.status) === 0; });
  }
  return true;
}

function employeeOptionLabel_(row) {
  var n = displayName_(row);
  return row.rec.employeeId && n !== row.rec.employeeId ? n + ' (' + row.rec.employeeId + ')' : n;
}

/** Value used by the type filter (G3): shift type, else activity. */
function typeOptionLabel_(row) {
  return row.rec.shiftType || row.rec.activity || '(none)';
}

/**
 * Headcount at the midpoint of each slot of up to one hour within [fromMin, toMin)
 * relative to 00:00 of the date; toMin may exceed 1440 (windows crossing midnight).
 */
function headcountByHour_(rows, dateIso, fromMin, toMin) {
  var base = dayNumber_(dateIso) * 1440;
  var hm = function (m) { return m > 0 && m % 1440 === 0 ? '24:00' : minutesToHm_(m); };
  var out = [];
  for (var h = fromMin; h < toMin; h += 60) {
    var slotEnd = Math.min(h + 60, toMin);
    var mid = base + h + (slotEnd - h) / 2;
    var seen = {};
    rows.forEach(function (r) {
      if (!(r.startMin <= mid && mid < r.endMin)) return;
      seen[employeeIdentity_(r.rec)] = true;
    });
    out.push({ label: minutesToHm_(h) + '–' + hm(slotEnd), count: Object.keys(seen).length });
  }
  return out;
}

/** Cell value + number format for one display field. */
function displayCell_(field, row, ctx) {
  var r = row.rec;
  // Times are shown as they are (e.g. 22:00 – 06:00); the Flags column says "Overnight" / "From previous day".
  var timeCell = function (mins) {
    if (mins === null || mins === undefined) return ['', '@'];
    return [serialFromMinutes_(mins), ctx.timeFormat];
  };
  var dur = function (m) { return [Math.round(m) / 1440, '[h]:mm']; };
  switch (field) {
    case 'date': return [serialFromIsoDate_(r.shiftDate), ctx.dateFormat];
    case 'employeeId': return [r.employeeId, '@'];
    case 'employeeName': return [safeCell_(displayName_(row)), '@'];
    case 'team': return [safeCell_(ctx.teamName), '@'];
    case 'activity': return [safeCell_(r.activity), '@'];
    case 'shiftType': return [safeCell_(r.shiftType), '@'];
    case 'activityCategory': return [r.activityCategory === ACTIVITY_CATEGORY.MEETING ? 'Meeting' : 'Shift', '@'];
    case 'sourceShiftInfo': return [safeCell_(r.sourceShiftInfo), '@'];
    case 'scheduledHours':
      return r.scheduledMinutes === '' || r.scheduledMinutes === null || r.scheduledMinutes === undefined
        ? [r.sourceHours ? safeCell_(r.sourceHours) : '', '@'] : dur(r.scheduledMinutes);
    case 'role': return [safeCell_(r.role), '@'];
    case 'start': return timeCell(row.startMin);
    case 'end': return timeCell(row.endMin);
    case 'grossDuration': return dur(r.grossMinutes || (row.endMin - row.startMin));
    case 'shiftStatus': return [safeCell_(r.shiftStatus), '@'];
    case 'flags': return [row.flags.length ? row.flags.join(', ') : 'OK', '@'];
    case 'staffMatch': return [row.staffMatch, '@'];
    case 'comment': return [safeCell_(r.comment), '@'];
  }
  if (field.indexOf(EXTRA_FIELD_PREFIX) === 0) {
    var v = r.extra ? r.extra[field.substr(EXTRA_FIELD_PREFIX.length)] : '';
    return [safeCell_(str_(v)), '@'];
  }
  return ['', '@'];
}

function fieldHeaderLabel_(f) {
  if (DISPLAY_FIELDS[f]) return DISPLAY_FIELDS[f].label;
  return f.indexOf(EXTRA_FIELD_PREFIX) === 0 ? f.substr(EXTRA_FIELD_PREFIX.length) : f;
}

/* ------------------------------------------------------------------------ */
/* Sheet layout                                                              */
/* ------------------------------------------------------------------------ */

function headcountColumn_(fields) {
  return Math.max(fields.length, VIEW.HEADER_COLS) + 2;
}

/**
 * Creates/repairs the static parts of a daily schedule sheet: labels, control
 * cells (date picker and filters), formatting, conditional formats, protection.
 * Never clears user control values (selected date/filters).
 */
function layoutScheduleSheet_(sh, team) {
  var cfg = getConfig_();
  var th = sheetTheme_(cfg);
  var fields = effectiveScheduleFields_(team);
  var hcCol = headcountColumn_(fields);
  var width = hcCol + 1;
  ensureColumns_(sh, width);
  ensureRows_(sh, VIEW.FIRST_DATA_ROW + 100);

  var labels = [
    [VIEW.INFO_ROW, 1, 'Team type:'], [VIEW.INFO_ROW, 4, 'Last import:'], [VIEW.INFO_ROW, 6, 'Import status:'], [VIEW.INFO_ROW, 8, 'Hours:'],
    [VIEW.FILTER_ROW, 1, 'Date:'], [VIEW.FILTER_ROW, 4, 'Employee:'], [VIEW.FILTER_ROW, 6, 'Shift type:'], [VIEW.FILTER_ROW, 8, 'Status:']
  ];
  labels.forEach(function (l) {
    sh.getRange(l[0], l[1]).setValue(l[2]).setFontWeight('bold').setFontColor('#5f6368').setHorizontalAlignment('right');
  });

  var dateCell = sh.getRange(VIEW.FILTER_ROW, VIEW.DATE_COL);
  if (isBlank_(dateCell.getValue())) dateCell.setValue(serialFromIsoDate_(todayIso_(cfg.TIMEZONE)));
  dateCell.setNumberFormat(cfg.DATE_FORMAT)
    .setDataValidation(SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(false)
      .setHelpText('Double-click to pick a date. The schedule refreshes automatically.').build())
    .setBackground(th.soft).setFontWeight('bold').setBorder(true, true, true, true, false, false, th.accent, SpreadsheetApp.BorderStyle.SOLID);
  [VIEW.EMPLOYEE_COL, VIEW.ACTIVITY_COL, VIEW.STATUS_COL].forEach(function (c) {
    var cell = sh.getRange(VIEW.FILTER_ROW, c);
    if (isBlank_(cell.getValue())) cell.setValue(ALL_OPTION);
    cell.setBackground(th.soft).setBorder(true, true, true, true, false, false, '#9aa0a6', SpreadsheetApp.BorderStyle.SOLID);
  });
  sh.getRange(VIEW.FILTER_ROW, VIEW.STATUS_COL).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(STATUS_FILTER_OPTIONS, true).setAllowInvalid(false).build());

  sh.getRange(VIEW.TITLE_ROW, 1).setFontSize(16).setFontWeight('bold').setFontColor(th.accent);
  sh.getRange(VIEW.SUMMARY_ROW, 1, 1, VIEW.HEADER_COLS).setBackground('#f8f9fa').setFontColor('#202124');
  sh.getRange(VIEW.MESSAGE_ROW, 1).setFontColor('#b06000').setFontStyle('italic');
  sh.setFrozenRows(VIEW.HEADER_ROW);
  sh.setRowHeight(VIEW.HEADER_ROW, 28);

  fields.forEach(function (f, i) {
    sh.setColumnWidth(i + 1, DISPLAY_FIELDS[f] ? DISPLAY_FIELDS[f].width : 140);
  });
  if (fields.length < VIEW.HEADER_COLS) {
    for (var c = fields.length + 1; c <= VIEW.HEADER_COLS; c++) sh.setColumnWidth(c, 110);
  }
  sh.setColumnWidth(hcCol - 1, 24);
  sh.setColumnWidth(hcCol, 100);
  sh.setColumnWidth(hcCol + 1, 85);

  var dataRows = sh.getMaxRows() - VIEW.FIRST_DATA_ROW + 1;
  var tableRange = sh.getRange(VIEW.FIRST_DATA_ROW, 1, dataRows, fields.length);
  var r0 = VIEW.FIRST_DATA_ROW;
  var lastL = columnLetter_(fields.length);
  var rules = [];
  var flagsIdx = fields.indexOf('flags');
  var catIdx = fields.indexOf('activityCategory');
  // Meeting rows are shaded so they stand apart from shifts. The row also says
  // "Meeting (in shift)" / "Meeting (outside shift)" in Flags or "Meeting" in Category.
  var meetingFormula = flagsIdx >= 0 ? '=LEFT($' + columnLetter_(flagsIdx + 1) + r0 + ',7)="Meeting"'
    : (catIdx >= 0 ? '=$' + columnLetter_(catIdx + 1) + r0 + '="Meeting"' : '');
  if (flagsIdx >= 0) {
    var F = '$' + columnLetter_(flagsIdx + 1) + r0;
    var flagRange = sh.getRange(r0, flagsIdx + 1, dataRows, 1);
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=OR(ISNUMBER(SEARCH("Overlap",' + F + ')),ISNUMBER(SEARCH("Unknown",' + F + ')))')
      .setBackground(th.error).setFontColor('#a50e0e').setRanges([flagRange]).build());
    // A meeting without other flags is not a warning.
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=AND(LEFT(' + F + ',7)="Meeting",ISERROR(SEARCH(",",' + F + ')))')
      .setBackground('#efe6fa').setFontColor('#66399b').setRanges([flagRange]).build());
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=AND(' + F + '<>"",' + F + '<>"OK")')
      .setBackground(th.warn).setRanges([flagRange]).build());
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=' + F + '="OK"')
      .setFontColor('#188038').setRanges([flagRange]).build());
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=OR(ISNUMBER(SEARCH("From previous day",' + F + ')),ISNUMBER(SEARCH("Starts next day",' + F + ')),ISNUMBER(SEARCH("Outside operating",' + F + ')))')
      .setFontColor('#80868b').setItalic(true).setRanges([tableRange]).build());
  }
  if (meetingFormula) {
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied(meetingFormula)
      .setBackground('#f6f1fc').setRanges([tableRange]).build());
  }
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=AND(COUNTA($A' + r0 + ':$' + lastL + r0 + ')>0,ISEVEN(ROW()))')
    .setBackground(th.band).setRanges([tableRange]).build());
  var hcRange = sh.getRange(r0, hcCol + 1, 24, 1);
  rules.push(SpreadsheetApp.newConditionalFormatRule().setGradientMaxpoint(th.accent)
    .setGradientMinpoint('#ffffff').setRanges([hcRange]).build());
  sh.setConditionalFormatRules(rules);

  var protections = sh.getProtections(SpreadsheetApp.ProtectionType.SHEET);
  var p = protections.length ? protections[0] : sh.protect();
  p.setDescription(APP.NAME + ': generated view. Edit schedules via import; edits here are overwritten on refresh.')
    .setWarningOnly(true)
    .setUnprotectedRanges([VIEW.DATE_COL, VIEW.EMPLOYEE_COL, VIEW.ACTIVITY_COL, VIEW.STATUS_COL].map(function (c) {
      return sh.getRange(VIEW.FILTER_ROW, c);
    }));
  sh.setTabColor(th.accent);
  applySheetFont_(sh, th);
}

/* ------------------------------------------------------------------------ */
/* Rendering                                                                 */
/* ------------------------------------------------------------------------ */

/**
 * Renders the team's default view.
 * opts: {date?: iso, resetFilters?: bool, useDefaultDate?: bool (apply the team's "default date" setting)}
 */
function renderTeamView_(team, opts) {
  // Register new view renderers here (and in VIEW_REGISTRY in Schema.gs).
  var renderers = { renderDailyView_: renderDailyView_ };
  var view = VIEW_REGISTRY[team.defaultView] || VIEW_REGISTRY.DAILY;
  var renderer = renderers[view.renderer] || renderDailyView_;
  return renderer(team, opts || {});
}

function renderDailyView_(team, opts) {
  var cfg = getConfig_();
  var th = sheetTheme_(cfg);
  var tz = getTz_();
  var sh = resolveTeamSheet_(team, 'schedule');
  if (!sh) fail_('MISSING_SHEET', 'The schedule sheet of team "' + team.teamName + '" is missing. Run Maintenance → Rebuild Missing Sheets.');
  var fields = effectiveScheduleFields_(team);
  var hcCol = headcountColumn_(fields);
  var display = team.settings.display;
  var timeFormat = display.timeFormat || cfg.TIME_FORMAT;

  var head = sh.getRange(VIEW.FILTER_ROW, 1, 1, VIEW.HEADER_COLS).getValues()[0];
  var dateIso = opts.date || '';
  if (!dateIso && opts.useDefaultDate) {
    if (display.defaultDate === 'TODAY') dateIso = todayIso_(cfg.TIMEZONE);
    else if (display.defaultDate === 'LATEST_IMPORT') {
      var li = lastImportForTeam_(team.teamId);
      if (li && li.status === IMPORT_STATUS.COMMITTED && isIsoDate_(li.dateFrom)) dateIso = li.dateFrom;
    }
  }
  dateIso = dateIso || cellToIsoDate_(head[VIEW.DATE_COL - 1], tz) || todayIso_(cfg.TIMEZONE);
  var filters;
  if (opts.filters) {
    // Set by the Schedule Viewer sidebar; written back to the filter cells below.
    filters = { employee: str_(opts.filters.employee), activity: str_(opts.filters.activity), status: str_(opts.filters.status) };
    if (filters.status && STATUS_FILTER_OPTIONS.indexOf(filters.status) < 0) filters.status = ALL_OPTION;
  } else filters = opts.resetFilters ? {} : {
    employee: str_(head[VIEW.EMPLOYEE_COL - 1]),
    activity: str_(head[VIEW.ACTIVITY_COL - 1]),
    status: str_(head[VIEW.STATUS_COL - 1])
  };

  var win = operatingWindow_(display);
  var showCarry = cfgBool_(cfg, 'SHOW_CARRY_OVER');
  var records = queryScheduleRecords_({ teamIds: [team.teamId], dates: [addDays_(dateIso, -1), dateIso, addDays_(dateIso, 1)] });
  var staffIdx = tryStaffIndex_(team);
  var rows = buildDayRows_(records, dateIso, staffIdx, {
    maxShiftMinutes: cfgNum_(cfg, 'MAX_SHIFT_HOURS', 16) * 60,
    nameStrategy: team.settings.import.nameMatch || cfg.NAME_MATCH_STRATEGY,
    showCarryOver: showCarry,
    window: win,
    hoursToleranceMinutes: cfgNum_(cfg, 'HOURS_TOLERANCE_MINUTES', 15)
  });

  var employeeOptions = uniq_(rows.map(employeeOptionLabel_)).sort();
  var activityOptions = uniq_(rows.map(typeOptionLabel_)).sort();
  if (filters.employee && filters.employee !== ALL_OPTION && employeeOptions.indexOf(filters.employee) < 0) filters.employee = ALL_OPTION;
  if (filters.activity && filters.activity !== ALL_OPTION && activityOptions.indexOf(filters.activity) < 0) filters.activity = ALL_OPTION;
  var visible = rows.filter(function (r) { return rowMatchesFilters_(r, filters); });

  // --- clear previous output (data, header, headcount) ---
  var lastRow = Math.max(sh.getLastRow(), VIEW.HEADER_ROW);
  var lastCol = Math.max(sh.getLastColumn(), hcCol + 1);
  sh.getRange(VIEW.HEADER_ROW, 1, lastRow - VIEW.HEADER_ROW + 1, lastCol).clearContent();
  sh.getRange(VIEW.HEADER_ROW, 1, 1, lastCol).clearFormat(); // header width may have changed
  ensureRows_(sh, VIEW.FIRST_DATA_ROW + Math.max(visible.length, 25));

  // --- header block ---
  var type = getTeamType_(team.teamTypeId);
  var lastImport = lastImportForTeam_(team.teamId);
  sh.getRange(VIEW.TITLE_ROW, 1).setValue(team.teamName + ' — Daily Schedule' + (team.active ? '' : ' (inactive team)'));
  var staffSh = resolveTeamSheet_(team, 'staff');
  sh.getRange(VIEW.TITLE_ROW, VIEW.HEADER_COLS).setValue(staffSh ? '=HYPERLINK("#gid=' + staffSh.getSheetId() + '","→ Staff directory")' : '');
  sh.getRange(VIEW.INFO_ROW, 2).setValue(type ? type.typeName : team.teamTypeId);
  sh.getRange(VIEW.INFO_ROW, 5).setValue(lastImport ? formatTimestamp_(lastImport.timestamp, tz) : 'never');
  sh.getRange(VIEW.INFO_ROW, 7).setValue(lastImport ? lastImport.status : '—');
  sh.getRange(VIEW.INFO_ROW, 9).setValue(win.label);
  sh.getRange(VIEW.FILTER_ROW, VIEW.DATE_COL).setValue(serialFromIsoDate_(dateIso));
  var weekday = Utilities.formatDate(new Date(Date.UTC(+dateIso.substr(0, 4), +dateIso.substr(5, 2) - 1, +dateIso.substr(8, 2), 12)), 'UTC', 'EEEE');
  sh.getRange(VIEW.FILTER_ROW, VIEW.WEEKDAY_COL).setValue(weekday);
  sh.getRange(VIEW.FILTER_ROW, VIEW.EMPLOYEE_COL).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList([ALL_OPTION].concat(employeeOptions).slice(0, 500), true).setAllowInvalid(true).build())
    .setValue(filters.employee || ALL_OPTION);
  sh.getRange(VIEW.FILTER_ROW, VIEW.ACTIVITY_COL).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList([ALL_OPTION].concat(activityOptions).slice(0, 500), true).setAllowInvalid(true).build())
    .setValue(filters.activity || ALL_OPTION);
  sh.getRange(VIEW.FILTER_ROW, VIEW.STATUS_COL).setValue(filters.status || ALL_OPTION);

  // --- summary ---
  var own = rows.filter(function (r) { return !r.carry; });
  var people = uniq_(own.map(function (r) { return employeeIdentity_(r.rec); }));
  var work = workMinutesByEmployee_(own);
  var netTotal = Object.keys(work).reduce(function (s, k) { return s + work[k]; }, 0);
  var meetingCount = own.filter(function (r) { return activityCategoryOf_(r) === ACTIVITY_CATEGORY.MEETING; }).length;
  var countFlag = function (f) { return rows.filter(function (r) { return r.flags.indexOf(f) >= 0; }).length; };
  var summary = 'Shifts: ' + (own.length - meetingCount) + (meetingCount ? '   |   Meetings: ' + meetingCount : '') +
    '   |   Staff: ' + people.length +
    '   |   Working hours: ' + formatMinutesAsDuration_(netTotal) +
    '   |   Overlaps: ' + countFlag('Overlap') +
    '   |   Unknown employees: ' + countFlag('Unknown employee') +
    (visible.length !== rows.length ? '   |   Showing ' + visible.length + ' of ' + rows.length + ' (filtered)' : '');
  sh.getRange(VIEW.SUMMARY_ROW, 1).setValue(summary);
  // Row 5 shows a problem when there is one, otherwise a short legend (text, so meaning never depends on color alone).
  var msgCell = sh.getRange(VIEW.MESSAGE_ROW, 1);
  if (!staffIdx) {
    msgCell.setValue('Staff sheet could not be read — employee matching is unavailable. Run Maintenance → Repair Formatting.')
      .setFontColor('#845000').setFontStyle('italic');
  } else {
    msgCell.setValue('Legend: "Meeting (…)" rows are meetings (shaded violet) and are separate from shifts · grey italic = previous/next day or outside operating hours · ' +
      'red flag = overlap or unknown employee. Change the date in B3 or the filters in row 3, or use Schedule Management → Schedule Viewer.')
      .setFontColor('#737c88').setFontStyle('normal');
  }

  // --- table ---
  var cfgHdr = th.header, cfgHdrFont = th.headerText;
  sh.getRange(VIEW.HEADER_ROW, 1, 1, fields.length).setValues([fields.map(fieldHeaderLabel_)])
    .setFontWeight('bold').setBackground(cfgHdr).setFontColor(cfgHdrFont).setFontFamily(th.font).setVerticalAlignment('middle');
  if (visible.length) {
    var ctx = { dateIso: dateIso, timeFormat: timeFormat, dateFormat: cfg.DATE_FORMAT, teamName: team.teamName };
    var values = [], formats = [];
    visible.forEach(function (row) {
      var v = [], f = [];
      fields.forEach(function (field) {
        var c = displayCell_(field, row, ctx);
        v.push(c[0]); f.push(c[1]);
      });
      values.push(v); formats.push(f);
    });
    var rng = sh.getRange(VIEW.FIRST_DATA_ROW, 1, values.length, fields.length);
    rng.setNumberFormats(formats);
    rng.setValues(values);
  } else {
    sh.getRange(VIEW.FIRST_DATA_ROW, 1).setValue(rows.length ? 'No shifts match the selected filters.' : 'No shifts scheduled for this date.');
  }

  // --- headcount ---
  if (display.showHeadcount) {
    var hc = headcountByHour_(rows, dateIso, win.startMin, win.endMin);
    sh.getRange(VIEW.HEADER_ROW, hcCol, 1, 2).setValues([['Hour', 'Headcount']])
      .setFontWeight('bold').setBackground(cfgHdr).setFontColor(cfgHdrFont);
    if (hc.length) {
      sh.getRange(VIEW.FIRST_DATA_ROW, hcCol, hc.length, 2)
        .setValues(hc.map(function (h) { return [h.label, h.count]; }))
        .setNumberFormats(hc.map(function () { return ['@', '0']; }));
    }
  }
  return {
    teamId: team.teamId, teamName: team.teamName, date: dateIso, weekday: weekday, shifts: rows.length, shown: visible.length,
    // Summary for the Schedule Viewer sidebar (same numbers as row 4)
    summary: {
      shifts: own.length - meetingCount, meetings: meetingCount, staff: people.length, workingHours: formatMinutesAsDuration_(netTotal),
      overlaps: countFlag('Overlap'), unknown: countFlag('Unknown employee'), carried: rows.length - own.length
    },
    hoursMode: display.operatingHoursMode || 'STANDARD', hoursLabel: win.label,
    lastImport: lastImport ? formatTimestamp_(lastImport.timestamp, tz) : '', importStatus: lastImport ? lastImport.status : '',
    filters: { employee: filters.employee || ALL_OPTION, activity: filters.activity || ALL_OPTION, status: filters.status || ALL_OPTION },
    employeeOptions: employeeOptions, activityOptions: activityOptions, statusOptions: STATUS_FILTER_OPTIONS
  };
}

/** Renders a team view, swallowing and logging failures (used after imports). */
function renderTeamViewSafe_(team, opts) {
  try { return renderTeamView_(team, opts || {}); }
  catch (e) { logError_('renderTeamViewSafe_', e); return null; }
}

/** Re-renders all READY teams. */
function refreshAllViews_() {
  var rep = newReport_();
  listTeams_().forEach(function (t) {
    if (t.status !== TEAM_STATUS.READY) { rep.warnings.push('"' + t.teamName + '" is ' + t.status + ' — run Rebuild Missing Sheets.'); return; }
    try { renderTeamView_(t, {}); rep.info.push('Refreshed "' + t.teamName + '".'); }
    catch (e) { rep.warnings.push('"' + t.teamName + '": ' + toUserError_(e).message); }
  });
  var d = rebuildDashboardSafe_();
  if (d) rep.info.push(d);
  return rep;
}

/** onEdit handler for team schedule control cells. */
function handleScheduleEdit_(team, range) {
  if (range.getRow() > VIEW.FILTER_ROW || range.getLastRow() < VIEW.FILTER_ROW) return;
  var c1 = range.getColumn(), c2 = range.getLastColumn();
  var hit = [VIEW.DATE_COL, VIEW.EMPLOYEE_COL, VIEW.ACTIVITY_COL, VIEW.STATUS_COL].some(function (c) { return c >= c1 && c <= c2; });
  if (!hit) return;
  if (c1 <= VIEW.DATE_COL && VIEW.DATE_COL <= c2) {
    var v = range.getSheet().getRange(VIEW.FILTER_ROW, VIEW.DATE_COL).getValue();
    if (!cellToIsoDate_(v, getTz_())) return; // invalid date: validation will show; do not render
  }
  renderTeamView_(team, {});
}

/* ------------------------------------------------------------------------ */
/* Client API (Navigator.html)                                               */
/* ------------------------------------------------------------------------ */

function apiNavigatorBootstrap() {
  return apiCall_('apiNavigatorBootstrap', function () {
    requireInitialized_();
    var cfg = getConfig_();
    var current = teamForSheet_(getSs_().getActiveSheet());
    return {
      teams: listTeams_().filter(function (t) { return t.status === TEAM_STATUS.READY; })
        .map(function (t) { return { teamId: t.teamId, teamName: t.teamName, active: t.active }; }),
      currentTeamId: current ? current.team.teamId : '',
      today: todayIso_(cfg.TIMEZONE)
    };
  });
}

/** Opens a team's schedule at a date (date '' keeps the current selection). */
function apiOpenSchedule(teamId, dateIso) {
  return apiCall_('apiOpenSchedule', function () {
    var team = requireTeam_(teamId);
    if (team.status !== TEAM_STATUS.READY) fail_('TEAM_NOT_READY', 'Team "' + team.teamName + '" is ' + team.status + '. Run Manage Existing Teams → Rebuild sheets.');
    if (dateIso && !isIsoDate_(dateIso)) fail_('VALIDATION', 'Choose a valid date.');
    var r = renderTeamView_(team, dateIso ? { date: dateIso } : { useDefaultDate: true });
    resolveTeamSheet_(team, 'schedule').activate();
    return r;
  });
}

/**
 * Schedule Viewer sidebar: renders a team's daily sheet for a date with
 * the given filters, activates it and returns the header facts and summary.
 * One call per user action; filters are stored in the sheet's filter cells as before.
 * @param {string} teamId
 * @param {string} dateIso '' applies the team's "when the schedule is opened" setting
 *   (Keep → the date shown in the sheet), as opening a team always did
 * @param {Object|null} filters {employee, activity, status} or null to keep the sheet's filters
 */
function apiViewerRender(teamId, dateIso, filters) {
  return apiCall_('apiViewerRender', function () {
    requireInitialized_();
    var team = requireTeam_(teamId);
    if (team.status !== TEAM_STATUS.READY) fail_('TEAM_NOT_READY', 'Team "' + team.teamName + '" is ' + team.status + '. Run Manage Existing Teams → Rebuild sheets.');
    if (dateIso && !isIsoDate_(dateIso)) fail_('VALIDATION', 'Choose a valid date.');
    var opts = {};
    if (dateIso) opts.date = dateIso; else opts.useDefaultDate = true;
    if (filters) opts.filters = filters;
    var r = renderTeamView_(team, opts);
    var sh = resolveTeamSheet_(team, 'schedule');
    if (getSs_().getActiveSheet().getSheetId() !== sh.getSheetId()) sh.activate();
    r.operatingModeLabel = OPERATING_HOURS_MODES[r.hoursMode] || r.hoursMode;
    return r;
  });
}
