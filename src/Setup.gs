/**
 * Setup.gs
 * Idempotent initialization and repair of the system infrastructure.
 * Running setup any number of times never duplicates sheets, never erases data
 * and never overwrites existing configuration values.
 *
 * Dependencies: Schema.gs, Utils.gs, SheetStore.gs, ConfigService.gs,
 *               TeamTypeService.gs, ImportMappingService.gs, TeamService.gs,
 *               DashboardService.gs, StaffService.gs
 */

/** Inspects the spreadsheet without changing anything. */
function getSetupState_() {
  var ss = getSs_();
  var sheets = SYSTEM_TABLES.map(function (def) {
    var sh = ss.getSheetByName(def.sheet);
    var missing = [];
    if (sh) missing = headerIndex_(def, readHeader_(sh)).missing;
    return { name: def.sheet, purpose: def.purpose, exists: !!sh, missingColumns: sh ? missing : [] };
  });
  var initialized = false, version = '', teams = 0;
  try {
    if (ss.getSheetByName(T_CONFIG.sheet)) {
      var cfg = getConfig_();
      initialized = cfgBool_(cfg, 'INITIALIZED');
      version = cfg.SYSTEM_VERSION;
    }
    if (ss.getSheetByName(T_TEAMS.sheet) && sheets[1].missingColumns.length === 0) teams = listTeams_().length;
  } catch (e) {
    logError_('getSetupState_', e);
  }
  var healthy = sheets.every(function (s) { return s.exists && !s.missingColumns.length; });
  return {
    initialized: initialized,
    healthy: healthy,
    version: version,
    codeVersion: APP.VERSION,
    teamCount: teams,
    sheets: sheets,
    otherSheets: ss.getSheets().map(function (s) { return s.getName(); })
      .filter(function (n) { return n.charAt(0) !== '_'; })
  };
}

/**
 * Creates or repairs every system sheet, seeds defaults where tables are empty
 * and marks the system initialized. Safe to run repeatedly.
 * @return {{actions: string[], state: Object}}
 */
function initializeSystem_() {
  var actions = [];
  SYSTEM_TABLES.forEach(function (def) {
    var r = ensureSystemSheet_(def);
    if (r.created) actions.push('Created sheet ' + def.sheet + '.');
    if (r.addedColumns.length) actions.push('Added missing column(s) ' + r.addedColumns.join(', ') + ' to ' + def.sheet + ' (existing data untouched).');
  });

  var added = ensureConfigDefaults_();
  if (added.length) actions.push('Added ' + added.length + ' missing configuration key(s).');

  var cfg = getConfig_();
  var fromVersion = cfg.SYSTEM_VERSION;
  var updates = {};
  var rawTz = readRawConfigValue_('TIMEZONE');
  if (!rawTz) updates.TIMEZONE = getTz_();
  if (!cfgBool_(cfg, 'INITIALIZED')) {
    updates.INITIALIZED = 'TRUE';
    updates.INITIALIZED_AT = Utilities.formatDate(new Date(), getTz_(), 'yyyy-MM-dd HH:mm:ss');
    actions.push('Marked the system as initialized.');
  }
  if (Object.keys(updates).length) setConfigValues_(updates);

  // Seed data and v1.1 migration. Every step only adds what is missing.
  seedStaffFieldsIfEmpty_(); // v1.1.1: creates nothing (identifier fields are added by administrators)
  if (seedDailyProfileIfMissing_()) actions.push('Created the "Quinyx Daily Schedule" import profile (default layout, not yet verified against a real export).');
  if (seedDefaultsIfEmpty_()) actions.push('Created the starter team type and the generic import profile.');
  migrateTeamTypesV11_().forEach(function (m) { actions.push(m); });
  var ordered = migrateStaffFieldOrder_();
  if (ordered) actions.push('Set the display order of ' + ordered + ' existing staff field(s) (their current order is kept).');
  migrateTeamsV11_().forEach(function (m) { actions.push(m); });

  // Record the version last, so an interrupted upgrade is simply run again.
  if (getConfig_().SYSTEM_VERSION !== APP.VERSION) {
    setConfigValues_({ SYSTEM_VERSION: APP.VERSION });
    actions.push('Upgraded the system from version ' + (fromVersion || '1.0.0') + ' to ' + APP.VERSION + '.');
  }

  formatSystemSheets_();
  rebuildSheetIndex_();
  var dash = rebuildDashboardSafe_();
  if (dash) actions.push(dash);
  if (!actions.length) actions.push('Everything was already in place. Nothing was changed.');
  return { actions: actions, state: getSetupState_() };
}

