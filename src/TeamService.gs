/**
 * TeamService.gs
 * Team registry (_TEAMS): creation workflow, editing, activation, deletion
 * rules, sheet resolution (rename-tolerant via sheet IDs) and the onEdit index.
 *
 * Team lifecycle: PENDING (row written, sheets being built) -> READY, or ERROR
 * if sheet creation failed. Only READY teams receive imports and are rendered.
 *
 * Dependencies: Schema.gs, Utils.gs, SheetStore.gs, ConfigService.gs,
 *   TeamTypeService.gs, ImportMappingService.gs, StaffService.gs,
 *   ScheduleService.gs, DashboardService.gs
 */

function rowToTeam_(r) {
  var s = r.settings && typeof r.settings === 'object' ? r.settings : {};
  return {
    teamId: str_(r.teamId),
    teamName: str_(r.teamName),
    teamTypeId: str_(r.teamTypeId),
    active: r.active === '' || r.active === null ? true : toBool_(r.active),
    status: str_(r.status) || TEAM_STATUS.PENDING,
    scheduleSheet: str_(r.scheduleSheet),
    staffSheet: str_(r.staffSheet),
    defaultView: VIEW_REGISTRY[str_(r.defaultView)] ? str_(r.defaultView) : 'DAILY',
    importProfileId: str_(r.importProfileId),
    importAliases: str_(r.importAliases),
    description: str_(r.description),
    settings: {
      display: mergeDisplay_(s.display),
      scheduleFields: normalizeScheduleFields_(Array.isArray(s.scheduleFields) ? s.scheduleFields : DEFAULT_SCHEDULE_FIELDS),
      staffFields: normalizeStaffFields_(Array.isArray(s.staffFields) ? s.staffFields : DEFAULT_STAFF_FIELDS),
      extraFields: Array.isArray(s.extraFields) ? s.extraFields.map(str_).filter(Boolean) : [],
      import: normalizeTeamImport_(s.import),
      scheduleSheetId: s.scheduleSheetId || null,
      staffSheetId: s.staffSheetId || null,
      lastError: s.lastError || ''
    },
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    _row: r._row
  };
}

/** Per-team import settings merged over defaults (pure). */
function normalizeTeamImport_(imp) {
  imp = imp && typeof imp === 'object' ? imp : {};
  var out = JSON.parse(JSON.stringify(DEFAULT_TEAM_IMPORT));
  if (IMPORT_FORMATS[imp.scheduleType]) out.scheduleType = imp.scheduleType;
  if (imp.matchField === 'employeeId' || /^field:[a-z0-9_]{1,40}$/.test(str_(imp.matchField))) out.matchField = imp.matchField;
  if (Object.prototype.hasOwnProperty.call(NAME_MATCH_STRATEGIES, str_(imp.nameMatch))) out.nameMatch = str_(imp.nameMatch);
  if (SHIFT_TYPE_MODES[imp.shiftTypeMode]) out.shiftTypeMode = imp.shiftTypeMode;
  out.shiftTypes = uniq_((Array.isArray(imp.shiftTypes) ? imp.shiftTypes : []).map(normShiftType_).filter(Boolean));
  out.knownShiftTypes = uniq_((Array.isArray(imp.knownShiftTypes) ? imp.knownShiftTypes : []).map(normShiftType_).filter(Boolean)
    .concat(out.shiftTypes));
  if (imp.duplicateStrategy && DUPLICATE_STRATEGIES[imp.duplicateStrategy]) out.duplicateStrategy = imp.duplicateStrategy;
  out.importMeetings = imp.importMeetings === undefined ? false : toBool_(imp.importMeetings);
  out.meetingTypes = uniq_((Array.isArray(imp.meetingTypes) ? imp.meetingTypes : []).map(normShiftType_).filter(Boolean));
  out.knownShiftTypes = uniq_(out.knownShiftTypes.concat(out.meetingTypes));
  return out;
}

/**
 * The shift-type filter a team applies to imports:
 * {mode, types, known, importMeetings, meetingTypes}. Meeting types are matched
 * exactly (after whitespace normalization) and win over the shift-type list.
 */
function teamShiftTypeFilter_(team) {
  var imp = team.settings.import || DEFAULT_TEAM_IMPORT;
  return { mode: imp.shiftTypeMode, types: imp.shiftTypes.slice(), known: imp.knownShiftTypes.slice(),
    importMeetings: !!imp.importMeetings, meetingTypes: (imp.meetingTypes || []).slice() };
}

