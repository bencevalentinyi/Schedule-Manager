/**
 * ImportService.gs
 * Import orchestration: upload -> staging -> mapping -> analysis (plan) ->
 * confirmation -> journaled commit -> log -> view refresh. Also Undo.
 *
 * Integrity guarantees
 *  - Nothing reaches _SCHEDULE_DATA until the whole batch has been analysed and
 *    the administrator confirmed the exact plan (plan token).
 *  - The plan is recomputed under the document lock at commit time; if anything
 *    changed since the preview, the commit is refused and a fresh preview returned.
 *  - Before-images of every touched record are journaled in _IMPORT_CHANGES
 *    BEFORE the data write; the data write is a single setValues call.
 *  - The log row is written as COMMITTING first. An execution killed mid-way
 *    leaves COMMITTING, which Undo Last Import rolls back idempotently.
 *  - Records are never hard-deleted by imports (REPLACE marks them REMOVED).
 *
 * Record key (duplicate detection)
 *  - With a source Shift ID:  "S|<shiftId>"   (global, team is an attribute)
 *  - Otherwise composite:     "C|<teamId>|ID:<EMPLOYEE ID>|<start>|<end>|<activity>"
 *    (or "NM:<normalized name>" when the row has no Employee ID). Employee + date
 *    alone is never used, so several shifts per person per day are supported.
 *
 * Dependencies: all services (orchestrator).
 */

var COMPARE_FIELDS_ = ['teamId', 'shiftDate', 'employeeId', 'employeeName', 'activity', 'role',
  'shiftStart', 'shiftEnd', 'breakStart', 'breakEnd', 'breakMinutes', 'shiftStatus', 'sourceShiftId', 'comment',
  'shiftType', 'sourceShiftInfo', 'sourceHours', 'scheduledMinutes'];
var NUMERIC_COMPARE_FIELDS_ = ['breakMinutes', 'scheduledMinutes'];
var MAX_IMPORT_ROWS_ = 20000;

/* ======================================================================== */
/* Pure planning                                                             */
/* ======================================================================== */

/**
 * Record key. The shift-type part is appended only when a shift type exists, so
 * keys of records imported before v1.1 (no shift type) are unchanged.
 */
function buildRecordKey_(teamId, rec) {
  if (rec.shiftId) return 'S|' + str_(rec.shiftId);
  var emp = rec.employeeId ? 'ID:' + idKey_(rec.employeeId) : 'NM:' + normName_(rec.employeeName);
  var key = ['C', teamId, emp, rec.shiftStart, rec.shiftEnd, normText_(rec.activity)].join('|');
  return rec.shiftType ? key + '|ST:' + normText_(rec.shiftType) : key;
}

/** Converts a normalized row into the stored record shape (without import metadata). */
function toStoredRecord_(rec) {
  return {
    recordKey: rec.key,
    teamId: rec.teamId,
    shiftDate: rec.shiftDate,
    // resolvedEmployeeId is always the internal Employee ID ('' when an alternative match key found no one).
    employeeId: rec.resolvedEmployeeId !== undefined ? rec.resolvedEmployeeId : (rec.employeeId || ''),
    employeeName: rec.employeeName || '',
    staffMatch: rec.staffMatch || '',
    activity: rec.activity || '',
    role: rec.role || '',
    shiftStart: rec.shiftStart,
    shiftEnd: rec.shiftEnd,
    breakStart: rec.breakStart || '',
    breakEnd: rec.breakEnd || '',
    breakMinutes: rec.breakMinutes || 0,
    grossMinutes: rec.grossMinutes,
    netMinutes: rec.netMinutes,
    shiftStatus: rec.shiftStatus || '',
    recordStatus: RECORD_STATUS.ACTIVE,
    sourceShiftId: rec.shiftId || '',
    comment: rec.comment || '',
    extra: rec.extra || {},
    shiftType: rec.shiftType || '',
    sourceShiftInfo: rec.sourceShiftInfo || '',
    sourceHours: rec.sourceHours || '',
    scheduledMinutes: rec.scheduledMinutes === null || rec.scheduledMinutes === undefined ? '' : rec.scheduledMinutes
  };
}

function recordsEqual_(a, b) {
  for (var i = 0; i < COMPARE_FIELDS_.length; i++) {
    var f = COMPARE_FIELDS_[i];
    if (NUMERIC_COMPARE_FIELDS_.indexOf(f) >= 0) {
      if (toNumber_(a[f], 0) !== toNumber_(b[f], 0)) return false;
    } else if (str_(a[f]) !== str_(b[f])) return false;
  }
  return stableStringify_(a.extra || {}) === stableStringify_(b.extra || {});
}

/**
 * Builds a resolver from a source team value to a team ID.
 * Precedence: profile team-value map, then team ID / team name / import aliases.
 */
function buildTeamResolver_(teams, teamValueMap) {
  var explicit = {}, map = {}, conflicts = {};
  Object.keys(teamValueMap || {}).forEach(function (v) { explicit[normKey_(v)] = teamValueMap[v]; });
  var add = function (k, teamId) {
    k = normKey_(k);
    if (!k) return;
    if (map[k] && map[k] !== teamId) conflicts[k] = true; else map[k] = teamId;
  };
  teams.forEach(function (t) {
    add(t.teamId, t.teamId);
    add(t.teamName, t.teamId);
    splitList_(t.importAliases).forEach(function (a) { add(a, t.teamId); });
  });
  return function (value) {
    var k = normKey_(value);
    if (explicit[k]) return { teamId: explicit[k] };
    if (conflicts[k]) return { error: 'Team value "' + value + '" matches more than one team. Make the team names/aliases unique or map it in the import profile.' };
    if (map[k]) return { teamId: map[k] };
    return { error: 'Unknown team "' + value + '". Add it as an Import Alias of the right team (Manage Existing Teams → Edit) or map it in the import profile.' };
  };
}

function emptySummary_() {
  return {
    sourceRows: 0, validRows: 0, rejectedRows: 0, insert: 0, restore: 0, update: 0, remove: 0,
    unchanged: 0, skippedExisting: 0, changedPending: 0, duplicatesInFile: 0, otherTeamRows: 0,
    nameMatched: 0, nameMismatches: 0, inactiveStaff: 0, overnight: 0, overlapsCount: 0,
    unknownEmployeeCount: 0, dateFrom: '', dateTo: '', teams: [], unknownEmployees: [], overlaps: [],
    potentialDuplicates: 0,
    // v1.1
    scheduleDate: '', shiftTypes: [], excludedByShiftType: 0, newShiftTypes: [], missingEmployee: 0,
    unparseableShiftInfo: 0, invalidTimes: 0, hoursMissing: 0, hoursInvalid: 0, hoursDiscrepancies: 0,
    nonShiftRows: 0, shiftTypeFilters: []
  };
}

/**
 * Analyses a staged table against existing data. Pure: all data is injected.
 * @param {Object} input {table, headerRow (0-based), fieldMap, options {dateOrder, breakUnit, hoursUnit},
 *   teamMode, teamId, strategy, allowPartial, teams, profileOptions, existing (records),
 *   getStaffIndex(teamId) -> index|null, getShiftTypeFilter(teamId) -> {mode, types, known},
 *   sourceRowNumbers?: number[] (original row of each data row), preReport?: report, scheduleDate?: string, cfg}
 * @return {Object} plan {report, summary, actions, rejected, rowWarnings, token, canCommit, blockers, ...}
 */
