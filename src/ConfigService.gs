/**
 * ConfigService.gs
 * Global configuration stored in _CONFIG (key/value). Provides defaults,
 * typed accessors, validated updates and ID sequences.
 *
 * Dependencies: Schema.gs, Utils.gs, SheetStore.gs
 */

/**
 * [key, default value, description, group] — group drives the settings dialog.
 * Top-level values must not reference other files (load order is not guaranteed);
 * SYSTEM_VERSION is therefore written by initializeSystem_ from APP.VERSION.
 */
var CONFIG_DEFAULTS = [
  ['SYSTEM_VERSION', '', 'Schema version written by setup. Do not edit.', 'system'],
  ['INITIALIZED', 'FALSE', 'Set to TRUE by Setup / Configure Spreadsheet.', 'system'],
  ['INITIALIZED_AT', '', 'When the system was first initialized.', 'system'],
  ['TEAM_ID_SEQ', '0', 'Last issued team number (IDs are never reused).', 'system'],
  ['TEST_MODE', 'FALSE', 'Set TRUE only in a scratch copy to allow runIntegrationTests().', 'system'],
  ['KNOWN_SHIFT_TYPES', '[]', 'JSON list of shift types discovered in imported exports (maintained automatically).', 'system'],
  ['SLACK_PAYLOAD_CONFIG', '{}', 'JSON: Slack payload generation settings (edit via Slack Workflow Automation → Configure Payload Generation).', 'system'],
  ['DASHBOARD_URL_CONFIG', '{}', 'JSON: dashboard URL template settings (edit via Slack Workflow Automation → Configure Dashboard URL).', 'system'],

  ['TIMEZONE', '', 'Time zone used for "today" and timestamps. Blank = spreadsheet time zone.', 'display'],
  ['DATE_FORMAT', 'yyyy-mm-dd', 'Sheets number format for dates in team views.', 'display'],
  ['TIME_FORMAT', 'HH:mm', 'Sheets number format for times in team views (e.g. HH:mm or h:mm am/pm).', 'display'],
  ['SCHEDULE_SHEET_PATTERN', '{team} - Daily', 'Name pattern for new daily schedule sheets. Must contain {team}.', 'display'],
  ['STAFF_SHEET_PATTERN', '{team} - Staff', 'Name pattern for new staff sheets. Must contain {team}.', 'display'],
  ['DASHBOARD_SHEET', 'Dashboard', 'Name of the all-teams dashboard sheet.', 'display'],
  ['SHOW_CARRY_OVER', 'TRUE', 'Show overnight shifts from the previous day in the daily view.', 'display'],
  ['HIDE_SYSTEM_SHEETS', 'FALSE', 'Hide internal _ sheets (convenience only — hiding is NOT security).', 'display'],
  ['HEADER_COLOR', '#1f3b57', 'Header background color.', 'display'],
  ['HEADER_FONT_COLOR', '#ffffff', 'Header text color.', 'display'],
  ['BAND_COLOR', '#f3f6f9', 'Alternating row color.', 'display'],
  ['WARN_COLOR', '#fff4ce', 'Highlight for warnings.', 'display'],
  ['ERROR_COLOR', '#fde2e1', 'Highlight for problems (overlaps, unknown employees).', 'display'],

  ['DEFAULT_DUPLICATE_STRATEGY', 'ASK', 'ASK, SKIP, UPDATE or REPLACE_RANGE.', 'import'],
  ['DEFAULT_DATE_ORDER', 'AUTO', 'AUTO, DMY, MDY or YMD for numeric dates like 03/04/2026.', 'import'],
  ['NAME_MATCH_STRATEGY', 'EXACT_FLAGGED', 'NONE = match staff by Employee ID only; EXACT_FLAGGED = if a row has no ID, match a unique exact name and flag it.', 'import'],
  ['STRIP_LEADING_ZEROS', 'FALSE', 'Treat 00123 and 123 as the same Employee ID.', 'import'],
  ['MAX_SHIFT_HOURS', '16', 'Shifts longer than this produce a warning.', 'import'],
  ['MIN_SHIFT_MINUTES', '15', 'Shifts shorter than this produce a warning.', 'import'],
  ['HOURS_TOLERANCE_MINUTES', '15', 'Scheduled hours (e.g. column F) differing from both the net and the gross shift length by more than this are flagged "Hours differ".', 'import'],
  ['MAX_FILE_MB', '10', 'Maximum upload size in megabytes.', 'import'],
  ['STAGING_RETENTION_HOURS', '24', 'Unconfirmed import previews older than this are purged.', 'import'],
  ['AUTO_MAP_SYNONYMS', '{}', 'JSON {"internalField": ["Header text", ...]} added to built-in auto-mapping guesses.', 'import']
];