function listTeams_() {
  return readTable_(T_TEAMS).rows.map(rowToTeam_).filter(function (t) { return t.teamId; });
}

function getTeam_(teamId) {
  var all = listTeams_();
  for (var i = 0; i < all.length; i++) if (all[i].teamId === teamId) return all[i];
  return null;
}

function requireTeam_(teamId) {
  var t = getTeam_(teamId);
  if (!t) fail_('NOT_FOUND', 'The selected team does not exist (it may have been deleted). Reopen the dialog and choose another team.');
  return t;
}

function saveTeamRow_(team) {
  team.updatedAt = new Date();
  updateObject_(T_TEAMS, team);
}

function findSheetById_(id) {
  if (id === null || id === undefined || id === '') return null;
  var sheets = getSs_().getSheets();
  for (var i = 0; i < sheets.length; i++) if (sheets[i].getSheetId() === Number(id)) return sheets[i];
  return null;
}

/**
 * Returns the team's sheet of the given kind ('schedule' | 'staff') or null.
 * Tolerates manual renames: if the stored name is gone but the stored sheet ID
 * still exists, the registry is healed to the new name.
 */
function resolveTeamSheet_(team, kind) {
  var nameKey = kind === 'schedule' ? 'scheduleSheet' : 'staffSheet';
  var idKey = kind === 'schedule' ? 'scheduleSheetId' : 'staffSheetId';
  var id = team.settings[idKey];
  var byId = findSheetById_(id);
  if (byId) {
    if (byId.getName() !== team[nameKey]) {
      team[nameKey] = byId.getName();
      try { saveTeamRow_(team); } catch (e) { logError_('resolveTeamSheet_.heal', e); }
    }
    return byId;
  }
  var byName = team[nameKey] ? getSs_().getSheetByName(team[nameKey]) : null;
  if (byName && !id) {
    team.settings[idKey] = byName.getSheetId();
    try { saveTeamRow_(team); } catch (e2) { logError_('resolveTeamSheet_.bind', e2); }
  }
  return byName;
}

/** Fields shown in the team's daily view, after display toggles. */
function effectiveScheduleFields_(team) {
  var d = team.settings.display;
  var fields = team.settings.scheduleFields;
  if (d.layout !== 'CUSTOM') {
    var type = getTeamType_(team.teamTypeId);
    if (type) fields = type.scheduleFields;
  }
  fields = fields.filter(function (f) {
    if (!DISPLAY_FIELDS[f]) return d.showTeamFields;
    var g = DISPLAY_FIELDS[f].group;
    if (g === 'durations') return d.showDurations;
    return true;
  });
  if (d.showTeamFields) {
    team.settings.extraFields.forEach(function (x) { fields.push(EXTRA_FIELD_PREFIX + x); });
  }
  return uniq_(fields);
}

/* ------------------------------------------------------------------------ */
/* onEdit index (sheetId -> team) kept in DocumentProperties                */
/* ------------------------------------------------------------------------ */

var SHEET_INDEX_PROP_ = 'SM_SHEET_INDEX';

function rebuildSheetIndex_() {
  var idx = {};
  if (getSheet_(T_TEAMS.sheet)) {
    listTeams_().forEach(function (t) {
      if (t.status !== TEAM_STATUS.READY) return;
      var s = resolveTeamSheet_(t, 'schedule'), f = resolveTeamSheet_(t, 'staff');
      if (s) idx[String(s.getSheetId())] = { teamId: t.teamId, kind: 'schedule' };
      if (f) idx[String(f.getSheetId())] = { teamId: t.teamId, kind: 'staff' };
    });
  }
  PropertiesService.getDocumentProperties().setProperty(SHEET_INDEX_PROP_, JSON.stringify(idx));
  return idx;
}

function getSheetIndex_() {
  var raw = PropertiesService.getDocumentProperties().getProperty(SHEET_INDEX_PROP_);
  var idx = parseJson_(raw, null);
  return idx || rebuildSheetIndex_();
}

/** Returns {team, kind} for a sheet, or null if it is not a team sheet. */
function teamForSheet_(sheet) {
  var entry = getSheetIndex_()[String(sheet.getSheetId())];
  if (!entry) return null;
  var team = getTeam_(entry.teamId);
  return team ? { team: team, kind: entry.kind } : null;
}

/* ------------------------------------------------------------------------ */
/* Validation of the team form                                               */
/* ------------------------------------------------------------------------ */

