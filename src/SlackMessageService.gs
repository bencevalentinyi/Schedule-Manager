/**
 * SlackMessageService.gs  (v1.1.3)
 * Slack Workflow message: ONE row in an output sheet (headers in row 1, values in
 * row 2) that a Slack Workflow reads with "Select a spreadsheet row". Each column
 * is configured by the administrator — nothing team-, shift- or URL-specific is
 * hardcoded:
 *
 *   TEXT    fixed text (e.g. "DAILY", the key the workflow looks up)
 *   DATE    the run date (+/- days) in a chosen format (e.g. "yyyy. MM. dd")
 *   ROSTER  a multi-line list, one line per person (or per assignment), sorted by
 *           start time: "08:00 - 16:00 — @Ann Lee". Filters: teams, day offset
 *           (yesterday/today/tomorrow), shifts and/or meetings, activity types,
 *           roles (e.g. only / without "Shift Lead"), a time window (e.g. works
 *           during 08:00–14:00, works across 14:00, ends after 00:30 the next day),
 *           and an optional tag appended to matching lines (e.g. ":aircall:").
 *   URL     one dashboard link containing the identifiers of everyone who matches
 *           the same filters, joined as configured (e.g. "%2C", or "&userIds=" per ID).
 *
 * The builder (buildWorkflowMessage_) is pure; data comes from _SCHEDULE_DATA and
 * the staff directories (as for payload records). No triggers are created: to run
 * it daily, add a time-driven trigger for generateSlackWorkflowMessage yourself
 * (Apps Script editor → Triggers).
 *
 * Dependencies: Schema.gs, Utils.gs, SheetStore.gs, ConfigService.gs, TeamService.gs,
 *   StaffService.gs, MembershipService.gs, ScheduleService.gs, SlackPayloadService.gs
 */

var WF_COLUMN_TYPES = { TEXT: 'Fixed text', DATE: 'Date', ROSTER: 'Schedule list', URL: 'Dashboard link (all IDs)' };
var WF_CATEGORIES = { SHIFT: 'Shifts', MEETING: 'Meetings', ALL: 'Shifts and meetings' };
var WF_ROLE_MODES = { ALL: 'Everyone', EXCLUDE: 'Everyone except these roles', ONLY: 'Only these roles' };
var WF_TIME_MODES = {
  NONE: 'No time filter',
  OVERLAPS: 'Works during part of a window (from–to)',
  COVERS: 'Works across a time (starts before, ends at or after)',
  STARTS_BEFORE: 'Starts before a time',
  STARTS_FROM: 'Starts at or after a time',
  ENDS_AFTER: 'Ends after a time'
};
var WF_LINE_PLACEHOLDERS = ['START_TIME', 'END_TIME', 'DISPLAY', 'MENTION', 'EMPLOYEE_NAME', 'INTERNAL_EMPLOYEE_ID', 'TEAM_NAME', 'ACTIVITY', 'ROLE', 'TAG', 'DATE'];
var WF_URL_PLACEHOLDERS = ['IDS', 'DATE', 'COUNT'];
var WF_MAX_COLUMNS_ = 40;
var WF_MAX_CELL_ = 49000; // Google Sheets cells hold at most 50,000 characters
var WF_DEFAULT_LINE_ = '{START_TIME} - {END_TIME} — {DISPLAY}{TAG}';

/** A complete column with every setting at its default. */
function defaultWorkflowColumn_(type) {
  return {
    header: '', type: WF_COLUMN_TYPES[type] ? type : 'ROSTER',
    text: '', dateFormat: 'yyyy. MM. dd', dayOffset: 0,
    teamIds: [], category: 'SHIFT', activityTypes: [], roleMode: 'ALL', roles: [],
    excludeInactive: true, onlyMembers: false,
    timeMode: 'NONE', timeFrom: '', timeTo: '',
    merge: true, lineTemplate: WF_DEFAULT_LINE_, emptyText: 'None',
    tagText: '', tagMode: 'NONE', tagFrom: '', tagTo: '',
    urlTemplate: '', identifierField: 'employeeId', itemPrefix: '', itemSuffix: '', separator: '%2C', encoding: 'COMPONENT'
  };
}