function buildImportPlan_(input) {
  var rep = newReport_();
  var cfg = input.cfg || {};
  var opts = input.options || {};
  var table = input.table || [];
  var headerRow = input.headerRow || 0;
  var headers = buildHeaders_(table[headerRow] || []);
  var dataRows = table.slice(headerRow + 1);
  var strategy = input.strategy || 'ASK';
  var plan = {
    report: rep, headers: headers, columns: {}, summary: emptySummary_(), actions: [], rejected: [],
    rowWarnings: [], unmappedColumns: [], token: '', canCommit: false, blockers: [],
    strategy: strategy, teamMode: input.teamMode || 'AUTO', dateOrder: '', seenShiftTypesByTeam: {}
  };
  plan.summary.scheduleDate = input.scheduleDate || '';
  if (input.preReport) {
    mergeReport_(rep, input.preReport);
    plan.summary.nonShiftRows = input.preReport.nonShiftRows || 0;
    if (rep.fatal.length) return finalizePlan_(plan, input);
  }
  if (!DUPLICATE_STRATEGIES[strategy]) rep.fatal.push('Unknown duplicate strategy "' + strategy + '".');
  if (!table.length || !headers.length) rep.fatal.push('The file contains no header row.');

  var resolved = resolveFieldMap_(input.fieldMap || {}, headers);
  plan.columns = resolved.columns;
  resolved.missing.forEach(function (m) {
    rep.fatal.push('Column "' + m.header + '" (mapped to ' + importFieldLabel_(m.field) + ') is not in the file.');
  });
  mergeReport_(rep, validateMapping_(resolved.columns));
  var mappedIdx = {};
  Object.keys(resolved.columns).forEach(function (f) { mappedIdx[resolved.columns[f]] = true; });
  plan.unmappedColumns = headers.filter(function (h, i) { return !mappedIdx[i]; });
  if (rep.fatal.length) return finalizePlan_(plan, input);

  // ---- day/month order, decided once for the whole batch ----
  var order = opts.dateOrder || 'AUTO';
  if (order === 'AUTO') {
    var samples = [];
    ['date', 'endDate', 'start', 'end', 'breakStart', 'breakEnd'].forEach(function (f) {
      var i = resolved.columns[f];
      if (i === undefined) return;
      dataRows.forEach(function (r) { if (str_(r[i])) samples.push(str_(r[i])); });
    });
    var det = detectDateOrder_(samples);
    if (det.order === 'CONFLICT') {
      rep.fatal.push('The file mixes day/month orders (e.g. "' + det.example + '"). Fix the export or set the date order explicitly.');
    } else if (det.order === 'AMBIGUOUS') {
      rep.fatal.push('The date format is ambiguous: "' + det.example + '" could be day/month or month/day, and no value in the file settles it. Choose the date order (DMY or MDY) in the mapping step and save it in the profile.');
    } else {
      if (det.order !== 'NONE') rep.info.push('Detected date order ' + det.order + ' (from "' + det.example + '").');
      order = det.order === 'NONE' ? 'DMY' : det.order;
    }
    if (rep.fatal.length) return finalizePlan_(plan, input);
  }
  plan.dateOrder = order;

  // ---- team routing ----
  var teamsById = {};
  (input.teams || []).forEach(function (t) { teamsById[t.teamId] = t; });
  var profOpts = input.profileOptions || {};
  var teamCol = resolved.columns.team;
  var mode = input.teamMode || 'AUTO';
  var targetId = str_(input.teamId);
  if (mode === 'AUTO') {
    if (teamCol !== undefined) mode = 'SPLIT';
    else if (targetId) mode = 'EXPLICIT';
    else if (profOpts.defaultTeamId && teamsById[profOpts.defaultTeamId]) {
      mode = 'EXPLICIT'; targetId = profOpts.defaultTeamId;
      rep.info.push('Target team "' + teamsById[targetId].teamName + '" taken from the mapping profile default.');
    } else {
      rep.fatal.push('The target team cannot be determined: no team column is mapped and no team was selected. Select the target team.');
    }
  }
  plan.teamMode = mode;
  var target = targetId ? teamsById[targetId] : null;
  if ((mode === 'EXPLICIT' || mode === 'FILTER') && !target) rep.fatal.push(targetId ? 'The selected team no longer exists.' : 'Select the target team.');
  if ((mode === 'SPLIT' || mode === 'FILTER') && teamCol === undefined) rep.fatal.push('Map the "Team / Unit" column to split or filter rows by team.');
  if (target && target.status !== TEAM_STATUS.READY) rep.fatal.push('Team "' + target.teamName + '" is ' + target.status + ' (its sheets are incomplete). Run Manage Existing Teams → Rebuild sheets first.');
  if (rep.fatal.length) return finalizePlan_(plan, input);

  var resolver = buildTeamResolver_(input.teams || [], profOpts.teamValueMap || {});
  var nopts = {
    dateOrder: order,
    breakUnit: opts.breakUnit || 'MINUTES',
    hoursUnit: opts.hoursUnit || 'HOURS',
    stripZeros: toBool_(cfg.STRIP_LEADING_ZEROS),
    maxShiftMinutes: toNumber_(cfg.MAX_SHIFT_HOURS, 16) * 60,
    minShiftMinutes: toNumber_(cfg.MIN_SHIFT_MINUTES, 15),
    hoursToleranceMinutes: toNumber_(cfg.HOURS_TOLERANCE_MINUTES, 15)
  };

  var S = plan.summary;
  var valid = [], firstByKey = {};
  var otherTeamValues = {}, unknownTeamValues = {}, rejectedByTeam = {}, unknownEmp = {};
  var staffCache = {}, tzIgnored = false;
  var getStaff = function (teamId) {
    if (!Object.prototype.hasOwnProperty.call(staffCache, teamId)) {
      staffCache[teamId] = input.getStaffIndex ? input.getStaffIndex(teamId) : null;
      var ix = staffCache[teamId];
      if (!ix) rep.warnings.push('The staff sheet of "' + teamsById[teamId].teamName + '" could not be read; all its employees are treated as unknown.');
      else if (ix.matchFieldMissing) rep.warnings.push('Team "' + teamsById[teamId].teamName + '" matches employees by "' + ix.matchFieldLabel + '", but its staff sheet has no such column.');
    }
    return staffCache[teamId];
  };
  var reject = function (sourceRow, reasons, teamId, codes) {
    plan.rejected.push({ row: sourceRow, reasons: reasons, team: teamId && teamsById[teamId] ? teamsById[teamId].teamName : '' });
    if (teamId) rejectedByTeam[teamId] = (rejectedByTeam[teamId] || 0) + 1;
    (codes || []).forEach(function (c) {
      if (c === 'EMPLOYEE') S.missingEmployee++;
      else if (c === 'SHIFT_INFO') S.unparseableShiftInfo++;
      else if (c === 'TIME' || c === 'DATE') S.invalidTimes++;
    });
  };

  // ---- shift-type filter (per team; never "all" unless explicitly chosen) ----
  var stCol = resolved.columns.shiftType;
  var filterCache = {}, typeStats = {}, needsChoice = {}, cannotFilter = {}, newTypes = {};
  var filterFor = function (teamId) {
    if (!filterCache[teamId]) {
      var f = input.getShiftTypeFilter ? input.getShiftTypeFilter(teamId) : null;
      filterCache[teamId] = f || { mode: 'NOT_CONFIGURED', types: [], known: [] };
    }
    return filterCache[teamId];
  };

  dataRows.forEach(function (row, i) {
    var sourceRow = input.sourceRowNumbers ? input.sourceRowNumbers[i] : headerRow + 2 + i;
    if (row.every(function (c) { return str_(c) === ''; })) return;
    S.sourceRows++;
    var teamValue = teamCol !== undefined ? str_(row[teamCol]) : '';
    var teamId = null;
    if (mode === 'EXPLICIT') {
      teamId = target.teamId;
      if (teamValue) {
        var rt = resolver(teamValue);
        if (rt.teamId && rt.teamId !== teamId) otherTeamValues[teamValue] = (otherTeamValues[teamValue] || 0) + 1;
      }
    } else {
      var teamError = '';
      if (!teamValue) {
        if (profOpts.defaultTeamId && teamsById[profOpts.defaultTeamId]) teamId = profOpts.defaultTeamId;
        else teamError = 'The row has no team value.';
      } else {
        var r = resolver(teamValue);
        if (r.error) teamError = r.error; else teamId = r.teamId;
      }
      if (teamId && !teamsById[teamId]) { teamError = 'Team value "' + teamValue + '" points to a team that no longer exists.'; teamId = null; }
      if (mode === 'FILTER' && teamId !== target.teamId) {
        S.otherTeamRows++;
        if (teamError) unknownTeamValues[teamValue || '(blank)'] = (unknownTeamValues[teamValue || '(blank)'] || 0) + 1;
        return;
      }
      if (teamError) {
        unknownTeamValues[teamValue || '(blank)'] = (unknownTeamValues[teamValue || '(blank)'] || 0) + 1;
        reject(sourceRow, [teamError], null);
        return;
      }
    }
    var team = teamsById[teamId];
    if (team.status !== TEAM_STATUS.READY) {
      reject(sourceRow, ['Team "' + team.teamName + '" is ' + team.status + '; rebuild its sheets first.'], teamId);
      return;
    }
    // Shift-type filter, applied before validation so excluded rows never block the import.
    var filter = filterFor(teamId);
    if (stCol !== undefined) {
      var stype = normShiftType_(row[stCol]);
      var ts = typeStats[stype] = typeStats[stype] || { type: stype, rows: 0, included: 0, excluded: 0, isNew: false };
      ts.rows++;
      var seen = plan.seenShiftTypesByTeam[teamId] = plan.seenShiftTypesByTeam[teamId] || [];
      if (stype && seen.indexOf(stype) < 0) seen.push(stype);
      if (filter.known.indexOf(stype) < 0 && filter.types.indexOf(stype) < 0) { ts.isNew = true; newTypes[stype || '(blank)'] = true; }
      if (filter.mode === 'NOT_CONFIGURED') needsChoice[teamId] = true;
      else if (filter.mode === 'SELECTED' && filter.types.indexOf(stype) < 0) {
        ts.excluded++; S.excludedByShiftType++;
        return;
      }
      ts.included++;
    } else if (filter.mode === 'SELECTED') {
      cannotFilter[teamId] = true;
    }
    var rec = normalizeRow_(row, headers, resolved.columns, nopts);
    if (rec.tzIgnored) tzIgnored = true;
    if (rec.errors.length) { reject(sourceRow, rec.errors, teamId, rec.errorCodes); return; }
    rec.teamId = teamId;
    rec.sourceRow = sourceRow;
    if (rec.overnight) S.overnight++;
    if (rec.hoursMissing) S.hoursMissing++;
    if (rec.hoursInvalid) S.hoursInvalid++;
    if (rec.hoursDiscrepancy) S.hoursDiscrepancies++;

    var idx = getStaff(teamId);
    var altKey = !!idx && idx.matchField && idx.matchField !== 'employeeId';
    var m = matchEmployee_(idx, rec.employeeId, rec.employeeName, (idx && idx.nameMatch) || cfg.NAME_MATCH_STRATEGY);
    rec.staffMatch = m.status;
    if (m.staff && (m.status === STAFF_MATCH.NAME || altKey)) rec.resolvedEmployeeId = m.staff.employeeId;
    else rec.resolvedEmployeeId = altKey ? '' : rec.employeeId;
    if (altKey && rec.employeeId) rec.extra['Source ' + idx.matchFieldLabel] = rec.employeeId;
    if (!rec.employeeName && m.staff) rec.employeeName = m.staff.employeeName;
    if (m.status === STAFF_MATCH.UNKNOWN || m.status === STAFF_MATCH.AMBIGUOUS) {
      var uk = teamId + '|' + (rec.employeeId ? idKey_(rec.employeeId) : normName_(rec.employeeName));
      if (!unknownEmp[uk]) unknownEmp[uk] = { team: team.teamName, employeeId: rec.employeeId, employeeName: rec.employeeName, rows: 0, reason: m.note };
      unknownEmp[uk].rows++;
    }
    if (m.status === STAFF_MATCH.NAME) { S.nameMatched++; rec.warnings.push('Employee matched by name only ("' + rec.employeeName + '" → ' + m.staff.employeeId + ').'); }
    if (m.status === STAFF_MATCH.ID && m.note) { S.nameMismatches++; rec.warnings.push(m.note); }
    if (m.staff && !m.staff.active) { S.inactiveStaff++; rec.warnings.push('Employee ' + (m.staff.employeeId || m.staff.employeeName) + ' is marked Inactive in the staff directory.'); }

    rec.key = buildRecordKey_(teamId, rec);
    if (firstByKey[rec.key]) {
      var first = firstByKey[rec.key];
      if (recordsEqual_(toStoredRecord_(first), toStoredRecord_(rec))) {
        S.duplicatesInFile++;
        plan.rowWarnings.push({ row: sourceRow, messages: ['Exact duplicate of row ' + first.sourceRow + '; skipped.'] });
      } else {
        reject(sourceRow, ['Same shift (key) as row ' + first.sourceRow + ' but with different values. The file contains conflicting copies of one shift.'], teamId);
      }
      return;
    }
    firstByKey[rec.key] = rec;
    if (rec.warnings.length) plan.rowWarnings.push({ row: sourceRow, messages: rec.warnings });
    valid.push(rec);
  });

  // ---- diff against stored records ----
  var existing = input.existing || [];
  var existingByKey = {};
  existing.forEach(function (r) { existingByKey[r.recordKey] = r; });
  var incomingKeys = {};
  var teamStats = {};
  var stat = function (teamId) {
    return teamStats[teamId] = teamStats[teamId] || { teamId: teamId, teamName: teamsById[teamId] ? teamsById[teamId].teamName : teamId,
      rows: 0, dateFrom: '', dateTo: '', insert: 0, update: 0, remove: 0, unchanged: 0, skipped: 0, pending: 0, rejected: rejectedByTeam[teamId] || 0 };
  };
  valid.forEach(function (rec) {
    var st = stat(rec.teamId);
    st.rows++;
    if (!st.dateFrom || rec.shiftDate < st.dateFrom) st.dateFrom = rec.shiftDate;
    if (!st.dateTo || rec.shiftDate > st.dateTo) st.dateTo = rec.shiftDate;
    if (!S.dateFrom || rec.shiftDate < S.dateFrom) S.dateFrom = rec.shiftDate;
    if (!S.dateTo || rec.shiftDate > S.dateTo) S.dateTo = rec.shiftDate;
    incomingKeys[rec.key] = true;
    var stored = toStoredRecord_(rec);
    var ex = existingByKey[rec.key];
    if (!ex) {
      plan.actions.push({ type: 'INSERT', key: rec.key, teamId: rec.teamId, record: stored });
      S.insert++; st.insert++;
    } else if (ex.recordStatus === RECORD_STATUS.REMOVED) {
      plan.actions.push({ type: 'UPDATE', key: rec.key, teamId: rec.teamId, record: stored, before: ex, restore: true });
      S.restore++; st.insert++;
    } else if (recordsEqual_(ex, stored)) {
      S.unchanged++; st.unchanged++;
    } else if (strategy === 'SKIP') {
      S.skippedExisting++; st.skipped++;
    } else if (strategy === 'ASK') {
      S.changedPending++; st.pending++;
    } else {
      plan.actions.push({ type: 'UPDATE', key: rec.key, teamId: rec.teamId, record: stored, before: ex });
      S.update++; st.update++;
      if (ex.teamId !== rec.teamId) rep.warnings.push('Shift ' + rec.shiftId + ' moves from team ' + ex.teamId + ' to ' + rec.teamId + '.');
    }
  });
  Object.keys(rejectedByTeam).forEach(function (t) { stat(t).rejected = rejectedByTeam[t]; });

  if (strategy === 'REPLACE_RANGE') {
    Object.keys(teamStats).forEach(function (t) {
      if (rejectedByTeam[t] && teamStats[t].rows) {
        rep.fatal.push('Replace is blocked for "' + teamStats[t].teamName + '": ' + rejectedByTeam[t] + ' of its rows were rejected, and replacing would remove the stored versions of those shifts. Fix the rows or use Update.');
      }
    });
    existing.forEach(function (ex) {
      if (ex.recordStatus !== RECORD_STATUS.ACTIVE || incomingKeys[ex.recordKey]) return;
      var st = teamStats[ex.teamId];
      if (!st || !st.rows || ex.shiftDate < st.dateFrom || ex.shiftDate > st.dateTo) return;
      // With a shift-type selection, only shifts of the selected types are replaced.
      var f = filterFor(ex.teamId);
      if (stCol !== undefined && f.mode === 'SELECTED' && f.types.indexOf(normShiftType_(ex.shiftType)) < 0) return;
      plan.actions.push({ type: 'REMOVE', key: ex.recordKey, teamId: ex.teamId, before: ex });
      S.remove++; st.remove++;
    });
  }

  // ---- overlaps in the resulting state, for the employees in this import ----
  var identities = {};
  valid.forEach(function (rec) { identities[employeeIdentity_(toStoredRecord_(rec))] = true; });
  var finalMap = {};
  existing.forEach(function (ex) {
    if (ex.recordStatus === RECORD_STATUS.ACTIVE && identities[employeeIdentity_(ex)] &&
        isIsoDateTime_(ex.shiftStart) && isIsoDateTime_(ex.shiftEnd)) finalMap[ex.recordKey] = ex;
  });
  plan.actions.forEach(function (a) { if (a.type === 'REMOVE') delete finalMap[a.key]; else finalMap[a.key] = a.record; });
  var finalList = Object.keys(finalMap).map(function (k) {
    var r = finalMap[k];
    return { rec: r, startMin: wallMinutes_(r.shiftStart), endMin: wallMinutes_(r.shiftEnd) };
  });
  var pairs = findOverlaps_(finalList).filter(function (p) { return incomingKeys[p[0].rec.recordKey] || incomingKeys[p[1].rec.recordKey]; });
  S.overlapsCount = pairs.length;
  S.overlaps = pairs.slice(0, 30).map(function (p) {
    var a = p[0].rec, b = p[1].rec;
    return (a.employeeName || a.employeeId) + ': ' + a.shiftStart + '–' + a.shiftEnd.substr(11) + ' overlaps ' + b.shiftStart + '–' + b.shiftEnd.substr(11);
  });

  // ---- summary and messages ----
  S.validRows = valid.length;
  S.rejectedRows = plan.rejected.length;
  S.teams = Object.keys(teamStats).map(function (k) { return teamStats[k]; });
  S.unknownEmployees = Object.keys(unknownEmp).map(function (k) { return unknownEmp[k]; }).slice(0, 100);
  S.unknownEmployeeCount = Object.keys(unknownEmp).length;
  S.potentialDuplicates = S.unchanged + S.skippedExisting + S.changedPending + S.duplicatesInFile;
  S.shiftTypes = Object.keys(typeStats).sort().map(function (k) { return typeStats[k]; });
  S.newShiftTypes = Object.keys(newTypes).sort();
  S.shiftTypeFilters = Object.keys(filterCache).map(function (t) {
    var f = filterCache[t];
    return { teamId: t, teamName: teamsById[t] ? teamsById[t].teamName : t, mode: f.mode, types: f.types };
  });

  // Shift-type decisions are blocking: nothing is imported "by default".
  Object.keys(needsChoice).forEach(function (t) {
    rep.fatal.push('Team "' + teamsById[t].teamName + '" has no shift-type selection yet. Select the shift types to import (or "Import all shift types") before importing.');
  });
  Object.keys(cannotFilter).forEach(function (t) {
    rep.fatal.push('Team "' + teamsById[t].teamName + '" imports only selected shift types, but no Shift Type column is mapped. Map the column, or set the team to import all shift types.');
  });
  if (S.newShiftTypes.length) {
    rep.warnings.push('Shift type(s) not seen before: ' + S.newShiftTypes.map(function (t) { return '"' + t + '"'; }).join(', ') +
      '. They are imported only if selected; review the selection.');
  }
  if (S.excludedByShiftType) rep.info.push(S.excludedByShiftType + ' row(s) were excluded because their shift type is not selected.');
  if (S.hoursMissing) rep.warnings.push(S.hoursMissing + ' row(s) have no scheduled hours.');
  if (S.hoursInvalid) rep.warnings.push(S.hoursInvalid + ' row(s) have scheduled hours that are not a valid duration.');
  if (S.hoursDiscrepancies) rep.warnings.push(S.hoursDiscrepancies + ' row(s) have scheduled hours that differ from the shift length by more than ' +
    toNumber_(cfg.HOURS_TOLERANCE_MINUTES, 15) + ' minutes (possible breaks, multiple assignments or rounding). They are imported and flagged "Hours differ".');

  var listCounts = function (o) { return Object.keys(o).slice(0, 10).map(function (k) { return '"' + k + '" (' + o[k] + ')'; }).join(', '); };
  if (Object.keys(otherTeamValues).length) {
    rep.warnings.push('The team column names other teams for some rows: ' + listCounts(otherTeamValues) + '. Because you chose "All rows go to the selected team", they will be imported into "' + target.teamName + '". Use "Split by team column" if that is wrong.');
  }
  if (Object.keys(unknownTeamValues).length) {
    var msg = 'Unrecognized team values: ' + listCounts(unknownTeamValues) + '.';
    if (mode === 'FILTER') rep.info.push(msg + ' These rows were skipped because they do not belong to the selected team.');
    else rep.warnings.push(msg + ' Those rows were rejected. Add the values as Import Aliases of the right team, or map them in the import profile.');
  }
  if (mode === 'FILTER' && S.otherTeamRows) rep.info.push(S.otherTeamRows + ' row(s) belong to other teams and were skipped.');
  if (S.teams.length > 1) rep.info.push('The file contains shifts for ' + S.teams.length + ' teams; rows are split by team as shown below.');
  if (tzIgnored) rep.warnings.push('Some date-times carry a time-zone suffix (e.g. Z or +02:00). The suffix was ignored and the times were used as local wall-clock times.');
  if (S.unknownEmployeeCount) rep.warnings.push(S.unknownEmployeeCount + ' employee(s) are not in their team\'s staff directory. Their shifts are imported and flagged "Unknown employee". You can add them later from View Staff Directory.');
  if (S.nameMatched) rep.warnings.push(S.nameMatched + ' row(s) were matched to staff by exact name only (no Employee ID in the file). Verify them.');
  if (S.nameMismatches) rep.info.push(S.nameMismatches + ' row(s) have a name that differs from the staff directory for the same Employee ID.');
  if (S.inactiveStaff) rep.warnings.push(S.inactiveStaff + ' row(s) belong to employees marked Inactive.');
  if (S.duplicatesInFile) rep.warnings.push(S.duplicatesInFile + ' exact duplicate row(s) in the file will be skipped.');
  if (S.changedPending) rep.warnings.push(S.changedPending + ' shift(s) already exist with different values. Choose Skip, Update or Replace to continue.');
  if (S.skippedExisting) rep.info.push(S.skippedExisting + ' existing shift(s) differ from the file but are kept unchanged (Skip strategy).');
  if (S.unchanged) rep.info.push(S.unchanged + ' shift(s) are already stored with identical values.');
  if (S.overlapsCount) rep.warnings.push(S.overlapsCount + ' overlapping shift pair(s) would exist after this import (see list).');
  if (S.overnight) rep.info.push(S.overnight + ' overnight shift(s) end on the following day.');
  if (plan.rejected.length) rep.warnings.push(plan.rejected.length + ' row(s) were rejected (see list).');
  if (plan.unmappedColumns.length) rep.info.push('Unmapped columns are preserved in each record\'s Extra JSON: ' + plan.unmappedColumns.join(', ') + '.');
  return finalizePlan_(plan, input);
}