/**
 * Validates and normalizes the team dialog form.
 * @param {Object} form see TeamDialog.html
 * @param {Object|null} existing team being edited, or null for creation
 * @return {{report, value, plan}}
 */
function validateTeamForm_(form, existing) {
  var rep = newReport_();
  var cfg = getConfig_();
  form = form || {};
  var name = str_(form.teamName).replace(/\s+/g, ' ');
  if (!name) rep.fatal.push('Team name is required.');
  if (name.length > 60) rep.fatal.push('Team name must be 60 characters or fewer.');
  if (name.charAt(0) === '_') rep.fatal.push('Team names cannot start with "_" (reserved for system sheets).');
  if (name && !sanitizeSheetName_(name)) rep.fatal.push('Team name contains no characters usable in a sheet name.');
  if (name && sanitizeSheetName_(name) !== name) {
    rep.warnings.push('Characters such as [ ] * ? / \\ : are not allowed in sheet names and will be replaced with "-" in the sheet names.');
  }

  var teams = listTeams_();
  teams.forEach(function (t) {
    if (existing && t.teamId === existing.teamId) return;
    if (normKey_(t.teamName) === normKey_(name)) rep.fatal.push('A team named "' + t.teamName + '" already exists (' + t.teamId + '). Choose a different name.');
  });

  // Team type
  var typeMode = form.typeMode === 'NEW' ? 'NEW' : 'EXISTING';
  var type = null;
  if (typeMode === 'NEW') {
    var tn = str_(form.newTypeName);
    if (!tn) rep.fatal.push('Enter a name for the new team type.');
    listTeamTypes_(true).forEach(function (t) {
      if (normKey_(t.typeName) === normKey_(tn)) rep.fatal.push('A team type named "' + t.typeName + '" already exists. Select it instead.');
    });
  } else {
    var typeId = str_(form.teamTypeId) || (existing ? existing.teamTypeId : '');
    type = (typeId && getTeamType_(typeId)) || defaultTeamType_();
    if (!type) rep.fatal.push('There is no team type yet. Run Setup / Configure Spreadsheet first.');
    else if (typeId && type.typeId !== typeId) rep.warnings.push('Team type "' + typeId + '" no longer exists; the team will use "' + type.typeName + '".');
    else if (!type.enabled && !(existing && existing.teamTypeId === type.typeId)) rep.fatal.push('Team type "' + type.typeName + '" is disabled.');
  }

  // Display / schedule. Settings not present in the form keep their current values.
  var baseDisplay = existing ? existing.settings.display : (type ? type.display : {});
  var display = mergeDisplay_(mergeObjects_(baseDisplay, form.display));
  validateDisplay_(display, rep);
  if (display.granularity !== 'DAILY') rep.fatal.push('Only the daily schedule view is available in this version.');
  var scheduleFields = normalizeScheduleFields_(form.scheduleFields && form.scheduleFields.length ? form.scheduleFields
    : (existing ? existing.settings.scheduleFields : (type ? type.scheduleFields : DEFAULT_SCHEDULE_FIELDS)));
  var extraFields = form.extraFields === undefined && existing ? existing.settings.extraFields
    : uniq_(splitList_(form.extraFields).map(function (x) { return x.substr(0, 80); }));

  // Staff
  var registry = getStaffFieldMap_();
  var staffList = (form.staffFields || []).slice();
  splitList_(form.customStaffFields).forEach(function (c) { staffList.push(CUSTOM_FIELD_PREFIX + c); });
  var staffFields = normalizeStaffFields_(staffList.length ? staffList
    : (existing ? existing.settings.staffFields : (type ? type.staffFields : DEFAULT_STAFF_FIELDS)));
  validateRegistryRefs_(staffFields, rep);
  if (existing) {
    var removed = existing.settings.staffFields.filter(function (f) { return staffFields.indexOf(f) < 0; });
    if (removed.length) rep.warnings.push('Removed staff fields (' + removed.map(function (f) { return staffFieldLabel_(f, registry); }).join(', ') + ') are hidden in the staff sheet; their values are kept.');
  }

  // Import settings (team.settings.import)
  var baseImport = existing ? existing.settings.import : DEFAULT_TEAM_IMPORT;
  var imp = normalizeTeamImport_(mergeObjects_(baseImport, form.import));
  if (existing) imp.knownShiftTypes = uniq_(existing.settings.import.knownShiftTypes.concat(imp.knownShiftTypes));
  if (imp.shiftTypeMode === 'SELECTED' && !imp.shiftTypes.length && !(imp.importMeetings && imp.meetingTypes.length)) rep.fatal.push('Select at least one shift type, or choose "Import all shift types".');
  if (imp.importMeetings && !imp.meetingTypes.length) rep.fatal.push('Meeting import is enabled: select which shift/activity types are meetings.');
  var both = imp.meetingTypes.filter(function (t) { return imp.shiftTypes.indexOf(t) >= 0; });
  if (both.length) rep.info.push('"' + both.join('", "') + '" is selected as a shift type and as a meeting type; it is treated as a meeting.');
  if (!imp.importMeetings && imp.meetingTypes.length) rep.info.push('Meeting types are configured but meeting import is disabled: those rows will be excluded and reported.');

  if (imp.shiftTypeMode === 'NOT_CONFIGURED') rep.info.push('No shift-type selection yet. An import that contains shift types will ask you to choose before anything is written.');
  if (imp.matchField !== 'employeeId') {
    var mk = imp.matchField.substr(STAFF_REGISTRY_PREFIX.length);
    var mf = registry[mk];
    if (!mf || mf.fieldType !== 'IDENTIFIER' || !mf.matchable) rep.fatal.push('The employee match key must be Employee ID or an external identifier field marked "usable as match key".');
    else if (staffFields.indexOf(imp.matchField) < 0) rep.fatal.push('The match key "' + mf.displayName + '" must also be selected as a staff field.');
    else rep.info.push('Imports will match the export\'s Employee ID column against "' + mf.displayName + '" instead of Employee ID.');
  }
  // The team dialog no longer chooses a profile: keep the current one, or the type's default for a new team.
  var profileId = str_(form.importProfileId);
  if (form.importProfileId === undefined) profileId = existing ? existing.importProfileId : (type ? type.defaultImportProfileId : '');
  var profile = profileId ? getProfile_(profileId) : null;
  if (profileId && !profile) profileId = '';
  var profileLayout = null;
  if (form.profileLayout && profile && profile.options.format === 'QUINYX_DAILY') {
    var hr = toNumber_(form.profileLayout.headerRow, NaN), fr = toNumber_(form.profileLayout.firstDataRow, NaN);
    if (!(hr >= 0 && hr <= 50) || !(fr >= 1 && fr <= 60) || (hr && fr <= hr)) rep.fatal.push('Header row must be 0–50 and the first data row must come after it.');
    else if (hr !== profile.options.dailyLayout.headerRow || fr !== profile.options.dailyLayout.firstDataRow) {
      profileLayout = { headerRow: hr, firstDataRow: fr };
      rep.warnings.push('The header/first data row are saved in profile "' + profile.profileName + '" and apply to every team that uses it.');
    }
  }
  var aliases = uniq_(splitList_(form.importAliases === undefined && existing ? existing.importAliases : form.importAliases));
  aliases.forEach(function (a) {
    teams.forEach(function (t) {
      if (existing && t.teamId === existing.teamId) return;
      var other = [t.teamName].concat(splitList_(t.importAliases)).map(normKey_);
      if (other.indexOf(normKey_(a)) >= 0) rep.fatal.push('Import alias "' + a + '" already identifies team "' + t.teamName + '". Aliases must be unique.');
    });
  });

  // Planned sheet names
  var taken = getSs_().getSheets().map(function (s) { return s.getName().toLowerCase(); });
  var plan = { scheduleSheet: '', staffSheet: '', renames: [] };
  if (name) {
    var genSched = applySheetPattern_(cfg.SCHEDULE_SHEET_PATTERN, name);
    var genStaff = applySheetPattern_(cfg.STAFF_SHEET_PATTERN, name);
    if (existing) {
      var oldSched = applySheetPattern_(cfg.SCHEDULE_SHEET_PATTERN, existing.teamName);
      var oldStaff = applySheetPattern_(cfg.STAFF_SHEET_PATTERN, existing.teamName);
      var mine = [existing.scheduleSheet.toLowerCase(), existing.staffSheet.toLowerCase()];
      taken = taken.filter(function (n) { return mine.indexOf(n) < 0; });
      plan.scheduleSheet = existing.scheduleSheet === oldSched && name !== existing.teamName
        ? uniqueSheetName_(genSched, taken) : existing.scheduleSheet;
      taken.push(plan.scheduleSheet.toLowerCase());
      plan.staffSheet = existing.staffSheet === oldStaff && name !== existing.teamName
        ? uniqueSheetName_(genStaff, taken) : existing.staffSheet;
      if (plan.scheduleSheet !== existing.scheduleSheet) plan.renames.push(existing.scheduleSheet + ' → ' + plan.scheduleSheet);
      if (plan.staffSheet !== existing.staffSheet) plan.renames.push(existing.staffSheet + ' → ' + plan.staffSheet);
    } else {
      plan.scheduleSheet = uniqueSheetName_(genSched, taken);
      taken.push(plan.scheduleSheet.toLowerCase());
      plan.staffSheet = uniqueSheetName_(genStaff, taken);
      if (plan.scheduleSheet !== genSched) rep.warnings.push('A sheet named "' + genSched + '" already exists; the schedule sheet will be named "' + plan.scheduleSheet + '".');
      if (plan.staffSheet !== genStaff) rep.warnings.push('A sheet named "' + genStaff + '" already exists; the staff sheet will be named "' + plan.staffSheet + '".');
    }
    if (plan.scheduleSheet.charAt(0) === '_' || plan.staffSheet.charAt(0) === '_') rep.fatal.push('Generated sheet names may not start with "_".');
  }

  return {
    report: rep,
    plan: plan,
    value: {
      teamName: name,
      description: form.description === undefined && existing ? existing.description : str_(form.description).substr(0, 500),
      active: form.active === undefined ? (existing ? existing.active : true) : !!form.active,
      typeMode: typeMode,
      teamTypeId: type ? type.typeId : '',
      typeName: type ? type.typeName : str_(form.newTypeName),
      newTypeName: str_(form.newTypeName),
      newTypeDescription: str_(form.newTypeDescription),
      display: display,
      scheduleFields: scheduleFields,
      extraFields: extraFields,
      staffFields: staffFields,
      import: imp,
      importProfileId: profileId,
      importAliases: aliases.join(', '),
      profileLayout: profileLayout
    }
  };
}