var CONFIG_ENUMS = {
  DEFAULT_DUPLICATE_STRATEGY: ['ASK', 'SKIP', 'UPDATE', 'REPLACE_RANGE'],
  DEFAULT_DATE_ORDER: ['AUTO', 'DMY', 'MDY', 'YMD'],
  NAME_MATCH_STRATEGY: ['NONE', 'EXACT_FLAGGED']
};
var CONFIG_BOOLEANS = ['INITIALIZED', 'TEST_MODE', 'SHOW_CARRY_OVER', 'HIDE_SYSTEM_SHEETS', 'STRIP_LEADING_ZEROS'];
var CONFIG_NUMBERS = { MAX_SHIFT_HOURS: [1, 48], MIN_SHIFT_MINUTES: [0, 600], MAX_FILE_MB: [1, 45], STAGING_RETENTION_HOURS: [1, 720], HOURS_TOLERANCE_MINUTES: [0, 240] };
var CONFIG_COLORS = ['HEADER_COLOR', 'HEADER_FONT_COLOR', 'BAND_COLOR', 'WARN_COLOR', 'ERROR_COLOR'];
var CONFIG_READONLY = ['SYSTEM_VERSION', 'INITIALIZED', 'INITIALIZED_AT', 'TEAM_ID_SEQ', 'KNOWN_SHIFT_TYPES',
  'SLACK_PAYLOAD_CONFIG', 'DASHBOARD_URL_CONFIG'];

/* Per-execution memo; invalidated on every write. Apps Script executions are short-lived. */
var configMemo_ = null;

function resetConfigMemo_() { configMemo_ = null; }

/** Returns the full configuration map (defaults overlaid with _CONFIG values). */
function getConfig_() {
  if (configMemo_) return configMemo_;
  var cfg = {};
  CONFIG_DEFAULTS.forEach(function (d) { cfg[d[0]] = d[1]; });
  var sh = getSheet_(T_CONFIG.sheet);
  if (sh && sh.getLastRow() > 1) {
    readTable_(T_CONFIG).rows.forEach(function (r) {
      var k = str_(r.key);
      if (k) cfg[k] = isDate_(r.value) ? r.value.toISOString() : str_(r.value);
    });
  }
  if (!cfg.TIMEZONE) cfg.TIMEZONE = getTz_();
  configMemo_ = cfg;
  return cfg;
}

function cfgBool_(cfg, key) { return toBool_(cfg[key]); }

function cfgNum_(cfg, key, fallback) { return toNumber_(cfg[key], fallback); }

function isInitialized_() {
  var sh = getSheet_(T_CONFIG.sheet);
  if (!sh) return false;
  return cfgBool_(getConfig_(), 'INITIALIZED');
}

function requireInitialized_() {
  if (!isInitialized_()) {
    fail_('NOT_INITIALIZED', 'The spreadsheet has not been initialized yet. Run Schedule Manager → Setup & Configuration → Setup / Configure Spreadsheet first.');
  }
  var stored = getConfig_().SYSTEM_VERSION;
  if (stored !== APP.VERSION) {
    fail_('NEEDS_UPGRADE', 'The code was updated to version ' + APP.VERSION + ' but this spreadsheet is still on version ' + (stored || '1.0.0') +
      '. Run Schedule Manager → Setup & Configuration → Setup / Configure Spreadsheet and click "Upgrade". The upgrade only adds missing columns and settings; no data is removed.');
  }
}

/** Shift types seen in imported exports (global discovery list). */
function getKnownShiftTypes_() {
  var v = parseJson_(getConfig_().KNOWN_SHIFT_TYPES, []);
  return Array.isArray(v) ? v.map(normShiftType_).filter(Boolean) : [];
}