function finalizePlan_(plan, input) {
  var S = plan.summary, b = [];
  if (plan.report.fatal.length) b.push('Resolve the errors listed under "Must fix".');
  if (plan.strategy === 'ASK' && S.changedPending) b.push('Choose how existing shifts with different values are handled.');
  if (S.rejectedRows && !input.allowPartial && !plan.report.fatal.length) b.push(S.rejectedRows + ' row(s) were rejected. Fix the file, or tick "Import the valid rows and skip rejected rows".');
  if (!plan.report.fatal.length && !S.validRows) b.push('There are no valid rows to import.');
  plan.blockers = b;
  plan.canCommit = b.length === 0;
  plan.token = hashString_([
    plan.strategy, plan.teamMode, plan.dateOrder, S.rejectedRows, S.unchanged, S.skippedExisting,
    S.excludedByShiftType, S.scheduleDate, stableStringify_(S.shiftTypeFilters),
    plan.actions.map(function (a) {
      return a.type + ':' + a.key + ':' + (a.record ? hashString_(stableStringify_(a.record)) : '') +
        ':' + (a.before ? hashString_(stableStringify_(a.before.updatedAt ? String(a.before.updatedAt) : '') + a.before.lastImportId) : '');
    }).sort().join(',')
  ].join('|'));
  return plan;
}