/** Shallow merge (b over a), ignoring undefined values. */
function mergeObjects_(a, b) {
  var out = {};
  [a, b].forEach(function (o) {
    if (!o || typeof o !== 'object') return;
    Object.keys(o).forEach(function (k) { if (o[k] !== undefined) out[k] = o[k]; });
  });
  return out;
}

/** Saves header/first-data-row changes made in the team dialog to the team's Daily Schedule profile. */
function applyProfileLayout_(profileId, layout) {
  if (!layout || !profileId) return;
  var p = getProfile_(profileId);
  if (!p) return;
  var options = JSON.parse(JSON.stringify(p.options));
  options.dailyLayout.headerRow = layout.headerRow;
  options.dailyLayout.firstDataRow = layout.firstDataRow;
  saveProfile_({ profileId: p.profileId, profileName: p.profileName, description: p.description, fieldMap: p.fieldMap, options: options }, null);
}

/* ------------------------------------------------------------------------ */
/* Create / update / delete                                                  */
/* ------------------------------------------------------------------------ */

function nextTeamId_() {
  var existing = listTeams_().map(function (t) { return t.teamId; });
  var id;
  do {
    id = 'TEAM_' + ('00' + nextSequence_('TEAM_ID_SEQ')).slice(-3);
  } while (existing.indexOf(id) >= 0);
  return id;
}

