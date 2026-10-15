/**
 * ValidationService.gs
 * Structure validation (sheets, columns, configuration, references) and data
 * validation (schedule records, staff sheets, interrupted imports).
 * Reports separate fatal errors, warnings and information.
 *
 * Dependencies: all read services.
 */

function validateStructure_() {
  var rep = newReport_();
  var ss = getSs_();
  SYSTEM_TABLES.forEach(function (def) {
    var sh = ss.getSheetByName(def.sheet);
    if (!sh) { rep.fatal.push('Missing system sheet ' + def.sheet + '. Run Maintenance → Rebuild Missing Sheets.'); return; }
    var missing = headerIndex_(def, readHeader_(sh)).missing;
    if (missing.length) rep.fatal.push(def.sheet + ' is missing column(s): ' + missing.join(', ') + '. Run Setup / Configure Spreadsheet → Repair.');
  });
  if (rep.fatal.length) return rep;

  var cfg = getConfig_();
  if (!cfgBool_(cfg, 'INITIALIZED')) rep.fatal.push('The system is not marked as initialized. Run Setup / Configure Spreadsheet.');
  if (cfg.SYSTEM_VERSION !== APP.VERSION) rep.warnings.push('Stored system version ' + cfg.SYSTEM_VERSION + ' differs from the code version ' + APP.VERSION + '. Run Setup / Configure Spreadsheet to upgrade the schema.');
  var check = {};
  CONFIG_DEFAULTS.forEach(function (d) { if (d[3] !== 'system') check[d[0]] = cfg[d[0]]; });
  var cfgRep = validateConfigUpdates_(check);
  cfgRep.fatal.forEach(function (m) { rep.fatal.push('Configuration: ' + m); });

  var types = listTeamTypes_(true);
  var profiles = listProfiles_();
  var profileIds = profiles.map(function (p) { return p.profileId; });
  var typeIds = types.map(function (t) { return t.typeId; });
  if (!types.some(function (t) { return t.enabled; })) rep.warnings.push('No team type is enabled. Enable or create one under Configure Team Types.');
  types.forEach(function (t) {
    if (t.defaultImportProfileId && profileIds.indexOf(t.defaultImportProfileId) < 0) rep.warnings.push('Team type "' + t.typeName + '" refers to a missing import profile (' + t.defaultImportProfileId + ').');
  });

  var teams = listTeams_();
  var teamIds = teams.map(function (t) { return t.teamId; });
  var seenNames = {}, seenSheets = {};
  teams.forEach(function (t) {
    var label = '"' + t.teamName + '" (' + t.teamId + ')';
    if (seenNames[normKey_(t.teamName)]) rep.fatal.push('Duplicate team name ' + label + '.');
    seenNames[normKey_(t.teamName)] = true;
    if (t.status !== TEAM_STATUS.READY) rep.fatal.push('Team ' + label + ' has status ' + t.status + (t.settings.lastError ? ' (' + t.settings.lastError + ')' : '') + '. Run Rebuild Missing Sheets.');
    if (typeIds.indexOf(t.teamTypeId) < 0) rep.warnings.push('Team ' + label + ' refers to a missing team type (' + t.teamTypeId + ').');
    if (t.importProfileId && profileIds.indexOf(t.importProfileId) < 0) rep.warnings.push('Team ' + label + ' refers to a missing import profile (' + t.importProfileId + ').');
    var regRep = newReport_();
    validateRegistryRefs_(t.settings.staffFields, regRep);
    regRep.fatal.forEach(function (m) { rep.warnings.push('Team ' + label + ': ' + m); });
    if (t.settings.import.shiftTypeMode === 'NOT_CONFIGURED') rep.info.push('Team ' + label + ' has no shift-type selection yet; imports containing shift types will ask for one.');
    if (t.settings.import.shiftTypeMode === 'SELECTED' && !t.settings.import.shiftTypes.length) rep.warnings.push('Team ' + label + ' imports only selected shift types, but none are selected.');
    ['schedule', 'staff'].forEach(function (k) {
      var sh = resolveTeamSheet_(t, k);
      if (!sh) { rep.fatal.push('The ' + k + ' sheet of team ' + label + ' is missing. Run Maintenance → Rebuild Missing Sheets.'); return; }
      var id = String(sh.getSheetId());
      if (seenSheets[id]) rep.fatal.push('Sheet "' + sh.getName() + '" is registered for two teams/roles (' + seenSheets[id] + ' and ' + label + ').');
      seenSheets[id] = label + ' ' + k;
    });
  });
  profiles.forEach(function (p) {
    if (p.options.defaultTeamId && teamIds.indexOf(p.options.defaultTeamId) < 0) rep.warnings.push('Profile "' + p.profileName + '" has a default team that no longer exists.');
    Object.keys(p.options.teamValueMap || {}).forEach(function (v) {
      if (teamIds.indexOf(p.options.teamValueMap[v]) < 0) rep.warnings.push('Profile "' + p.profileName + '" maps team value "' + v + '" to a team that no longer exists.');
    });
  });
  if (!ss.getSheetByName(cfg.DASHBOARD_SHEET)) rep.warnings.push('The dashboard sheet "' + cfg.DASHBOARD_SHEET + '" is missing. Run Rebuild Missing Sheets.');
  rebuildSheetIndex_();
  rep.info.push(SYSTEM_TABLES.length + ' system sheets, ' + teams.length + ' team(s), ' + types.length + ' team type(s), ' + profiles.length + ' mapping profile(s) checked.');
  return rep;
}