/* ======================================================================== */
/* Staging (between upload, preview and commit)                              */
/* ======================================================================== */

var STAGING_CHUNK_ = 45000;

function stageTable_(importId, payload) {
  var json = JSON.stringify(payload);
  var now = new Date();
  var rows = [];
  for (var i = 0, k = 0; i < json.length; i += STAGING_CHUNK_, k++) {
    // "~" prefix: a chunk can never start with = + - @ and be read as a formula.
    rows.push({ importId: importId, chunk: k, payload: '~' + json.substr(i, STAGING_CHUNK_), createdAt: now });
  }
  appendObjects_(T_STAGING, rows);
}

function loadStaged_(importId) {
  var t = readTable_(T_STAGING);
  var parts = t.rows.filter(function (r) { return str_(r.importId) === importId; })
    .sort(function (a, b) { return a.chunk - b.chunk; })
    .map(function (r) { return String(r.payload).replace(/^~/, ''); });
  if (!parts.length) fail_('IMPORT_EXPIRED', 'This import preview has expired or was already completed. Upload the file again.');
  try { return JSON.parse(parts.join('')); }
  catch (e) { fail_('IMPORT_EXPIRED', 'The staged import data is damaged. Upload the file again.'); }
}

/** Rewrites the staging table keeping only rows for which keep(row) is true. */
function rewriteStaging_(keep) {
  var t = readTable_(T_STAGING);
  var kept = [], removed = 0;
  for (var r = 1; r < t.values.length; r++) {
    var row = t.values[r];
    if (row.every(isBlank_)) continue;
    if (keep(rowToObject_(T_STAGING, t.idx, row, r + 1))) kept.push(row); else removed++;
  }
  if (removed) replaceAllRows_(t.sheet, T_STAGING, t.header, kept, t.lastRow);
  return removed;
}