/** Starter configuration (no team, URL or ID is assumed). */
function defaultWorkflowConfig_() {
  var col = function (o) { var c = defaultWorkflowColumn_(o.type); Object.keys(o).forEach(function (k) { c[k] = o[k]; }); return c; };
  return {
    sheetName: 'Slack Workflow',
    columns: [
      col({ header: 'Key', type: 'TEXT', text: 'DAILY' }),
      col({ header: 'Header_Date', type: 'DATE', dateFormat: 'yyyy. MM. dd' }),
      col({ header: 'Shift_Leads', type: 'ROSTER', roleMode: 'ONLY', roles: ['Shift Lead'], emptyText: 'No Shift Leads scheduled' }),
      col({ header: 'Agents', type: 'ROSTER', roleMode: 'EXCLUDE', roles: ['Shift Lead'], emptyText: 'No agents scheduled' }),
      col({ header: 'Meetings', type: 'ROSTER', category: 'MEETING', merge: false, lineTemplate: '{START_TIME} - {END_TIME} — {DISPLAY} ({ACTIVITY})' })
    ]
  };
}

/** "HH:mm" with hours 0–47 (24:30 = 00:30 the next day) → minutes, or null. */
function wfTime_(s) {
  var m = /^(\d{1,2}):(\d{2})$/.exec(str_(s));
  if (!m || +m[2] > 59 || +m[1] > 47) return null;
  return +m[1] * 60 + +m[2];
}

function normalizeWorkflowColumn_(c) {
  c = c && typeof c === 'object' ? c : {};
  var out = defaultWorkflowColumn_(c.type);
  var text = function (k) { if (c[k] !== undefined && c[k] !== null) out[k] = String(c[k]); };
  out.header = str_(c.header);
  ['text', 'dateFormat', 'lineTemplate', 'emptyText', 'tagText', 'urlTemplate', 'itemPrefix', 'itemSuffix', 'separator'].forEach(text); // kept exactly
  out.urlTemplate = out.urlTemplate.trim();
  out.dayOffset = Math.max(-7, Math.min(7, Math.round(toNumber_(c.dayOffset, 0))));
  if (Array.isArray(c.teamIds)) out.teamIds = uniq_(c.teamIds.map(str_).filter(Boolean));
  if (WF_CATEGORIES[c.category]) out.category = c.category;
  if (Array.isArray(c.activityTypes)) out.activityTypes = uniq_(c.activityTypes.map(normShiftType_).filter(Boolean));
  if (WF_ROLE_MODES[c.roleMode]) out.roleMode = c.roleMode;
  var roles = Array.isArray(c.roles) ? c.roles : String(c.roles || '').split(',');
  out.roles = uniq_(roles.map(function (r) { return str_(r).replace(/\s+/g, ' '); }).filter(Boolean));
  ['excludeInactive', 'onlyMembers', 'merge'].forEach(function (k) { if (c[k] !== undefined) out[k] = toBool_(c[k]); });
  if (WF_TIME_MODES[c.timeMode]) out.timeMode = c.timeMode;
  if (WF_TIME_MODES[c.tagMode]) out.tagMode = c.tagMode;
  ['timeFrom', 'timeTo', 'tagFrom', 'tagTo'].forEach(function (k) { out[k] = str_(c[k]); });
  out.identifierField = str_(c.identifierField) || 'employeeId';
  out.encoding = URL_ENCODINGS[c.encoding] ? c.encoding : 'COMPONENT';
  return out;
}

function normalizeWorkflowConfig_(c) {
  c = c && typeof c === 'object' ? c : {};
  if (!Array.isArray(c.columns)) return defaultWorkflowConfig_();
  return {
    sheetName: str_(c.sheetName) || 'Slack Workflow',
    columns: c.columns.slice(0, WF_MAX_COLUMNS_).map(normalizeWorkflowColumn_)
  };
}