/**
 * Creates a team and its worksheets. Internal; caller holds the lock.
 * On failure the team stays registered with status ERROR (never READY) so that
 * Rebuild Missing Sheets can complete it.
 */
function createTeam_(form) {
  var v = validateTeamForm_(form, null);
  if (v.report.fatal.length) fail_('VALIDATION', v.report.fatal.join(' '), v.report);
  var val = v.value;

  var typeId = val.teamTypeId;
  if (val.typeMode === 'NEW') {
    typeId = saveTeamType_({
      typeName: val.newTypeName,
      description: val.newTypeDescription,
      scheduleFields: val.scheduleFields,
      staffFields: val.staffFields,
      defaultImportProfileId: val.importProfileId,
      display: val.display,
      enabled: true
    }).typeId;
  }

  var now = new Date();
  var team = {
    teamId: nextTeamId_(),
    teamName: val.teamName,
    teamTypeId: typeId,
    active: val.active,
    status: TEAM_STATUS.PENDING,
    scheduleSheet: v.plan.scheduleSheet,
    staffSheet: v.plan.staffSheet,
    defaultView: 'DAILY',
    importProfileId: val.importProfileId,
    importAliases: val.importAliases,
    description: val.description,
    settings: {
      display: val.display,
      scheduleFields: val.scheduleFields,
      staffFields: val.staffFields,
      extraFields: val.extraFields,
      import: val.import,
      scheduleSheetId: null,
      staffSheetId: null,
      lastError: ''
    },
    createdAt: now,
    updatedAt: now
  };
  applyProfileLayout_(val.importProfileId, val.profileLayout);
  appendObjects_(T_TEAMS, [team]);
  team = getTeam_(team.teamId); // re-read to obtain _row

  try {
    var built = buildTeamSheets_(team);
    team.settings.lastError = '';
    team.status = TEAM_STATUS.READY;
    saveTeamRow_(team);
    var warnings = v.report.warnings.slice();
    rebuildSheetIndex_();
    renderTeamView_(team, { date: todayIso_(getConfig_().TIMEZONE) });
    rebuildDashboardSafe_();
    return { team: team, warnings: warnings, created: built };
  } catch (e) {
    logError_('createTeam_', e);
    var msg = toUserError_(e).message;
    try {
      team.status = TEAM_STATUS.ERROR;
      team.settings.lastError = msg.substr(0, 300);
      saveTeamRow_(team);
      rebuildSheetIndex_();
    } catch (e2) { logError_('createTeam_.markError', e2); }
    fail_('TEAM_CREATE_FAILED', 'Team "' + team.teamName + '" (' + team.teamId + ') was registered but its worksheets could not be completed: ' + msg +
      ' The team is marked ERROR and will not receive imports. Fix the cause and run Manage Existing Teams → Rebuild sheets (or Maintenance → Rebuild Missing Sheets).');
  }
}