function clearStaged_(importId) {
  return rewriteStaging_(function (r) { return str_(r.importId) !== importId; });
}

function purgeOldStaging_(hours) {
  var cutoff = Date.now() - hours * 3600000;
  return rewriteStaging_(function (r) { return !(isDate_(r.createdAt) && r.createdAt.getTime() < cutoff); });
}

/* ======================================================================== */
/* Inspection, analysis, commit                                              */
/* ======================================================================== */

/**
 * Inspects a staged table and decides its format.
 * @param {{profileId?, headerRow?, format?, layout?, scheduleDate?, dateOrder?}} opts
 *   format: 'QUINYX_DAILY' | 'TABLE' | '' (auto: profile format, else A1 "Daily schedule …")
 */
function inspectTable_(table, opts, cfg) {
  opts = opts || {};
  var pid = str_(opts.profileId) || 'AUTO';
  var profile = pid !== 'AUTO' && pid !== 'NONE' ? getProfile_(pid) : null;
  if (pid !== 'AUTO' && pid !== 'NONE' && !profile) fail_('NOT_FOUND', 'The selected mapping profile no longer exists.');
  var format = opts.format || (profile ? profile.options.format : (pid === 'AUTO' && looksLikeDailySchedule_(table) ? 'QUINYX_DAILY' : 'TABLE'));
  if (format === 'QUINYX_DAILY') {
    if (!profile || profile.options.format !== 'QUINYX_DAILY') profile = findDailyProfile_(listProfiles_());
    return inspectDaily_(table, opts, profile, pid === 'AUTO' && !opts.format ? 'Cell A1 looks like a Quinyx "Daily schedule" title.' : 'Selected by you.');
  }
  var r = inspectGenericTable_(table, { profileId: profile && profile.options.format === 'QUINYX_DAILY' ? 'NONE' : pid, headerRow: opts.headerRow }, cfg);
  r.format = 'TABLE';
  return r;
}

/** Inspection of a Quinyx Daily Schedule: date, layout check, discovered shift types, raw preview. */
function inspectDaily_(table, opts, profile, reason) {
  var popts = profile ? profile.options : DEFAULT_PROFILE_OPTIONS;
  var layout = normalizeDailyLayout_(opts.layout || popts.dailyLayout || DEFAULT_DAILY_LAYOUT);
  var rep = newReport_();
  layout = validateDailyLayout_(layout, rep);
  var dateOrder = opts.dateOrder || popts.dateOrder || 'AUTO';
  var a = adaptDailySchedule_(table, layout, { dateOrder: dateOrder, dateOverride: opts.scheduleDate });
  mergeReport_(rep, a);
  var width = Math.min(12, table.reduce(function (w, r) { return Math.max(w, r.length); }, 0));
  var preview = table.slice(0, Math.max(layout.firstDataRow + 6, 8)).map(function (r, i) {
    return { row: i + 1, cells: r.slice(0, width) };
  });
  return {
    format: 'QUINYX_DAILY',
    profileId: profile ? profile.profileId : '',
    profileName: profile ? profile.profileName : '',
    profileDescription: profile ? profile.description : '',
    profileReason: reason + (profile ? '' : ' No Daily Schedule profile exists yet; the default layout is used.'),
    options: popts,
    layout: layout,
    dateOrder: dateOrder,
    title: a.title,
    parsedDate: a.parsedDate,
    dateError: a.dateError,
    scheduleDate: a.scheduleDate,
    dateSource: a.dateSource,
    headerLabels: a.headerLabels,
    rawPreview: preview,
    columnLetters: Array.apply(null, Array(width)).map(function (_, i) { return columnLetter_(i + 1); }),
    shiftTypes: layout.shiftTypeColumn ? discoverShiftTypes_(a.table, a.fieldMap.shiftType) : [],
    dataRows: a.dataRows,
    nonShiftRows: a.nonShiftRows,
    totalRows: a.dataRows,
    report: rep,
    mappingReport: rep
  };
}

/**
 * Generic table: detects the header row, picks a profile and suggests a mapping.
 * @param {string[][]} table
 * @param {{profileId: string, headerRow: number}} opts headerRow is 1-based, 0 = auto
 */
function inspectGenericTable_(table, opts, cfg) {
  var synIdx = buildSynonymIndex_(getSynonyms_(cfg));
  var profile = null, reason = '';
  var pid = str_(opts.profileId) || 'AUTO';
  if (pid !== 'AUTO' && pid !== 'NONE') {
    profile = getProfile_(pid);
    if (!profile) fail_('NOT_FOUND', 'The selected mapping profile no longer exists.');
    reason = 'Selected by you.';
  }
  var hr = toNumber_(opts.headerRow, 0);
  var headerRow = hr > 0 ? hr - 1 : (profile && profile.options.headerRow > 0 ? profile.options.headerRow - 1 : detectHeaderRow_(table, synIdx));
  if (headerRow >= table.length) fail_('VALIDATION', 'Header row ' + (headerRow + 1) + ' is beyond the end of the file (' + table.length + ' rows).');
  var headers = buildHeaders_(table[headerRow]);
  if (pid === 'AUTO') {
    var ch = chooseProfileForHeaders_(listProfiles_(), headers);
    profile = ch.profile;
    reason = ch.reason;
  } else if (pid === 'NONE') {
    reason = 'No profile: columns were mapped automatically from their names.';
  }
  var auto = autoMapHeaders_(headers, synIdx);
  var fieldMap = {}, missing = [];
  if (profile && Object.keys(profile.fieldMap).length) {
    var res = resolveFieldMap_(profile.fieldMap, headers);
    Object.keys(res.columns).forEach(function (f) { fieldMap[f] = headers[res.columns[f]]; });
    missing = res.missing;
  } else {
    fieldMap = auto.fieldMap;
  }
  var cols = resolveFieldMap_(fieldMap, headers).columns;
  var mappingReport = validateMapping_(cols);
  if (missing.length) {
    mappingReport.warnings.push('The profile expects column(s) that are not in this file: ' +
      missing.map(function (m) { return '"' + m.header + '" (' + importFieldLabel_(m.field) + ')'; }).join(', ') + '. Map them manually or choose another profile.');
  }
  auto.ambiguous.forEach(function (a) {
    if (!fieldMap[a.field]) mappingReport.warnings.push('Several columns could be "' + importFieldLabel_(a.field) + '": ' + a.candidates.join(', ') + '. Choose the right one.');
  });
  var dataRows = table.slice(headerRow + 1).filter(function (r) { return r.some(function (c) { return c !== ''; }); });
  var options = profile ? profile.options : JSON.parse(JSON.stringify(DEFAULT_PROFILE_OPTIONS));
  if (!profile) options.dateOrder = cfg.DEFAULT_DATE_ORDER || 'AUTO';
  return {
    headerRow: headerRow + 1,
    headers: headers,
    preHeaderRows: table.slice(0, headerRow).slice(0, 5),
    sampleRows: dataRows.slice(0, 5),
    totalRows: dataRows.length,
    fieldMap: fieldMap,
    ambiguous: auto.ambiguous,
    profileId: profile ? profile.profileId : '',
    profileName: profile ? profile.profileName : '',
    profileReason: reason,
    options: options,
    mappingReport: mappingReport,
    teamValues: describeTeamValues_(dataRows, cols.team, options)
  };
}