/**
 * v1.1 migration for teams: adds explicit operating hours (taken from the old
 * display hours, so nothing changes visually) and default import settings to
 * teams that do not have them yet. Existing values are never overwritten.
 */
function migrateTeamsV11_() {
  var msgs = [];
  readTable_(T_TEAMS).rows.forEach(function (r) {
    if (!str_(r.teamId)) return;
    var s = r.settings && typeof r.settings === 'object' ? JSON.parse(JSON.stringify(r.settings)) : {};
    var parts = [];
    if (!s.display || !s.display.operatingHoursMode) {
      s.display = mergeDisplay_(s.display || {});
      parts.push('operating hours ' + operatingWindow_(s.display).label);
    }
    if (!s.import || typeof s.import !== 'object') {
      var imp = normalizeTeamImport_({});
      imp.scheduleType = 'TABLE';   // v1.0 teams were set up for generic table imports
      s.import = imp;
      parts.push('default import settings');
    } else if (s.import.importMeetings === undefined || s.import.useStaffDirectoryRouting === undefined) {
      // v1.1.1: explicit meeting/routing settings, both off, so imports behave exactly as before.
      s.import = normalizeTeamImport_(s.import);
      parts.push('meeting import off, staff-directory routing off');
    }
    if (!parts.length) return;
    var copy = {};
    Object.keys(r).forEach(function (k) { copy[k] = r[k]; });
    copy.settings = s;
    saveTeamRow_(rowToTeam_(copy));
    msgs.push('Upgraded team "' + str_(r.teamName) + '": ' + parts.join(', ') + '.');
  });
  return msgs;
}

/**
 * v1.1 migration for team types: explicit operating hours, and the new default
 * staff columns for types that still have exactly the untouched v1.0 default.
 */
function migrateTeamTypesV11_() {
  var msgs = [];
  readTable_(T_TEAM_TYPES).rows.forEach(function (r) {
    if (!str_(r.typeId)) return;
    var changed = [];
    var obj = rowToTeamType_(r);
    if (!r.display || !r.display.operatingHoursMode) changed.push('operating hours');
    if (Array.isArray(r.staffFields) && (stableStringify_(r.staffFields) === stableStringify_(LEGACY_DEFAULT_STAFF_FIELDS_V1) ||
        stableStringify_(r.staffFields) === stableStringify_(LEGACY_DEFAULT_STAFF_FIELDS_V110))) {
      obj.staffFields = DEFAULT_STAFF_FIELDS.slice();
      changed.push('new default staff columns for future teams');
    }
    if (!changed.length) return;
    obj.updatedAt = new Date();
    updateObject_(T_TEAM_TYPES, obj);
    msgs.push('Upgraded team type "' + obj.typeName + '": ' + changed.join(', ') + '.');
  });
  return msgs;
}

/**
 * v1.1.1: staff fields created before "Display Order" existed get an order that
 * follows their row order (10, 20, …). Fields that already have an order are untouched.
 */
function migrateStaffFieldOrder_() {
  if (!getSheet_(T_STAFF_FIELDS.sheet)) return 0;
  var rows = readTable_(T_STAFF_FIELDS).rows.filter(function (r) { return str_(r.fieldKey); });
  var used = rows.map(function (r) { return toNumber_(r.displayOrder, NaN); }).filter(isFinite);
  var next = used.length ? Math.max.apply(null, used) : 0;
  var count = 0;
  rows.forEach(function (r) {
    if (str_(r.displayOrder) !== '') return;
    next += 10;
    updateObject_(T_STAFF_FIELDS, { _row: r._row, displayOrder: next });
    count++;
  });
  return count;
}