/** Creates any missing team sheets and applies their layout. Returns created names. */
function buildTeamSheets_(team) {
  var ss = getSs_();
  var created = [];
  var staffSh = resolveTeamSheet_(team, 'staff');
  if (!staffSh) {
    staffSh = ss.insertSheet(uniqueSheetName_(team.staffSheet, ss.getSheets().map(function (s) { return s.getName().toLowerCase(); })));
    created.push(staffSh.getName());
  }
  team.staffSheet = staffSh.getName();
  team.settings.staffSheetId = staffSh.getSheetId();

  var schedSh = resolveTeamSheet_(team, 'schedule');
  if (!schedSh) {
    schedSh = ss.insertSheet(uniqueSheetName_(team.scheduleSheet, ss.getSheets().map(function (s) { return s.getName().toLowerCase(); })));
    created.push(schedSh.getName());
  }
  team.scheduleSheet = schedSh.getName();
  team.settings.scheduleSheetId = schedSh.getSheetId();
  saveTeamRow_(team);

  layoutStaffSheet_(staffSh, team);
  layoutScheduleSheet_(schedSh, team);
  return created;
}

/** Recreates missing sheets for one team and marks it READY. Returns messages. */
function rebuildTeamSheets_(team) {
  var msgs = [];
  var hadSched = !!resolveTeamSheet_(team, 'schedule'), hadStaff = !!resolveTeamSheet_(team, 'staff');
  if (hadSched && hadStaff && team.status === TEAM_STATUS.READY) return msgs;
  var created = buildTeamSheets_(team);
  created.forEach(function (n) { msgs.push('Created sheet "' + n + '" for team "' + team.teamName + '".'); });
  if (team.status !== TEAM_STATUS.READY) {
    team.status = TEAM_STATUS.READY;
    team.settings.lastError = '';
    saveTeamRow_(team);
    msgs.push('Team "' + team.teamName + '" is now READY.');
  }
  renderTeamView_(team, {});
  return msgs;
}