/** Adds shift types to the global discovery list. Call under lock. */
function addKnownShiftTypes_(types) {
  var known = getKnownShiftTypes_();
  var added = (types || []).map(normShiftType_).filter(function (t) { return t && known.indexOf(t) < 0; });
  if (added.length) setConfigValues_({ KNOWN_SHIFT_TYPES: JSON.stringify(uniq_(known.concat(added)).sort()) });
  return added;
}

function describeConfig_(key) {
  for (var i = 0; i < CONFIG_DEFAULTS.length; i++) if (CONFIG_DEFAULTS[i][0] === key) return CONFIG_DEFAULTS[i][2];
  return '';
}

/** Writes {key: value} pairs (upsert). No validation — callers validate first. */
function setConfigValues_(updates) {
  var t = readTable_(T_CONFIG);
  var byKey = {};
  t.rows.forEach(function (r) { byKey[str_(r.key)] = r; });
  var appends = [];
  var now = new Date();
  Object.keys(updates).forEach(function (k) {
    var v = updates[k] === null || updates[k] === undefined ? '' : String(updates[k]);
    if (byKey[k]) {
      byKey[k].value = v;
      byKey[k].updatedAt = now;
      updateObject_(T_CONFIG, byKey[k]);
    } else {
      appends.push({ key: k, value: v, description: describeConfig_(k), updatedAt: now });
    }
  });
  appendObjects_(T_CONFIG, appends);
  resetConfigMemo_();
}

/** Adds missing default keys without touching existing values. Returns added keys. */
function ensureConfigDefaults_() {
  var t = readTable_(T_CONFIG);
  var have = {};
  t.rows.forEach(function (r) { have[str_(r.key)] = true; });
  var now = new Date();
  var add = CONFIG_DEFAULTS.filter(function (d) { return !have[d[0]]; }).map(function (d) {
    return { key: d[0], value: d[1], description: d[2], updatedAt: now };
  });
  appendObjects_(T_CONFIG, add);
  resetConfigMemo_();
  return add.map(function (a) { return a.key; });
}

/** Returns the next value of a numeric sequence stored in _CONFIG. Call under lock. */
function nextSequence_(key) {
  var n = cfgNum_(getConfig_(), key, 0) + 1;
  var u = {};
  u[key] = String(n);
  setConfigValues_(u);
  return n;
}

function isValidTimeZone_(tz) {
  try {
    Utilities.formatDate(new Date(), tz, 'Z');
    return /^[A-Za-z_]+(\/[A-Za-z0-9_\-+]+)*$/.test(tz) || /^(UTC|GMT)$/.test(tz);
  } catch (e) {
    return false;
  }
}

/**
 * Validates proposed settings. Returns a report; values are normalized in place.
 * @param {Object} updates key -> string value
 */