function validateData_() {
  var rep = newReport_();
  var cfg = getConfig_();
  var teams = listTeams_();
  var teamsById = {};
  teams.forEach(function (t) { teamsById[t.teamId] = t; });

  // Interrupted / failed imports
  readImportLog_().forEach(function (e) {
    if (e.status === IMPORT_STATUS.COMMITTING) rep.fatal.push('Import ' + e.importId + ' (' + e.sourceFile + ') was interrupted while writing. Run Schedule Import → Undo Last Import to roll it back, then import the file again.');
  });

  // Schedule records
  var data = readAllScheduleRecords_();
  var keys = {}, dupKeys = 0, bad = [], orphan = {}, active = [];
  data.records.forEach(function (r) {
    if (!r.recordKey) { bad.push('row ' + r._row + ': missing Record Key'); return; }
    if (keys[r.recordKey]) dupKeys++;
    keys[r.recordKey] = true;
    if (!isIsoDate_(r.shiftDate)) bad.push('row ' + r._row + ': invalid Shift Date "' + r.shiftDate + '"');
    else if (!isIsoDateTime_(r.shiftStart) || !isIsoDateTime_(r.shiftEnd)) bad.push('row ' + r._row + ': invalid start/end');
    else if (wallMinutes_(r.shiftEnd) <= wallMinutes_(r.shiftStart)) bad.push('row ' + r._row + ': end is not after start');
    if ([RECORD_STATUS.ACTIVE, RECORD_STATUS.REMOVED].indexOf(r.recordStatus) < 0) bad.push('row ' + r._row + ': unknown Record Status "' + r.recordStatus + '"');
    if (!teamsById[r.teamId]) orphan[r.teamId] = (orphan[r.teamId] || 0) + 1;
    if (r.recordStatus === RECORD_STATUS.ACTIVE && isIsoDateTime_(r.shiftStart) && isIsoDateTime_(r.shiftEnd)) {
      active.push({ rec: r, startMin: wallMinutes_(r.shiftStart), endMin: wallMinutes_(r.shiftEnd) });
    }
  });
  if (dupKeys) rep.fatal.push(dupKeys + ' duplicate Record Key(s) in _SCHEDULE_DATA (probably manual copy/paste). Remove the duplicates manually.');
  if (bad.length) rep.warnings.push(bad.length + ' malformed schedule record(s) (they are not displayed): ' + bad.slice(0, 10).join('; ') + (bad.length > 10 ? '; …' : ''));
  Object.keys(orphan).forEach(function (t) {
    rep.info.push(orphan[t] + ' record(s) belong to team ID "' + t + '", which is not registered (deleted team history is kept).');
  });
  var overlaps = findOverlaps_(active);
  if (overlaps.length) {
    rep.warnings.push(overlaps.length + ' overlapping shift pair(s): ' + overlaps.slice(0, 8).map(function (p) {
      return (p[0].rec.employeeName || p[0].rec.employeeId) + ' ' + p[0].rec.shiftStart + ' / ' + p[1].rec.shiftStart;
    }).join('; ') + (overlaps.length > 8 ? '; …' : ''));
  }
  var longMin = cfgNum_(cfg, 'MAX_SHIFT_HOURS', 16) * 60;
  var longCount = active.filter(function (a) { return a.endMin - a.startMin > longMin; }).length;
  if (longCount) rep.warnings.push(longCount + ' active shift(s) are longer than ' + cfg.MAX_SHIFT_HOURS + ' hours.');

  // Staff sheets and unknown employees (from today onwards)
  var today = todayIso_(cfg.TIMEZONE);
  teams.forEach(function (team) {
    if (team.status !== TEAM_STATUS.READY) return;
    var st;
    try { st = readStaff_(team); } catch (e) { rep.fatal.push('Team "' + team.teamName + '": ' + toUserError_(e).message); return; }
    var idx = buildStaffIndex_(st.rows);
    if (idx.duplicateIds.length) rep.fatal.push('Team "' + team.teamName + '": duplicate Employee ID(s) in the staff sheet: ' + idx.duplicateIds.join(', ') + '. Matching uses the first occurrence.');
    var dupIds = findDuplicateIdentifiers_(st.rows, st.keys, st.header, st.registry);
    Object.keys(dupIds).forEach(function (label) {
      if (label === STAFF_FIELD_DEFS.employeeId.label) return;
      rep.warnings.push('Team "' + team.teamName + '": duplicate ' + label + ' value(s): ' + dupIds[label].join(', ') + '.');
    });
    var noId = st.rows.filter(function (r) { return !r.employeeId; }).length;
    if (noId) rep.warnings.push('Team "' + team.teamName + '": ' + noId + ' staff row(s) have no Employee ID and cannot be matched by ID.');
    var badId = st.rows.filter(function (r) { return r.employeeId && !EMPLOYEE_ID_PATTERN_.test(r.employeeId); }).length;
    if (badId) rep.warnings.push('Team "' + team.teamName + '": ' + badId + ' Employee ID(s) contain unusual characters.');
    var unknown = {};
    active.forEach(function (a) {
      var r = a.rec;
      if (r.teamId !== team.teamId || r.shiftDate < today) return;
      var m = matchEmployee_(idx, r.employeeId, r.employeeName, cfg.NAME_MATCH_STRATEGY);
      if (m.status === STAFF_MATCH.UNKNOWN || m.status === STAFF_MATCH.AMBIGUOUS) unknown[r.employeeId || r.employeeName] = true;
    });
    var u = Object.keys(unknown);
    if (u.length) rep.warnings.push('Team "' + team.teamName + '": ' + u.length + ' employee(s) scheduled from today onwards are missing from the staff sheet: ' + u.slice(0, 10).join(', ') + (u.length > 10 ? ', …' : '') + '. Use View Staff Directory → Add unknown employees.');
  });

  var master = rebuildStaffMasterSafe_();
  if (master) {
    var conflicts = readTable_(T_STAFF_MASTER).rows.filter(function (r) { return str_(r.conflicts); });
    if (conflicts.length) rep.warnings.push(conflicts.length + ' employee(s) have different names or emails in different team staff sheets (see _STAFF_MASTER → Conflicts).');
    rep.info.push('_STAFF_MASTER rebuilt: ' + master.employees + ' employee(s).');
  }

  var staged = readTable_(T_STAGING).rows;
  var pending = uniq_(staged.map(function (r) { return str_(r.importId); }));
  if (pending.length) rep.info.push(pending.length + ' unconfirmed import preview(s) are staged; they are purged automatically after ' + cfg.STAGING_RETENTION_HOURS + ' hours.');
  rep.info.push(data.records.length + ' schedule record(s) checked (' + active.length + ' active).');
  return rep;
}