function updateTeam_(teamId, form) {
  var team = requireTeam_(teamId);
  var v = validateTeamForm_(form, team);
  if (v.report.fatal.length) fail_('VALIDATION', v.report.fatal.join(' '), v.report);
  var val = v.value;
  var typeId = val.teamTypeId;
  if (val.typeMode === 'NEW') {
    typeId = saveTeamType_({
      typeName: val.newTypeName, description: val.newTypeDescription,
      scheduleFields: val.scheduleFields, staffFields: val.staffFields,
      defaultImportProfileId: val.importProfileId, display: val.display, enabled: true
    }).typeId;
  }
  var schedSh = resolveTeamSheet_(team, 'schedule');
  var staffSh = resolveTeamSheet_(team, 'staff');
  var warnings = v.report.warnings.slice();
  if (schedSh && v.plan.scheduleSheet !== schedSh.getName()) schedSh.setName(v.plan.scheduleSheet);
  if (staffSh && v.plan.staffSheet !== staffSh.getName()) staffSh.setName(v.plan.staffSheet);

  team.teamName = val.teamName;
  team.description = val.description;
  team.active = val.active;
  team.teamTypeId = typeId;
  team.scheduleSheet = schedSh ? schedSh.getName() : v.plan.scheduleSheet;
  team.staffSheet = staffSh ? staffSh.getName() : v.plan.staffSheet;
  team.importProfileId = val.importProfileId;
  team.importAliases = val.importAliases;
  team.settings.display = val.display;
  team.settings.scheduleFields = val.scheduleFields;
  team.settings.staffFields = val.staffFields;
  team.settings.extraFields = val.extraFields;
  team.settings.import = val.import;
  applyProfileLayout_(val.importProfileId, val.profileLayout);
  saveTeamRow_(team);

  if (team.status === TEAM_STATUS.READY) {
    if (staffSh) layoutStaffSheet_(staffSh, team);
    if (schedSh) { layoutScheduleSheet_(schedSh, team); renderTeamView_(team, {}); }
  }
  rebuildSheetIndex_();
  rebuildDashboardSafe_();
  return { team: team, warnings: warnings, renames: v.plan.renames };
}

/**
 * Removes a team from the registry. Schedule records are retained in
 * _SCHEDULE_DATA (history is never deleted implicitly); sheets are deleted only
 * when explicitly requested.
 */
function deleteTeam_(teamId, confirmName, deleteSheets) {
  var team = requireTeam_(teamId);
  if (str_(confirmName) !== team.teamName) {
    fail_('CONFIRMATION', 'Type the exact team name ("' + team.teamName + '") to confirm deletion.');
  }
  var deleted = [];
  if (deleteSheets) {
    ['schedule', 'staff'].forEach(function (k) {
      var sh = resolveTeamSheet_(team, k);
      if (sh && getSs_().getSheets().length > 1) { deleted.push(sh.getName()); getSs_().deleteSheet(sh); }
    });
  }
  deleteSheetRows_(requireSheet_(T_TEAMS.sheet), [team._row]);
  rebuildSheetIndex_();
  rebuildDashboardSafe_();
  return {
    deletedTeam: team.teamName,
    deletedSheets: deleted,
    note: 'Schedule records of this team were kept in _SCHEDULE_DATA for history (Team ID ' + team.teamId + ').'
  };
}

function teamSummaryForClient_(team, typeNames) {
  return {
    teamId: team.teamId,
    teamName: team.teamName,
    teamTypeId: team.teamTypeId,
    typeName: typeNames[team.teamTypeId] || team.teamTypeId,
    active: team.active,
    status: team.status,
    scheduleSheet: team.scheduleSheet,
    staffSheet: team.staffSheet,
    hasScheduleSheet: !!resolveTeamSheet_(team, 'schedule'),
    hasStaffSheet: !!resolveTeamSheet_(team, 'staff'),
    importProfileId: team.importProfileId,
    importAliases: team.importAliases,
    description: team.description,
    lastError: team.settings.lastError,
    hoursLabel: operatingWindow_(team.settings.display).label,
    meetings: team.settings.import.importMeetings ? 'meetings: ' + (team.settings.import.meetingTypes.join(', ') || '—') : 'meetings off',
    shiftTypes: team.settings.import.shiftTypeMode === 'SELECTED' ? team.settings.import.shiftTypes.join(', ')
      : (team.settings.import.shiftTypeMode === 'ALL' ? 'all' : 'not configured')
  };
}

function typeNameMap_() {
  var m = {};
  listTeamTypes_(true).forEach(function (t) { m[t.typeId] = t.typeName; });
  return m;
}

/* ------------------------------------------------------------------------ */
/* Client API                                                                */
/* ------------------------------------------------------------------------ */