function validateConfigUpdates_(updates) {
  var rep = newReport_();
  Object.keys(updates).forEach(function (k) {
    var v = str_(updates[k]);
    updates[k] = v;
    if (CONFIG_READONLY.indexOf(k) >= 0) { rep.fatal.push(k + ' is managed by the system and cannot be edited here.'); return; }
    if (!CONFIG_DEFAULTS.some(function (d) { return d[0] === k; })) { rep.fatal.push('Unknown setting: ' + k); return; }
    if (CONFIG_ENUMS[k] && CONFIG_ENUMS[k].indexOf(v) < 0) rep.fatal.push(k + ' must be one of ' + CONFIG_ENUMS[k].join(', ') + '.');
    if (CONFIG_BOOLEANS.indexOf(k) >= 0) updates[k] = toBool_(v) ? 'TRUE' : 'FALSE';
    if (CONFIG_NUMBERS[k]) {
      var n = toNumber_(v, NaN), r = CONFIG_NUMBERS[k];
      if (!(n >= r[0] && n <= r[1])) rep.fatal.push(k + ' must be a number between ' + r[0] + ' and ' + r[1] + '.');
    }
    if (CONFIG_COLORS.indexOf(k) >= 0 && !/^#[0-9a-fA-F]{6}$/.test(v)) rep.fatal.push(k + ' must be a hex color such as #1f3b57.');
    if ((k === 'SCHEDULE_SHEET_PATTERN' || k === 'STAFF_SHEET_PATTERN')) {
      if (v.indexOf('{team}') < 0) rep.fatal.push(k + ' must contain {team}.');
      else if (sanitizeSheetName_(v) !== v) rep.fatal.push(k + ' contains characters that are not allowed in sheet names ([ ] * ? / \\ :).');
      else if (v.charAt(0) === '_') rep.fatal.push(k + ' must not start with "_" (reserved for system sheets).');
    }
    if (k === 'DASHBOARD_SHEET') {
      if (!v || sanitizeSheetName_(v) !== v || v.charAt(0) === '_') rep.fatal.push('DASHBOARD_SHEET must be a valid sheet name that does not start with "_".');
    }
    if (k === 'TIMEZONE' && v && !isValidTimeZone_(v)) rep.fatal.push('TIMEZONE "' + v + '" is not a valid IANA time zone (e.g. Europe/Stockholm).');
    if (k === 'AUTO_MAP_SYNONYMS') {
      var o = parseJson_(v || '{}', null);
      var known = IMPORT_FIELDS.map(function (f) { return f.key; });
      if (!o || typeof o !== 'object' || Array.isArray(o)) rep.fatal.push('AUTO_MAP_SYNONYMS must be a JSON object.');
      else Object.keys(o).forEach(function (f) {
        if (known.indexOf(f) < 0) rep.fatal.push('AUTO_MAP_SYNONYMS: unknown internal field "' + f + '".');
        else if (!Array.isArray(o[f])) rep.fatal.push('AUTO_MAP_SYNONYMS: "' + f + '" must be a list of header texts.');
      });
    }
    if ((k === 'DATE_FORMAT' || k === 'TIME_FORMAT') && !v) rep.fatal.push(k + ' cannot be empty.');
  });
  if (updates.SCHEDULE_SHEET_PATTERN && updates.STAFF_SHEET_PATTERN &&
      updates.SCHEDULE_SHEET_PATTERN.toLowerCase() === updates.STAFF_SHEET_PATTERN.toLowerCase()) {
    rep.fatal.push('The schedule and staff sheet patterns must differ.');
  }
  return rep;
}

/* ------------------------------------------------------------------------ */
/* Client API                                                                */
/* ------------------------------------------------------------------------ */

function apiGetSettings() {
  return apiCall_('apiGetSettings', function () {
    requireInitialized_();
    var cfg = getConfig_();
    return {
      values: cfg,
      definitions: CONFIG_DEFAULTS.filter(function (d) { return d[3] !== 'system'; }).map(function (d) {
        return { key: d[0], defaultValue: d[1], description: d[2], group: d[3],
          options: CONFIG_ENUMS[d[0]] || null, isBoolean: CONFIG_BOOLEANS.indexOf(d[0]) >= 0 };
      }),
      profiles: listProfiles_(),
      teams: listTeams_().map(function (t) { return { teamId: t.teamId, teamName: t.teamName }; }),
      importFields: IMPORT_FIELDS,
      importFormats: IMPORT_FORMATS,
      defaultLayout: DEFAULT_DAILY_LAYOUT
    };
  });
}

function apiSaveSettings(updates) {
  return apiCall_('apiSaveSettings', function () {
    requireInitialized_();
    return withLock_(function () {
      var rep = validateConfigUpdates_(updates || {});
      if (rep.fatal.length) fail_('VALIDATION', rep.fatal.join(' '), rep);
      var before = getConfig_();
      var changed = {};
      Object.keys(updates).forEach(function (k) { if (str_(before[k]) !== updates[k]) changed[k] = updates[k]; });
      if (Object.keys(changed).length) setConfigValues_(changed);
      var needsReformat = Object.keys(changed).some(function (k) {
        return CONFIG_COLORS.indexOf(k) >= 0 || /FORMAT|HIDE_SYSTEM|SHOW_CARRY/.test(k);
      });
      if (needsReformat) repairAllFormatting_();
      if (changed.DASHBOARD_SHEET) rebuildDashboardSafe_();
      return { changed: Object.keys(changed), reformatted: needsReformat };
    });
  });
}