/** Reads a config value directly (bypassing defaults) to know if it was ever set. */
function readRawConfigValue_(key) {
  var t = readTable_(T_CONFIG);
  for (var i = 0; i < t.rows.length; i++) if (str_(t.rows[i].key) === key) return str_(t.rows[i].value);
  return '';
}

/**
 * Ensures a system sheet exists with all required header columns.
 * Missing columns are appended at the end; existing columns are never moved or removed.
 */
function ensureSystemSheet_(def) {
  var ss = getSs_();
  var sh = ss.getSheetByName(def.sheet);
  var created = false, addedColumns = [];
  if (!sh) {
    sh = ss.insertSheet(def.sheet, ss.getNumSheets());
    created = true;
  }
  var header = readHeader_(sh);
  if (!header.length || header.every(isBlank_)) {
    var labels = def.columns.map(function (c) { return c.label; });
    ensureColumns_(sh, labels.length);
    sh.getRange(1, 1, 1, labels.length).setValues([labels]);
    if (!created) addedColumns = labels;
  } else {
    var missing = headerIndex_(def, header).missing;
    if (missing.length) {
      var start = header.length + 1;
      ensureColumns_(sh, header.length + missing.length);
      sh.getRange(1, start, 1, missing.length).setValues([missing]);
      addedColumns = missing;
    }
  }
  return { sheet: sh, created: created, addedColumns: addedColumns };
}

function ensureColumns_(sh, needed) {
  var max = sh.getMaxColumns();
  if (max < needed) sh.insertColumnsAfter(max, needed - max);
}

/** Seeds one starter team type and one generic mapping profile if the tables are empty. */
function seedDefaultsIfEmpty_() {
  var seeded = false;
  if (!readTable_(T_MAPPINGS).rows.length) {
    saveProfile_({
      profileName: 'Generic (auto-detect columns)',
      description: 'Starter profile with no fixed columns: the import maps columns automatically from header names and lets you correct them. Save a dedicated profile once your Quinyx export format is known.',
      fieldMap: {},
      options: { dateOrder: 'AUTO', breakUnit: 'MINUTES', headerRow: 0, defaultTeamId: '', teamValueMap: {} }
    }, null);
    seeded = true;
  }
  if (!readTable_(T_TEAM_TYPES).rows.length) {
    var profiles = listProfiles_();
    var daily = findDailyProfile_(profiles);
    if (daily) profiles = [daily];
    saveTeamType_({
      typeName: 'Standard Team',
      description: 'Starter team type. Edit it or add your own under Configure Team Types.',
      scheduleFields: DEFAULT_SCHEDULE_FIELDS.slice(),
      staffFields: DEFAULT_STAFF_FIELDS.slice(),
      defaultImportProfileId: profiles.length ? profiles[0].profileId : '',
      display: JSON.parse(JSON.stringify(DEFAULT_DISPLAY)),
      enabled: true
    });
    seeded = true;
  }
  return seeded;
}

/** Applies consistent formatting to system sheets (non-destructive). */
function formatSystemSheets_() {
  var cfg = getConfig_();
  var hide = cfgBool_(cfg, 'HIDE_SYSTEM_SHEETS');
  SYSTEM_TABLES.forEach(function (def) {
    var sh = getSheet_(def.sheet);
    if (!sh) return;
    var header = readHeader_(sh);
    var width = Math.max(header.length, 1);
    sh.getRange(1, 1, 1, width)
      .setFontWeight('bold').setBackground('#5f6368').setFontColor('#ffffff').setWrap(false);
    sh.setFrozenRows(1);
    sh.setTabColor('#9aa0a6');
    if (sh.getMaxRows() > 1) applyColumnFormats_(sh, def, header, 2, sh.getMaxRows() - 1);
    sh.getRange(1, 1).setNote(def.purpose + '\nManaged by ' + APP.NAME + '. Edit only through the menu unless you know the schema.');
    var protections = sh.getProtections(SpreadsheetApp.ProtectionType.SHEET);
    if (!protections.length) {
      sh.protect().setDescription(APP.NAME + ' internal sheet (warning only — not a security boundary)').setWarningOnly(true);
    }
    if (hide && !sh.isSheetHidden()) sh.hideSheet();
    if (!hide && sh.isSheetHidden()) sh.showSheet();
  });
}