function apiTeamDialogBootstrap(teamId) {
  return apiCall_('apiTeamDialogBootstrap', function () {
    requireInitialized_();
    var team = teamId ? requireTeam_(teamId) : null;
    var type = defaultTeamType_();
    var known = getKnownShiftTypes_();
    if (team) known = uniq_(known.concat(team.settings.import.knownShiftTypes));
    return {
      team: team,
      importProfileId: team ? team.importProfileId : (type ? type.defaultImportProfileId : ''),
      staffFieldDefs: STAFF_FIELD_DEFS,
      staffRegistry: listStaffFields_(),
      operatingModes: OPERATING_HOURS_MODES,
      shiftTypeModes: SHIFT_TYPE_MODES,
      knownShiftTypes: known.sort(),
      defaults: { staffFields: type ? type.staffFields : DEFAULT_STAFF_FIELDS, display: type ? type.display : DEFAULT_DISPLAY, import: DEFAULT_TEAM_IMPORT }
    };
  });
}

function apiPreviewTeam(form, teamId) {
  return apiCall_('apiPreviewTeam', function () {
    requireInitialized_();
    var existing = teamId ? requireTeam_(teamId) : null;
    var v = validateTeamForm_(form, existing);
    var registry = getStaffFieldMap_();
    return {
      report: v.report,
      plan: v.plan,
      value: v.value,
      hoursLabel: OPERATING_HOURS_MODES[v.value.display.operatingHoursMode] + ' · ' + operatingWindow_(v.value.display).label,
      staffLabels: v.value.staffFields.map(function (f) { return staffFieldLabel_(f, registry); })
    };
  });
}

function apiCreateTeam(form) {
  return apiCall_('apiCreateTeam', function () {
    requireInitialized_();
    return withLock_(function () {
      var r = createTeam_(form);
      var sh = resolveTeamSheet_(r.team, 'schedule');
      if (sh) sh.activate();
      return { teamId: r.team.teamId, teamName: r.team.teamName, scheduleSheet: r.team.scheduleSheet, staffSheet: r.team.staffSheet, warnings: r.warnings };
    }, 60000);
  });
}

function apiUpdateTeam(teamId, form) {
  return apiCall_('apiUpdateTeam', function () {
    requireInitialized_();
    return withLock_(function () {
      var r = updateTeam_(teamId, form);
      return { teamId: r.team.teamId, teamName: r.team.teamName, scheduleSheet: r.team.scheduleSheet, staffSheet: r.team.staffSheet, warnings: r.warnings, renames: r.renames };
    }, 60000);
  });
}

function apiListTeams() {
  return apiCall_('apiListTeams', function () {
    requireInitialized_();
    var names = typeNameMap_();
    return listTeams_().map(function (t) { return teamSummaryForClient_(t, names); });
  });
}

function apiSetTeamActive(teamId, active) {
  return apiCall_('apiSetTeamActive', function () {
    requireInitialized_();
    return withLock_(function () {
      var t = requireTeam_(teamId);
      t.active = !!active;
      saveTeamRow_(t);
      rebuildDashboardSafe_();
      return { teamId: teamId, active: t.active };
    });
  });
}

function apiRebuildTeam(teamId) {
  return apiCall_('apiRebuildTeam', function () {
    requireInitialized_();
    return withLock_(function () {
      var t = requireTeam_(teamId);
      var msgs = rebuildTeamSheets_(t);
      var s = resolveTeamSheet_(t, 'staff'), d = resolveTeamSheet_(t, 'schedule');
      if (s) layoutStaffSheet_(s, t);
      if (d) { layoutScheduleSheet_(d, t); renderTeamView_(t, {}); }
      rebuildSheetIndex_();
      rebuildDashboardSafe_();
      if (!msgs.length) msgs.push('Sheets were present; layout and formatting were reapplied.');
      return { messages: msgs };
    }, 60000);
  });
}

function apiDeleteTeam(teamId, confirmName, deleteSheets) {
  return apiCall_('apiDeleteTeam', function () {
    requireInitialized_();
    return withLock_(function () { return deleteTeam_(teamId, confirmName, !!deleteSheets); });
  });
}

function apiOpenTeamSheet(teamId, kind) {
  return apiCall_('apiOpenTeamSheet', function () {
    var t = requireTeam_(teamId);
    var sh = resolveTeamSheet_(t, kind === 'staff' ? 'staff' : 'schedule');
    if (!sh) fail_('MISSING_SHEET', 'The ' + kind + ' sheet of "' + t.teamName + '" is missing. Use Rebuild sheets.');
    sh.activate();
    return { sheet: sh.getName() };
  });
}

function apiShowTeamDialog(teamId) {
  return apiCall_('apiShowTeamDialog', function () {
    showTeamDialog_(teamId || null);
    return true;
  });
}