/** Distinct values of the team column with the team each resolves to. */
function describeTeamValues_(dataRows, teamCol, options) {
  if (teamCol === undefined) return [];
  var teams = listTeams_();
  var resolver = buildTeamResolver_(teams, (options && options.teamValueMap) || {});
  var counts = {};
  dataRows.forEach(function (r) { var v = str_(r[teamCol]) || '(blank)'; counts[v] = (counts[v] || 0) + 1; });
  return Object.keys(counts).slice(0, 50).map(function (v) {
    var res = v === '(blank)' ? { error: 'blank' } : resolver(v);
    var t = res.teamId ? teams.filter(function (x) { return x.teamId === res.teamId; })[0] : null;
    return { value: v, rows: counts[v], teamId: res.teamId || '', teamName: t ? t.teamName : '' };
  });
}

/**
 * Loads all inputs and builds the plan for a staged import.
 * req: {importId, format, profileId, headerRow, fieldMap, layout, scheduleDate, options{dateOrder,
 *   breakUnit, hoursUnit}, teamMode, teamId, strategy, allowPartial,
 *   shiftTypeOverride?: {teamId, mode, types}, saveShiftTypes?: bool, token?}
 */
function analyzeStaged_(req) {
  var cfg = getConfig_();
  var staged = loadStaged_(req.importId);
  var profile = req.profileId ? getProfile_(req.profileId) : null;
  var popts = profile ? profile.options : DEFAULT_PROFILE_OPTIONS;
  var teams = listTeams_();
  var data = readAllScheduleRecords_();
  var options = req.options || {};
  var profileOptions = {
    teamValueMap: options.teamValueMap || popts.teamValueMap || {},
    defaultTeamId: options.defaultTeamId !== undefined ? options.defaultTeamId : (popts.defaultTeamId || '')
  };
  var teamsById = {};
  teams.forEach(function (t) { teamsById[t.teamId] = t; });
  var override = req.shiftTypeOverride && req.shiftTypeOverride.teamId ? req.shiftTypeOverride : null;
  if (override && !SHIFT_TYPE_MODES[override.mode]) override = null;

  var input = {
    table: staged.table,
    headerRow: Math.max(toNumber_(req.headerRow, 1), 1) - 1,
    fieldMap: req.fieldMap || {},
    options: {
      dateOrder: options.dateOrder || popts.dateOrder || 'AUTO',
      breakUnit: options.breakUnit || popts.breakUnit || 'MINUTES',
      hoursUnit: options.hoursUnit || popts.hoursUnit || 'HOURS'
    },
    teamMode: req.teamMode || 'AUTO',
    teamId: req.teamId || '',
    strategy: req.strategy || cfg.DEFAULT_DUPLICATE_STRATEGY || 'ASK',
    allowPartial: !!req.allowPartial,
    teams: teams,
    profileOptions: profileOptions,
    existing: data.records,
    getStaffIndex: function (teamId) { return teamsById[teamId] ? tryStaffIndex_(teamsById[teamId], true) : null; },
    getShiftTypeFilter: function (teamId) {
      var team = teamsById[teamId];
      var base = team ? teamShiftTypeFilter_(team) : { mode: 'NOT_CONFIGURED', types: [], known: [] };
      if (override && override.teamId === teamId) {
        return { mode: override.mode, types: uniq_((override.types || []).map(normShiftType_)), known: base.known };
      }
      return base;
    },
    cfg: cfg
  };
  if (req.format === 'QUINYX_DAILY') {
    var pre = newReport_();
    var layout = validateDailyLayout_(req.layout || popts.dailyLayout || DEFAULT_DAILY_LAYOUT, pre);
    var a = adaptDailySchedule_(staged.table, layout, { dateOrder: input.options.dateOrder, dateOverride: req.scheduleDate });
    mergeReport_(pre, a);
    pre.nonShiftRows = a.nonShiftRows;
    input.table = a.table;
    input.headerRow = 0;
    input.fieldMap = a.fieldMap;
    input.sourceRowNumbers = a.sourceRows;
    input.preReport = pre;
    input.scheduleDate = a.scheduleDate;
  }
  var plan = buildImportPlan_(input);
  return { plan: plan, meta: staged.meta, data: data, teamsById: teamsById, override: override };
}

function planForClient_(plan, meta) {
  return {
    sourceFile: meta.fileName,
    format: meta.format,
    sheetName: meta.sheetName,
    fileWarnings: meta.warnings || [],
    previewOnly: !!meta.previewOnly,
    summary: plan.summary,
    report: plan.report,
    rejected: plan.rejected.slice(0, 200),
    rejectedTotal: plan.rejected.length,
    rowWarnings: plan.rowWarnings.slice(0, 100),
    rowWarningsTotal: plan.rowWarnings.length,
    unmappedColumns: plan.unmappedColumns,
    token: plan.token,
    canCommit: plan.canCommit && !meta.previewOnly,
    blockers: plan.blockers,
    teamMode: plan.teamMode,
    dateOrder: plan.dateOrder,
    strategy: plan.strategy
  };
}

/** Writes journal rows (before-images) for all non-insert actions plus insert keys. */
function appendJournal_(importId, actions) {
  var rows = actions.map(function (a, i) {
    var before = '';
    if (a.before) {
      var b = {};
      Object.keys(a.before).forEach(function (k) { if (k !== '_row') b[k] = a.before[k]; });
      if (isDate_(b.updatedAt)) b.updatedAt = b.updatedAt.toISOString();
      before = JSON.stringify(b);
      if (before.length > 49000) fail_('IMPORT_FAILED', 'Record ' + a.key + ' is too large to journal for undo (Extra JSON too big). Reduce the number of unmapped columns in the export.');
    }
    return { importId: importId, seq: i + 1, recordKey: a.key, action: a.type, before: before };
  });
  appendObjects_(T_CHANGES, rows);
}

/**
 * Applies plan actions to _SCHEDULE_DATA with one setValues call: rows from the
 * first modified row to the end are rewritten together with appended rows.
 */
function applyActionsToData_(table, actions, importId, now) {
  var values = table.values;
  var header = table.header;
  var keyCol = table.idx.recordKey;
  var rowByKey = {};
  for (var r = 1; r < values.length; r++) {
    var k = str_(values[r][keyCol]);
    if (k) rowByKey[k] = r;
  }
  var minIdx = Infinity, appended = [];
  actions.forEach(function (a) {
    var rec;
    if (a.type === 'INSERT') {
      rec = JSON.parse(JSON.stringify(a.record));
      rec.createdImportId = importId; rec.lastImportId = importId; rec.updatedAt = now;
      appended.push(objectToRow_(T_SCHEDULE, header, rec, null));
      return;
    }
    var idx = rowByKey[a.key];
    if (idx === undefined) fail_('PLAN_CHANGED', 'Record ' + a.key + ' changed while the import was running. Analyse the import again.');
    if (a.type === 'REMOVE') {
      rec = { recordStatus: RECORD_STATUS.REMOVED, lastImportId: importId, updatedAt: now };
    } else {
      rec = JSON.parse(JSON.stringify(a.record));
      rec.createdImportId = a.before.createdImportId || importId; rec.lastImportId = importId; rec.updatedAt = now;
    }
    values[idx] = objectToRow_(T_SCHEDULE, header, rec, values[idx]);
    minIdx = Math.min(minIdx, idx);
  });
  var block = minIdx === Infinity ? [] : values.slice(minIdx);
  var startRow = minIdx === Infinity ? table.lastRow + 1 : minIdx + 1;
  block = block.concat(appended);
  if (block.length) writeRows_(table.sheet, T_SCHEDULE, header, startRow, block);
  return { written: block.length, appended: appended.length };
}