/** Repairs formatting everywhere: system sheets, team sheets, dashboard. */
function repairAllFormatting_() {
  var rep = newReport_();
  formatSystemSheets_();
  listTeams_().forEach(function (team) {
    if (team.status !== TEAM_STATUS.READY) {
      rep.warnings.push('Skipped "' + team.teamName + '" (status ' + team.status + '). Rebuild its sheets first.');
      return;
    }
    try {
      var staffSh = resolveTeamSheet_(team, 'staff');
      if (staffSh) layoutStaffSheet_(staffSh, team);
      var schedSh = resolveTeamSheet_(team, 'schedule');
      if (schedSh) {
        layoutScheduleSheet_(schedSh, team);
        renderTeamView_(team, {});
      }
      rep.info.push('Repaired "' + team.teamName + '".');
    } catch (e) {
      logError_('repairAllFormatting_', e);
      rep.warnings.push('Could not repair "' + team.teamName + '": ' + toUserError_(e).message);
    }
  });
  var d = rebuildDashboardSafe_();
  if (d) rep.info.push(d);
  return rep;
}

/** Recreates missing system sheets/columns and missing team sheets. */
function rebuildMissingSheets_() {
  var rep = newReport_();
  SYSTEM_TABLES.forEach(function (def) {
    var r = ensureSystemSheet_(def);
    if (r.created) rep.info.push('Recreated ' + def.sheet + '.');
    if (r.addedColumns.length && !r.created) rep.info.push('Restored columns in ' + def.sheet + ': ' + r.addedColumns.join(', '));
  });
  ensureConfigDefaults_();
  listTeams_().forEach(function (team) {
    try {
      var r = rebuildTeamSheets_(team);
      r.forEach(function (m) { rep.info.push(m); });
    } catch (e) {
      logError_('rebuildMissingSheets_', e);
      rep.warnings.push('Team "' + team.teamName + '": ' + toUserError_(e).message);
    }
  });
  rebuildSheetIndex_();
  var d = rebuildDashboardSafe_();
  if (d) rep.info.push(d);
  if (!rep.info.length && !rep.warnings.length) rep.info.push('No sheets were missing.');
  return rep;
}

/* ------------------------------------------------------------------------ */
/* Client API                                                                */
/* ------------------------------------------------------------------------ */

/** Connection test used by dialogs: proves google.script.run reaches the server. */
function apiPing() {
  return apiCall_('apiPing', function () { return { pong: true, user: currentUserEmail_() }; });
}

/**
 * Setup without any dialog. Select "setupNow" in the Apps Script editor and click Run;
 * the result is printed in the execution log. Same as the Setup dialog's Initialize/Upgrade button.
 */
function setupNow() {
  var r = withLock_(function () { return initializeSystem_(); }, 60000);
  r.actions.forEach(function (a) { console.log('• ' + a); });
  console.log('Initialized: ' + r.state.initialized + ', healthy: ' + r.state.healthy + ', version: ' + r.state.version);
  return r.actions;
}

function apiGetSetupState() {
  return apiCall_('apiGetSetupState', function () { return getSetupState_(); });
}

function apiInitializeSystem() {
  return apiCall_('apiInitializeSystem', function () {
    return withLock_(function () { return initializeSystem_(); }, 60000);
  });
}