function loadWorkflowConfig_() { return normalizeWorkflowConfig_(parseJson_(getConfig_().SLACK_MESSAGE_CONFIG, {})); }

/**
 * Validates a normalized configuration.
 * @param {Object} cfg
 * @param {{teamIds?: string[], fieldKeys?: string[]}} known existing teams / identifier fields (optional)
 */
function validateWorkflowConfig_(cfg, known) {
  var rep = newReport_();
  known = known || {};
  if (!cfg.columns.length) rep.fatal.push('Add at least one column.');
  if (/^_/.test(cfg.sheetName)) rep.fatal.push('The output sheet name must not start with "_" (reserved for internal sheets).');
  if (/[\[\]*?:\/\\]/.test(cfg.sheetName) || cfg.sheetName.length > 90) rep.fatal.push('The output sheet name contains characters Google Sheets does not allow, or is too long.');
  var seen = {};
  cfg.columns.forEach(function (c, i) {
    var name = 'Column ' + (i + 1) + (c.header ? ' "' + c.header + '"' : '');
    if (!c.header) rep.fatal.push(name + ': enter a header (the Slack Workflow finds the value by this name).');
    else if (seen[c.header.toLowerCase()]) rep.fatal.push(name + ': the header is used twice.');
    seen[c.header.toLowerCase()] = true;
    if (known.teamIds) c.teamIds.forEach(function (t) { if (known.teamIds.indexOf(t) < 0) rep.fatal.push(name + ': team ' + t + ' no longer exists.'); });
    if (c.type === 'ROSTER' || c.type === 'URL') {
      if ((c.roleMode !== 'ALL') && !c.roles.length) rep.fatal.push(name + ': list the roles to ' + (c.roleMode === 'ONLY' ? 'include' : 'exclude') + ', or choose "Everyone".');
      var checkTime = function (mode, from, to, label) {
        if (mode === 'NONE') return;
        if (wfTime_(from) === null) rep.fatal.push(name + ': ' + label + ' needs a time as HH:mm (use 24:30 for 00:30 the next day).');
        if (mode === 'OVERLAPS' && (wfTime_(to) === null || wfTime_(to) <= wfTime_(from))) rep.fatal.push(name + ': ' + label + ' needs an end time after the start time (use 24:00 or later for windows past midnight).');
      };
      checkTime(c.timeMode, c.timeFrom, c.timeTo, 'the time filter');
      if (c.type === 'ROSTER' && c.tagText) checkTime(c.tagMode, c.tagFrom, c.tagTo, 'the tag rule');
    }
    if (c.type === 'ROSTER') {
      renderTemplate_(c.lineTemplate, {}, WF_LINE_PLACEHOLDERS).unknown.forEach(function (u) { rep.fatal.push(name + ': unsupported placeholder {' + u + '} in the line text.'); });
    }
    if (c.type === 'URL') {
      if (!c.urlTemplate) rep.fatal.push(name + ': enter the dashboard URL template.');
      else {
        if (!/^https?:\/\//i.test(c.urlTemplate)) rep.fatal.push(name + ': the URL must start with http:// or https://.');
        if (c.urlTemplate.indexOf('{IDS}') < 0) rep.fatal.push(name + ': the URL template needs {IDS} where the identifiers go.');
        renderTemplate_(c.urlTemplate, {}, WF_URL_PLACEHOLDERS).unknown.forEach(function (u) { rep.fatal.push(name + ': unsupported placeholder {' + u + '} in the URL.'); });
      }
      if (known.fieldKeys && known.fieldKeys.indexOf(c.identifierField) < 0) rep.fatal.push(name + ': the identifier field no longer exists.');
    }
  });
  return rep;
}

/** True when a span [start, end) (minutes from 00:00 of its date) passes a time rule. */
function wfTimeMatches_(mode, from, to, start, end) {
  var f = wfTime_(from), t = wfTime_(to);
  switch (mode) {
    case 'OVERLAPS': return start < t && end > f;
    case 'COVERS': return start < f && end >= f;
    case 'STARTS_BEFORE': return start < f;
    case 'STARTS_FROM': return start >= f;
    case 'ENDS_AFTER': return end > f;
  }
  return true;
}

/**
 * Builds the message row. Pure.
 * @param {Object} input {
 *   cfg (normalized), runDate (ISO), records: schedule records of the needed teams/dates,
 *   teamsById, allTeamIds (teams used when a column lists none),
 *   resolve(teamId, rec) -> {staff|null, member: bool, role: string},
 *   fieldOf(staff, key) -> string, slackIdOf(staff) -> string,
 *   displayTemplate, formatDate(iso, format) -> string }
 * @return {{headers: string[], values: string[], columns: Object[], report: Object}}
 */
function buildWorkflowMessage_(input) {
  var cfg = input.cfg;
  var rep = validateWorkflowConfig_(cfg, null);
  var result = { headers: [], values: [], columns: [], report: rep };
  if (rep.fatal.length) return result;

  cfg.columns.forEach(function (c) {
    var date = addDays_(input.runDate, c.dayOffset);
    var info = { header: c.header, type: c.type, date: date, lines: 0, ids: 0, missing: [], value: '' };
    if (c.type === 'TEXT') info.value = c.text;
    else if (c.type === 'DATE') info.value = input.formatDate(date, c.dateFormat || 'yyyy-MM-dd');
    else {
      var items = workflowItems_(input, c, date);
      if (c.type === 'ROSTER') {
        var lines = items.map(function (x) {
          var tag = c.tagText && c.tagMode !== 'NONE' && wfTimeMatches_(c.tagMode, c.tagFrom, c.tagTo, x.start, x.end) ? ' ' + c.tagText : '';
          return renderTemplate_(c.lineTemplate, {
            START_TIME: minutesToHm_(x.start), END_TIME: minutesToHm_(x.end), DISPLAY: x.display, MENTION: x.mention,
            EMPLOYEE_NAME: x.name, INTERNAL_EMPLOYEE_ID: x.employeeId, TEAM_NAME: x.teamName, ACTIVITY: x.activity,
            ROLE: x.role, TAG: tag, DATE: date
          }, WF_LINE_PLACEHOLDERS).text.replace(/[ \t]+/g, ' ').trim();
        });
        info.lines = lines.length;
        info.value = lines.length ? lines.join('\n') : c.emptyText;
      } else {
        var ids = [], missing = [];
        items.forEach(function (x) {
          var id = x.staff ? str_(input.fieldOf(x.staff, c.identifierField)) : '';
          if (!id) { if (missing.indexOf(x.name) < 0) missing.push(x.name); return; }
          if (ids.indexOf(id) < 0) ids.push(id);
        });
        var enc = c.encoding === 'COMPONENT' ? encodeURIComponent : function (v) { return v; };
        var joined = ids.map(function (id) { return c.itemPrefix + enc(id) + c.itemSuffix; }).join(c.separator);
        info.value = renderTemplate_(c.urlTemplate, { IDS: joined, DATE: date, COUNT: ids.length }, WF_URL_PLACEHOLDERS).text;
        info.ids = ids.length;
        info.missing = missing;
        if (missing.length) {
          rep.warnings.push('"' + c.header + '": no identifier for ' + missing.slice(0, 15).join(', ') + (missing.length > 15 ? ', …' : '') +
            ' — they are left out of the link. Fill the field in the staff directory.');
        }
        var v = validateGeneratedUrl_(info.value);
        v.errors.forEach(function (e) { rep.fatal.push('"' + c.header + '": ' + e); });
      }
    }
    if (info.value.length > WF_MAX_CELL_) rep.fatal.push('"' + c.header + '" is ' + info.value.length + ' characters long; a Google Sheets cell holds at most 50,000. Narrow its filters.');
    result.headers.push(c.header);
    result.values.push(info.value);
    result.columns.push(info);
  });
  return result;
}

/**
 * Selected people/assignments of one ROSTER/URL column for a date, sorted by start
 * time then name. Filters run per assignment; the time rule runs on the line's span
 * (the merged span when merging, like the original daily plan).
 */
function workflowItems_(input, c, date) {
  var teamIds = c.teamIds.length ? c.teamIds : input.allTeamIds;
  var base = dayNumber_(date) * 1440;
  var groups = {}, order = [];
  input.records.forEach(function (rec) {
    if (rec.recordStatus !== RECORD_STATUS.ACTIVE || rec.shiftDate !== date || teamIds.indexOf(rec.teamId) < 0) return;
    if (!isIsoDateTime_(rec.shiftStart) || !isIsoDateTime_(rec.shiftEnd)) return;
    var team = input.teamsById[rec.teamId];
    if (!team) return;
    var isMeeting = activityCategoryOf_(rec) === ACTIVITY_CATEGORY.MEETING;
    if ((c.category === 'SHIFT' && isMeeting) || (c.category === 'MEETING' && !isMeeting)) return;
    var activity = rec.shiftType || rec.activity || (isMeeting ? 'Meeting' : 'Shift');
    if (c.activityTypes.length && c.activityTypes.indexOf(normShiftType_(activity)) < 0) return;
    var res = input.resolve(rec.teamId, rec);
    if (c.onlyMembers && (!res.staff || !res.member)) return;
    if (c.excludeInactive && res.staff && !res.staff.active) return;
    var role = str_(res.role);
    if (c.roleMode !== 'ALL') {
      var hit = c.roles.some(function (r) { return r.toLowerCase() === role.toLowerCase(); });
      if ((c.roleMode === 'ONLY') !== hit) return;
    }
    var name = res.staff ? res.staff.employeeName : rec.employeeName;
    var empId = res.staff ? res.staff.employeeId : rec.employeeId;
    var start = wallMinutes_(rec.shiftStart) - base, end = wallMinutes_(rec.shiftEnd) - base;
    var who = rec.teamId + '|' + (empId ? 'I:' + idKey_(empId) : 'N:' + normName_(name));
    var key = c.merge ? who : who + '|' + rec.recordKey;
    var g = groups[key];
    if (!g) {
      var display = renderTemplate_(input.displayTemplate, { EMPLOYEE_NAME: name, INTERNAL_EMPLOYEE_ID: empId, TEAM_NAME: team.teamName }, DISPLAY_PLACEHOLDERS).text;
      var slackId = res.staff ? str_(input.slackIdOf(res.staff)) : '';
      g = groups[key] = { name: name, employeeId: empId, teamName: team.teamName, role: role, staff: res.staff,
        display: display, mention: slackId ? '<@' + slackId + '>' : display, start: start, end: end, activities: [] };
      order.push(key);
    }
    g.start = Math.min(g.start, start);
    g.end = Math.max(g.end, end);
    if (g.activities.indexOf(activity) < 0) g.activities.push(activity);
  });
  return order.map(function (k) { var g = groups[k]; g.activity = g.activities.join(', '); return g; })
    .filter(function (g) { return wfTimeMatches_(c.timeMode, c.timeFrom, c.timeTo, g.start, g.end); })
    .sort(function (a, b) { return a.start - b.start || a.name.localeCompare(b.name); });
}

/* ------------------------------------------------------------------------ */
/* Collect data, preview, write                                              */
/* ------------------------------------------------------------------------ */

/** Formats an ISO date with a Utilities.formatDate pattern (date only, no time zone shift). */
function formatWorkflowDate_(iso, format) {
  var p = iso.split('-');
  return Utilities.formatDate(new Date(Date.UTC(+p[0], +p[1] - 1, +p[2], 12)), 'UTC', format);
}

/** Collects schedule records and staff for a configuration and builds the row (no writes). */
function prepareWorkflowMessage_(cfg, runDate) {
  if (!isIsoDate_(runDate)) fail_('VALIDATION', 'Choose a valid date.');
  var teams = listTeams_();
  var teamsById = {};
  teams.forEach(function (t) { teamsById[t.teamId] = t; });
  var allTeamIds = teams.filter(function (t) { return t.active && t.status === TEAM_STATUS.READY; }).map(function (t) { return t.teamId; });
  var needTeams = [], dates = [];
  cfg.columns.forEach(function (c) {
    if (c.type !== 'ROSTER' && c.type !== 'URL') return;
    (c.teamIds.length ? c.teamIds : allTeamIds).forEach(function (t) { if (teamsById[t] && needTeams.indexOf(t) < 0) needTeams.push(t); });
    var d = addDays_(runDate, c.dayOffset);
    if (dates.indexOf(d) < 0) dates.push(d);
  });
  var records = needTeams.length && dates.length ? queryScheduleRecords_({ teamIds: needTeams, dates: dates }) : [];
  var cfgAll = getConfig_();
  var payloadCfg = loadPayloadConfig_();
  var staff = {};
  needTeams.forEach(function (t) { staff[t] = teamsById[t].status === TEAM_STATUS.READY ? tryStaffIndex_(teamsById[t]) : null; });
  var fieldOf = function (s, key) { return !key ? '' : key === 'employeeId' ? s.employeeId : str_(s.fields ? s.fields[key] : ''); };
  var built = buildWorkflowMessage_({
    cfg: cfg, runDate: runDate, records: records, teamsById: teamsById, allTeamIds: allTeamIds,
    resolve: function (teamId, rec) {
      var idx = staff[teamId];
      if (!idx) return { staff: null, member: false, role: str_(rec.role) };
      var team = teamsById[teamId];
      var m = matchEmployee_(idx, rec.employeeId, rec.employeeName, team.settings.import.nameMatch || cfgAll.NAME_MATCH_STRATEGY);
      if (!m.staff) return { staff: null, member: false, role: str_(rec.role) };
      var mem = idx.isMember ? idx.isMember(m.staff) : { member: true };
      // Team-specific role (shared directory) first, then the staff Role column, then the role from the export.
      return { staff: m.staff, member: mem.member, role: str_(mem.role) || str_(m.staff.fields ? m.staff.fields.role : '') || str_(rec.role) };
    },
    fieldOf: fieldOf,
    slackIdOf: function (s) { return fieldOf(s, payloadCfg.slackUserIdField); },
    displayTemplate: payloadCfg.displayTemplate,
    formatDate: formatWorkflowDate_
  });
  mergeReport_(built.report, validateWorkflowConfig_(cfg, {
    teamIds: teams.map(function (t) { return t.teamId; }), fieldKeys: identifierFieldOptions_().map(function (f) { return f.key; })
  }));
  built.report.fatal = uniq_(built.report.fatal);
  built.runDate = runDate;
  built.sheetName = cfg.sheetName;
  return built;
}

/** Writes headers to row 1 and values to row 2 of the output sheet (created when missing). */
function writeWorkflowMessage_(built) {
  if (built.report.fatal.length) fail_('BLOCKED', 'The workflow message cannot be generated: ' + built.report.fatal.join(' '), built.report);
  var ss = getSs_();
  var sh = ss.getSheetByName(built.sheetName) || ss.insertSheet(built.sheetName);
  var n = built.headers.length;
  ensureColumns_(sh, n);
  var old = Math.max(sh.getLastColumn(), n);
  sh.getRange(1, 1, 2, old).clearContent();
  var rng = sh.getRange(1, 1, 2, n);
  rng.setNumberFormat('@'); // plain text: values starting with "=" or "+" are never treated as formulas
  rng.setValues([built.headers, built.values]);
  sh.getRange(1, 1, 1, n).setFontWeight('bold');
  sh.getRange(2, 1, 1, n).setWrap(true).setVerticalAlignment('top');
  return { sheet: sh.getName(), columns: n, runDate: built.runDate };
}

/**
 * Entry point for a time-driven trigger that YOU add (Apps Script editor → Triggers →
 * Add trigger → generateSlackWorkflowMessage → Time-driven). Uses today's date in the
 * configured time zone and the saved configuration. The code never creates triggers.
 */
function generateSlackWorkflowMessage() {
  requireInitialized_();
  var built = prepareWorkflowMessage_(loadWorkflowConfig_(), todayIso_(getConfig_().TIMEZONE));
  var r = withLock_(function () { return writeWorkflowMessage_(built); }, 60000);
  console.log('Slack Workflow message written to "' + r.sheet + '" for ' + r.runDate + ' (' + r.columns + ' columns).' +
    (built.report.warnings.length ? ' Warnings: ' + built.report.warnings.join(' ') : ''));
  return r;
}

/* ------------------------------------------------------------------------ */
/* Client API (SlackDialog.html, "Workflow message" tab)                     */
/* ------------------------------------------------------------------------ */

function apiWorkflowBootstrap() {
  return apiCall_('apiWorkflowBootstrap', function () {
    requireInitialized_();
    return {
      config: loadWorkflowConfig_(), defaultColumn: defaultWorkflowColumn_('ROSTER'),
      columnTypes: WF_COLUMN_TYPES, categories: WF_CATEGORIES, roleModes: WF_ROLE_MODES, timeModes: WF_TIME_MODES,
      linePlaceholders: WF_LINE_PLACEHOLDERS, urlPlaceholders: WF_URL_PLACEHOLDERS, today: todayIso_(getConfig_().TIMEZONE)
    };
  });
}

function workflowPreviewForClient_(built) {
  return { headers: built.headers, values: built.values, columns: built.columns, report: built.report, runDate: built.runDate,
    sheetName: built.sheetName, canWrite: !built.report.fatal.length };
}

/** Preview with the (possibly unsaved) configuration. Nothing is written. */
function apiWorkflowPreview(input, runDate) {
  return apiCall_('apiWorkflowPreview', function () {
    requireInitialized_();
    return workflowPreviewForClient_(prepareWorkflowMessage_(normalizeWorkflowConfig_(input), runDate));
  });
}

function apiWorkflowSaveConfig(input) {
  return apiCall_('apiWorkflowSaveConfig', function () {
    requireInitialized_();
    var cfg = normalizeWorkflowConfig_(input);
    var rep = validateWorkflowConfig_(cfg, { teamIds: listTeams_().map(function (t) { return t.teamId; }), fieldKeys: identifierFieldOptions_().map(function (f) { return f.key; }) });
    if (rep.fatal.length) fail_('VALIDATION', rep.fatal.join(' '), rep);
    return withLock_(function () { setConfigValues_({ SLACK_MESSAGE_CONFIG: JSON.stringify(cfg) }); return cfg; });
  });
}

/** Saves the configuration and writes the row for runDate. */
function apiWorkflowGenerate(input, runDate) {
  return apiCall_('apiWorkflowGenerate', function () {
    requireInitialized_();
    var cfg = normalizeWorkflowConfig_(input);
    var built = prepareWorkflowMessage_(cfg, runDate);
    if (built.report.fatal.length) fail_('BLOCKED', 'The workflow message cannot be generated: ' + built.report.fatal.join(' '), built.report);
    return withLock_(function () {
      setConfigValues_({ SLACK_MESSAGE_CONFIG: JSON.stringify(cfg) });
      var w = writeWorkflowMessage_(built);
      var preview = workflowPreviewForClient_(built);
      preview.written = w;
      return preview;
    }, 60000);
  });
}

function apiWorkflowOpenSheet(sheetName) {
  return apiCall_('apiWorkflowOpenSheet', function () {
    var sh = getSs_().getSheetByName(str_(sheetName));
    if (!sh) fail_('NOT_FOUND', 'The sheet "' + sheetName + '" does not exist yet. Generate the message first.');
    if (sh.isSheetHidden()) sh.showSheet();
    sh.activate();
    return { sheet: sh.getName() };
  });
}