/**
 * Commits a confirmed import. Caller holds the document lock.
 * @return {{status: 'COMMITTED'|'PLAN_CHANGED', ...}}
 */
function commitImport_(req) {
  var a = analyzeStaged_(req);
  var plan = a.plan, meta = a.meta;
  if (meta.previewOnly) fail_('PREVIEW_ONLY', 'This import was opened with Preview Import, which never writes data. Use Import Quinyx Export to apply it.');
  if (plan.token !== req.token) {
    return { status: 'PLAN_CHANGED', preview: planForClient_(plan, meta),
      message: 'The stored schedule or the settings changed since the preview was created. Review the updated preview and confirm again.' };
  }
  if (!plan.canCommit) fail_('BLOCKED', 'The import cannot be applied: ' + plan.blockers.join(' '), plan.report);

  var S = plan.summary;
  var importId = req.importId;
  var now = new Date();
  var rejectedSummary = plan.rejected.slice(0, 5).map(function (r) { return 'row ' + r.row + ': ' + r.reasons.join(' '); }).join(' | ');
  var includedTypes = S.shiftTypes.filter(function (t) { return t.included; }).map(function (t) { return t.type || '(blank)'; });
  appendImportLog_({
    importId: importId, timestamp: now, sourceFile: meta.fileName, sourceFileId: '',
    format: meta.format + (req.format === 'QUINYX_DAILY' ? ' · Daily Schedule' + (S.scheduleDate ? ' ' + S.scheduleDate : '') : ''),
    profileId: req.profileId || '',
    rowsExcluded: S.excludedByShiftType, shiftTypes: includedTypes.join(', ').substr(0, 1000),
    teams: S.teams.map(function (t) { return t.teamName + ' [' + t.teamId + ']'; }).join(', '),
    dateFrom: S.dateFrom, dateTo: S.dateTo, rowsProcessed: S.sourceRows,
    rowsInserted: S.insert + S.restore, rowsUpdated: S.update,
    rowsSkipped: S.unchanged + S.skippedExisting + S.duplicatesInFile + S.otherTeamRows,
    rowsRemoved: S.remove, rowsRejected: S.rejectedRows, strategy: plan.strategy,
    status: IMPORT_STATUS.COMMITTING, errorSummary: rejectedSummary.substr(0, 1000),
    user: currentUserEmail_(), fileHash: meta.fileHash || ''
  });

  var stage = 'START';
  try {
    if (plan.actions.length) {
      appendJournal_(importId, plan.actions);
      stage = 'JOURNALED';
      applyActionsToData_(a.data.table, plan.actions, importId, now);
    }
    stage = 'DATA_WRITTEN';
    SpreadsheetApp.flush();
  } catch (e) {
    logError_('commitImport_.' + stage, e);
    var msg = toUserError_(e).message;
    try { updateImportLog_(importId, { status: IMPORT_STATUS.FAILED, errorSummary: ('Failed at ' + stage + ': ' + msg).substr(0, 1000) }); }
    catch (e2) { logError_('commitImport_.logFailure', e2); }
    fail_('IMPORT_FAILED', 'The import could not be completed and the schedule data was not changed. ' + msg +
      ' If this keeps happening, run Maintenance → Validate Data.');
  }
  updateImportLog_(importId, { status: IMPORT_STATUS.COMMITTED });

  var post = [];
  try { clearStaged_(importId); } catch (e3) { logError_('commitImport_.clearStaged', e3); }
  try {
    var saved = saveShiftTypeKnowledge_(plan, a.teamsById, req.saveShiftTypes ? a.override : null);
    if (saved) post.push(saved);
  } catch (e4) {
    logError_('commitImport_.shiftTypes', e4);
    post.push('The data was imported, but the shift-type selection could not be saved to the team. Set it under Manage Existing Teams → Edit.');
  }
  S.teams.forEach(function (ts) {
    var team = getTeam_(ts.teamId);
    if (!team) return;
    var opts = team.settings.display.defaultDate === 'LATEST_IMPORT' && ts.dateFrom ? { date: ts.dateFrom } : {};
    if (!renderTeamViewSafe_(team, opts)) post.push('The view of "' + team.teamName + '" could not be refreshed; use Refresh Schedule Data.');
  });
  rebuildDashboardSafe_();
  return {
    status: 'COMMITTED', importId: importId,
    inserted: S.insert + S.restore, updated: S.update, removed: S.remove,
    unchanged: S.unchanged, skipped: S.skippedExisting + S.duplicatesInFile + S.otherTeamRows,
    excluded: S.excludedByShiftType, rejected: S.rejectedRows, teams: S.teams,
    dateFrom: S.dateFrom, dateTo: S.dateTo, scheduleDate: S.scheduleDate,
    warnings: plan.report.warnings.concat(post)
  };
}

/**
 * After a commit: records the shift types each team has now seen (so later
 * imports can flag really new ones), adds them to the global discovery list and,
 * if requested, saves the selection made in the import wizard to the team.
 */
function saveShiftTypeKnowledge_(plan, teamsById, override) {
  var all = [];
  var msg = '';
  Object.keys(plan.seenShiftTypesByTeam).forEach(function (teamId) {
    var team = getTeam_(teamId);
    if (!team) return;
    var seen = plan.seenShiftTypesByTeam[teamId];
    all = all.concat(seen);
    var imp = team.settings.import;
    var before = stableStringify_(imp);
    imp.knownShiftTypes = uniq_(imp.knownShiftTypes.concat(seen)).sort();
    if (override && override.teamId === teamId) {
      imp.shiftTypeMode = override.mode;
      imp.shiftTypes = uniq_((override.types || []).map(normShiftType_).filter(Boolean));
      msg = 'Saved the shift-type selection to team "' + team.teamName + '" (' +
        (imp.shiftTypeMode === 'ALL' ? 'all shift types' : imp.shiftTypes.join(', ')) + ').';
    }
    team.settings.import = normalizeTeamImport_(imp);
    if (stableStringify_(team.settings.import) !== before) saveTeamRow_(team);
  });
  addKnownShiftTypes_(all);
  return msg;
}

/**
 * Reverts the most recent COMMITTED (or interrupted COMMITTING) import using its
 * journal. Idempotent: records not last touched by that import are left alone.
 */
function undoImport_(expectedImportId) {
  var cand = findUndoCandidate_();
  if (!cand) fail_('NOTHING_TO_UNDO', 'There is no committed import to undo.');
  if (expectedImportId && cand.importId !== expectedImportId) {
    fail_('STALE', 'The latest import is now ' + cand.importId + ', not ' + expectedImportId + '. Reopen Import History and try again.');
  }
  var importId = cand.importId;
  var journal = readJournal_(importId);
  var data = readAllScheduleRecords_();
  var t = data.table, values = t.values, idx = t.idx;
  var rowByKey = {};
  for (var r = 1; r < values.length; r++) {
    var k = str_(values[r][idx.recordKey]);
    if (k) rowByKey[k] = r;
  }
  var del = {}, appended = [], restored = 0, deleted = 0, skipped = 0;
  journal.slice().reverse().forEach(function (j) {
    var row = rowByKey[j.recordKey];
    var touchedByThis = row !== undefined && str_(values[row][idx.lastImportId]) === importId;
    if (j.action === 'INSERT') {
      if (touchedByThis) { del[row] = true; deleted++; } else skipped++;
      return;
    }
    var before = parseJson_(j.before, null);
    if (!before) { skipped++; return; }
    if (before.updatedAt && !isDate_(before.updatedAt)) {
      var d = new Date(before.updatedAt);
      before.updatedAt = isNaN(d.getTime()) ? '' : d;
    }
    if (row === undefined) { appended.push(objectToRow_(T_SCHEDULE, t.header, before, null)); restored++; return; }
    if (!touchedByThis) { skipped++; return; }
    values[row] = objectToRow_(T_SCHEDULE, t.header, before, values[row]);
    restored++;
  });
  var newRows = [];
  for (var i = 1; i < values.length; i++) {
    if (del[i] || values[i].every(isBlank_)) continue;
    newRows.push(values[i]);
  }
  newRows = newRows.concat(appended);
  replaceAllRows_(t.sheet, T_SCHEDULE, t.header, newRows, t.lastRow);
  updateImportLog_(importId, {
    status: IMPORT_STATUS.UNDONE,
    errorSummary: ('Undone ' + Utilities.formatDate(new Date(), getTz_(), 'yyyy-MM-dd HH:mm') + (currentUserEmail_() ? ' by ' + currentUserEmail_() : '') +
      (cand.status === IMPORT_STATUS.COMMITTING ? ' (interrupted import rolled back)' : '') + '. ' + str_(cand.errorSummary)).substr(0, 1000)
  });
  var teamIds = uniq_(journal.map(function (j) { return (j.recordKey.split('|')[0] === 'C' ? j.recordKey.split('|')[1] : ''); }).filter(Boolean));
  listTeams_().forEach(function (team) {
    if (team.status === TEAM_STATUS.READY && (teamIds.indexOf(team.teamId) >= 0 || cand.teams.indexOf('[' + team.teamId + ']') >= 0)) renderTeamViewSafe_(team, {});
  });
  rebuildDashboardSafe_();
  return { importId: importId, sourceFile: cand.sourceFile, deleted: deleted, restored: restored, skipped: skipped,
    wasInterrupted: cand.status === IMPORT_STATUS.COMMITTING };
}

/* ======================================================================== */
/* Client API (ImportDialog.html)                                            */
/* ======================================================================== */

function apiImportBootstrap(previewOnly) {
  return apiCall_('apiImportBootstrap', function () {
    requireInitialized_();
    var cfg = getConfig_();
    var teams = listTeams_();
    var teamSheetIds = {};
    teams.forEach(function (t) {
      [t.settings.scheduleSheetId, t.settings.staffSheetId].forEach(function (id) { if (id) teamSheetIds[id] = true; });
    });
    var current = teamForSheet_(getSs_().getActiveSheet());
    return {
      previewOnly: !!previewOnly,
      teams: teams.map(function (t) {
        var imp = t.settings.import;
        return { teamId: t.teamId, teamName: t.teamName, status: t.status, active: t.active, importProfileId: t.importProfileId,
          scheduleType: imp.scheduleType, shiftTypeMode: imp.shiftTypeMode, shiftTypes: imp.shiftTypes,
          knownShiftTypes: imp.knownShiftTypes, duplicateStrategy: imp.duplicateStrategy };
      }),
      currentTeamId: current ? current.team.teamId : '',
      profiles: listProfiles_().map(function (p) {
        return { profileId: p.profileId, profileName: p.profileName, description: p.description, fieldCount: Object.keys(p.fieldMap).length, format: p.options.format };
      }),
      importFields: IMPORT_FIELDS,
      importFormats: IMPORT_FORMATS,
      shiftTypeModes: SHIFT_TYPE_MODES,
      defaultLayout: DEFAULT_DAILY_LAYOUT,
      strategies: DUPLICATE_STRATEGIES,
      teamModes: TEAM_MODES,
      defaultStrategy: cfg.DEFAULT_DUPLICATE_STRATEGY,
      maxFileMb: cfgNum_(cfg, 'MAX_FILE_MB', 10),
      driveAvailable: typeof Drive !== 'undefined',
      sourceSheets: getSs_().getSheets().filter(function (s) {
        var n = s.getName();
        return n.charAt(0) !== '_' && !teamSheetIds[s.getSheetId()] && n !== cfg.DASHBOARD_SHEET;
      }).map(function (s) { return s.getName(); })
    };
  });
}

function apiImportUpload(payload) {
  return apiCall_('apiImportUpload', function () {
    requireInitialized_();
    payload = payload || {};
    var cfg = getConfig_();
    var parsed = payload.source === 'SHEET'
      ? readSheetAsTable_(str_(payload.sheetName))
      : parseUploadedFile_(payload, cfgNum_(cfg, 'MAX_FILE_MB', 10) * 1048576);
    if (!parsed.table.length) fail_('VALIDATION', 'The file contains no rows.');
    if (parsed.table.length > MAX_IMPORT_ROWS_ + 30) fail_('FILE_TOO_LARGE', 'The file has ' + parsed.table.length + ' rows; the limit per import is ' + MAX_IMPORT_ROWS_ + '. Export a shorter date range.');
    var importId = newId_('IMP');
    var meta = {
      fileName: payload.source === 'SHEET' ? 'Sheet tab: ' + parsed.sheetName : str_(payload.fileName),
      format: parsed.format, sheetName: parsed.sheetName, sheetNames: parsed.sheetNames,
      encoding: parsed.encoding, delimiter: parsed.delimiter, fileHash: parsed.fileHash,
      warnings: parsed.warnings, previewOnly: !!payload.previewOnly
    };
    withLock_(function () {
      purgeOldStaging_(cfgNum_(cfg, 'STAGING_RETENTION_HOURS', 24));
      stageTable_(importId, { meta: meta, table: parsed.table });
    });
    var insp = inspectTable_(parsed.table, { profileId: payload.profileId || 'AUTO', headerRow: 0, format: payload.format || '' }, cfg);
    insp.importId = importId;
    insp.meta = meta;
    insp.previousImport = findCommittedByHash_(meta.fileHash);
    return insp;
  });
}

/**
 * Team dialog helper: reads an export only to list its shift types (nothing is
 * staged or imported). The discovered types are added to the global list.
 */
function apiDiscoverShiftTypes(payload, profileId) {
  return apiCall_('apiDiscoverShiftTypes', function () {
    requireInitialized_();
    var cfg = getConfig_();
    var parsed = parseUploadedFile_(payload || {}, cfgNum_(cfg, 'MAX_FILE_MB', 10) * 1048576);
    var profile = profileId ? getProfile_(profileId) : null;
    var insp = inspectTable_(parsed.table, { profileId: profile ? profile.profileId : 'AUTO', format: profile ? '' : 'QUINYX_DAILY' }, cfg);
    var types = [];
    if (insp.format === 'QUINYX_DAILY') types = insp.shiftTypes;
    else if (insp.fieldMap && insp.fieldMap.shiftType) {
      types = discoverShiftTypes_([insp.headers].concat(parsed.table.slice(insp.headerRow)), insp.fieldMap.shiftType);
    }
    withLock_(function () { addKnownShiftTypes_(types.map(function (t) { return t.type; })); });
    return { format: insp.format, scheduleDate: insp.scheduleDate || '', shiftTypes: types, report: insp.mappingReport };
  });
}

function apiImportInspect(importId, opts) {
  return apiCall_('apiImportInspect', function () {
    var staged = loadStaged_(importId);
    var insp = inspectTable_(staged.table, opts || {}, getConfig_());
    insp.importId = importId;
    insp.meta = staged.meta;
    return insp;
  });
}

function apiImportAnalyze(req) {
  return apiCall_('apiImportAnalyze', function () {
    requireInitialized_();
    var a = analyzeStaged_(req || {});
    return planForClient_(a.plan, a.meta);
  });
}

function apiImportCommit(req) {
  return apiCall_('apiImportCommit', function () {
    requireInitialized_();
    return withLock_(function () { return commitImport_(req || {}); }, 60000);
  });
}

function apiImportCancel(importId) {
  return apiCall_('apiImportCancel', function () {
    if (!importId) return { cleared: 0 };
    return withLock_(function () { return { cleared: clearStaged_(importId) }; });
  });
}

function apiUndoLastImport(expectedImportId) {
  return apiCall_('apiUndoLastImport', function () {
    requireInitialized_();
    return withLock_(function () { return undoImport_(expectedImportId || ''); }, 60000);
  });
}
