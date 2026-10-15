/**
 * SlackPayloadService.gs  (v1.1.1)
 * Slack Workflow Automation: generates payload records and dashboard URLs from
 * the NORMALIZED schedule data (_SCHEDULE_DATA) and the staff directories, and
 * writes them to _SLACK_PAYLOADS. It never parses Quinyx exports and never
 * modifies schedule data. No triggers are created (manual generation only).
 *
 * Pipeline (three separate stages):
 *   1. retrieve + validate  (selectPayloadRecords_ / buildPayloadPlan_)
 *   2. group into blocks    (groupIntoBlocks_)
 *   3. serialize            (PAYLOAD_SERIALIZERS — "ROWS" writes one sheet row per record)
 * The exact Slack Workflow input schema is NOT verified; records are normalized
 * and a serializer can be added for a specific schema later.
 *
 * Employee display: "@{EMPLOYEE_NAME}" by default. This is a DISPLAY STRING, not a
 * Slack mention. A real mention needs a Slack user ID (<@U123…>); if a staff field
 * holding Slack user IDs is configured, the ID is written to "Slack User ID".
 *
 * Dependencies: Schema.gs, Utils.gs, SheetStore.gs, ConfigService.gs, TeamService.gs,
 *   StaffService.gs, StaffFieldService.gs, MembershipService.gs, ScheduleService.gs
 */

var URL_PLACEHOLDERS = ['EMPLOYEE_ID', 'EMPLOYEE_NAME', 'TEAM_ID', 'TEAM_NAME', 'DATE', 'START_TIME', 'END_TIME'];
var LINE_PLACEHOLDERS = URL_PLACEHOLDERS.concat(['DISPLAY', 'URL', 'ACTIVITY', 'INTERNAL_EMPLOYEE_ID']);
var DISPLAY_PLACEHOLDERS = ['EMPLOYEE_NAME', 'INTERNAL_EMPLOYEE_ID', 'TEAM_NAME'];
var URL_ENCODINGS = { COMPONENT: 'Encode inserted values (recommended for URL parameters)', NONE: 'Insert values exactly as stored' };
var MISSING_ID_POLICIES = {
  BLANK_WARN: 'Generate the record with a blank URL and a warning',
  SKIP_RECORD: 'Skip the record (counted in the summary)',
  BLOCK: 'Stop generation until the identifiers are filled in'
};
var GROUP_FIELDS = { team: 'Team', date: 'Schedule date', employee: 'Employee', activity: 'Activity type' };
var PAYLOAD_DATE_MODES = { TODAY: 'Today', TOMORROW: 'Tomorrow', DATE: 'A specific date', RANGE: 'A date range' };
var MAX_PAYLOAD_DAYS_ = 62;

var DEFAULT_URL_CONFIG = { template: '', identifierField: 'employeeId', prefix: '', suffix: '', encoding: 'COMPONENT', missingPolicy: 'BLANK_WARN' };
var DEFAULT_PAYLOAD_CONFIG = {
  teamIds: [], dateMode: 'TODAY', dateFrom: '', dateTo: '', activityTypes: [], includeMeetings: true,
  excludeInactive: true, excludeUnresolved: true, blockCount: 1, recordsPerBlock: 0, groupBy: ['team'],
  outputMode: 'REPLACE', displayTemplate: '@{EMPLOYEE_NAME}',
  lineTemplate: '{DISPLAY} {START_TIME}–{END_TIME} {ACTIVITY} {URL}', slackUserIdField: '', serializer: 'ROWS'
};

/* ======================================================================== */
/* Pure: configuration, templates, URLs                                      */
/* ======================================================================== */

function normalizeUrlConfig_(c) {
  c = c && typeof c === 'object' ? c : {};
  var out = JSON.parse(JSON.stringify(DEFAULT_URL_CONFIG));
  out.template = String(c.template === undefined ? '' : c.template).trim();
  out.identifierField = str_(c.identifierField) || 'employeeId';
  out.prefix = c.prefix === undefined || c.prefix === null ? '' : String(c.prefix);   // kept exactly (no trimming)
  out.suffix = c.suffix === undefined || c.suffix === null ? '' : String(c.suffix);
  out.encoding = URL_ENCODINGS[c.encoding] ? c.encoding : 'COMPONENT';
  out.missingPolicy = MISSING_ID_POLICIES[c.missingPolicy] ? c.missingPolicy : 'BLANK_WARN';
  return out;
}

function normalizePayloadConfig_(c) {
  c = c && typeof c === 'object' ? c : {};
  var out = JSON.parse(JSON.stringify(DEFAULT_PAYLOAD_CONFIG));
  if (Array.isArray(c.teamIds)) out.teamIds = uniq_(c.teamIds.map(str_).filter(Boolean));
  if (PAYLOAD_DATE_MODES[c.dateMode]) out.dateMode = c.dateMode;
  out.dateFrom = isIsoDate_(c.dateFrom) ? c.dateFrom : '';
  out.dateTo = isIsoDate_(c.dateTo) ? c.dateTo : '';
  if (Array.isArray(c.activityTypes)) out.activityTypes = uniq_(c.activityTypes.map(normShiftType_).filter(Boolean));
  ['includeMeetings', 'excludeInactive', 'excludeUnresolved'].forEach(function (k) { if (c[k] !== undefined) out[k] = toBool_(c[k]); });
  out.blockCount = Math.max(1, Math.min(500, Math.round(toNumber_(c.blockCount, 1))));
  out.recordsPerBlock = Math.max(0, Math.min(5000, Math.round(toNumber_(c.recordsPerBlock, 0))));
  if (Array.isArray(c.groupBy)) out.groupBy = uniq_(c.groupBy.filter(function (g) { return GROUP_FIELDS[g]; }));
  out.outputMode = c.outputMode === 'APPEND' ? 'APPEND' : 'REPLACE';
  if (c.displayTemplate !== undefined) out.displayTemplate = String(c.displayTemplate);
  if (c.lineTemplate !== undefined) out.lineTemplate = String(c.lineTemplate);
  out.slackUserIdField = str_(c.slackUserIdField);
  out.serializer = PAYLOAD_SERIALIZERS[c.serializer] ? c.serializer : 'ROWS';
  return out;
}

/**
 * Replaces {PLACEHOLDER} tokens with values. Only the allowed names are
 * replaced; anything else is reported and left in place (so it shows up in
 * validation). Templates are plain text — nothing is ever evaluated.
 */
function renderTemplate_(tpl, values, allowed) {
  var unknown = [];
  var text = String(tpl || '').replace(/\{([A-Za-z_]+)\}/g, function (m, name) {
    if (allowed.indexOf(name) < 0) { unknown.push(name); return m; }
    var v = values[name];
    return v === undefined || v === null ? '' : String(v);
  });
  return { text: text, unknown: uniq_(unknown) };
}

/**
 * Validates a generated URL.
 * INVALID: not http(s), contains whitespace, or unresolved placeholders.
 * WARNING: characters that usually need encoding, malformed %-escapes, non-ASCII
 *          (kept exactly as configured, never "fixed" automatically).
 */
function validateGeneratedUrl_(url) {
  var errors = [], warnings = [];
  if (!/^https?:\/\/[^\s\/?#]+/i.test(url)) errors.push('The URL must start with http:// or https:// followed by a host name.');
  if (/\s/.test(url)) errors.push('The URL contains whitespace.');
  if (/\{[A-Za-z_]+\}/.test(url)) errors.push('The URL still contains a placeholder that was not replaced.');
  if (/["<>\\^`|{}]/.test(url)) warnings.push('The URL contains characters that are usually encoded (" < > \\ ^ ` | { }). They are kept exactly as configured.');
  if (/%(?![0-9A-Fa-f]{2})/.test(url)) warnings.push('The URL contains a "%" that is not followed by two hex digits (not a standard %-escape). It is kept exactly as configured.');
  if (/[^\x20-\x7e]/.test(url)) warnings.push('The URL contains non-ASCII characters.');
  return { status: errors.length ? 'INVALID' : (warnings.length ? 'WARNING' : 'OK'), errors: errors, warnings: warnings };
}

/**
 * Builds a dashboard URL. {EMPLOYEE_ID} becomes prefix + value + suffix, where
 * the identifier value is encoded according to the configuration and the
 * prefix/suffix are inserted literally (custom delimiters are preserved).
 * The rest of the template is never encoded or altered.
 * @param {Object} cfg normalized URL config
 * @param {Object} ctx {identifier, employeeName, teamId, teamName, date, startTime, endTime}
 * @return {{url: string, status: 'OK'|'WARNING'|'INVALID'|'MISSING_ID'|'DISABLED', messages: string[]}}
 */
function buildDashboardUrl_(cfg, ctx) {
  if (!cfg.template) return { url: '', status: 'DISABLED', messages: [] };
  var id = str_(ctx.identifier);
  if (!id) return { url: '', status: 'MISSING_ID', messages: ['No dashboard identifier for ' + (ctx.employeeName || 'this employee') + '.'] };
  var enc = cfg.encoding === 'COMPONENT' ? encodeURIComponent : function (v) { return String(v); };
  var r = renderTemplate_(cfg.template, {
    EMPLOYEE_ID: cfg.prefix + enc(id) + cfg.suffix,
    EMPLOYEE_NAME: enc(ctx.employeeName || ''), TEAM_ID: enc(ctx.teamId || ''), TEAM_NAME: enc(ctx.teamName || ''),
    DATE: enc(ctx.date || ''), START_TIME: enc(ctx.startTime || ''), END_TIME: enc(ctx.endTime || '')
  }, URL_PLACEHOLDERS);
  var v = validateGeneratedUrl_(r.text);
  var messages = r.unknown.map(function (u) { return 'Unsupported placeholder {' + u + '}.'; }).concat(v.errors).concat(v.warnings);
  return { url: v.status === 'INVALID' ? '' : r.text, attemptedUrl: r.text, status: v.status, messages: messages };
}

/** Validates the URL configuration itself (template placeholders, required identifier placeholder). */
function validateUrlConfig_(cfg, knownFields) {
  var rep = newReport_();
  if (!cfg.template) { rep.info.push('No dashboard URL template: payload records are generated without URLs.'); return rep; }
  var r = renderTemplate_(cfg.template, {}, URL_PLACEHOLDERS);
  r.unknown.forEach(function (u) { rep.fatal.push('Unsupported placeholder {' + u + '}. Supported: ' + URL_PLACEHOLDERS.map(function (p) { return '{' + p + '}'; }).join(', ') + '.'); });
  if (cfg.template.indexOf('{EMPLOYEE_ID}') < 0) rep.warnings.push('The template has no {EMPLOYEE_ID}: every employee would get the same URL.');
  if (!/^https?:\/\//i.test(cfg.template)) rep.fatal.push('The template must start with http:// or https://.');
  if (knownFields && knownFields.indexOf(cfg.identifierField) < 0) rep.fatal.push('The identifier field "' + cfg.identifierField + '" does not exist in the staff configuration.');
  var sample = buildDashboardUrl_(cfg, { identifier: 'TEST123', employeeName: 'Test Name', teamId: 'TEAM_001', teamName: 'Test Team', date: '2026-01-31', startTime: '08:00', endTime: '16:00' });
  sample.messages.forEach(function (m) { (sample.status === 'INVALID' ? rep.fatal : rep.warnings).push('Sample URL: ' + m); });
  return rep;
}

/* ======================================================================== */
/* Pure: selection, blocks, serialization                                    */
/* ======================================================================== */

function payloadGroupKey_(r, groupBy) {
  return groupBy.map(function (g) {
    if (g === 'team') return r.teamName;
    if (g === 'employee') return r.employeeName + ' [' + r.employeeId + ']';
    if (g === 'date') return r.scheduleDate;
    return r.activityType || r.activityCategory;
  }).join(' / ') || 'All';
}

/**
 * Groups records into blocks without ever dropping a record.
 *  - recordsPerBlock > 0: blocks hold at most that many records; a group is kept
 *    together when it fits, otherwise split (warning). Needing more blocks than
 *    blockCount is FATAL (nothing is generated).
 *  - recordsPerBlock = 0: groups are distributed over at most blockCount blocks
 *    (consecutive groups combined when there are more groups than blocks).
 * @return {{blocks: Array<Array<Object>>, warnings: string[], fatal: string[]}}
 */
function groupIntoBlocks_(records, groupBy, blockCount, recordsPerBlock) {
  var warnings = [], fatal = [];
  var units = [];
  records.forEach(function (r) {
    var k = payloadGroupKey_(r, groupBy);
    var last = units[units.length - 1];
    if (last && last.key === k) last.records.push(r); else units.push({ key: k, records: [r] });
  });
  var blocks = [];
  if (!units.length) return { blocks: blocks, warnings: warnings, fatal: fatal };
  if (recordsPerBlock > 0) {
    var cur = null;
    units.forEach(function (u) {
      if (!cur || (cur.length && cur.length + u.records.length > recordsPerBlock)) { cur = []; blocks.push(cur); }
      var rest = u.records.slice();
      if (rest.length > recordsPerBlock) warnings.push('Group "' + u.key + '" has ' + rest.length + ' records and is split across blocks (max ' + recordsPerBlock + ' per block).');
      while (rest.length) {
        if (cur.length === recordsPerBlock) { cur = []; blocks.push(cur); }
        var take = Math.min(recordsPerBlock - cur.length, rest.length);
        rest.splice(0, take).forEach(function (r) { cur.push(r); });
      }
    });
    if (blocks.length > blockCount) {
      fatal.push('The selected records need ' + blocks.length + ' blocks of up to ' + recordsPerBlock + ' records, but only ' + blockCount +
        ' block(s) are allowed. Increase the number of blocks or records per block, or narrow the scope. Nothing was generated (no records are dropped to fit a limit).');
    }
  } else if (units.length <= blockCount) {
    units.forEach(function (u) { blocks.push(u.records.slice()); });
    if (units.length < blockCount) warnings.push('Only ' + units.length + ' block(s) were needed (' + blockCount + ' requested): there are fewer groups than blocks.');
  } else {
    var total = records.length, before = 0, byIndex = {};
    units.forEach(function (u) {
      // Whole groups are placed in order; the block index grows with the share of records already placed.
      var bi = Math.min(blockCount - 1, Math.floor(before * blockCount / total));
      if (!byIndex[bi]) byIndex[bi] = [];
      Array.prototype.push.apply(byIndex[bi], u.records);
      before += u.records.length;
    });
    Object.keys(byIndex).map(Number).sort(function (a, b) { return a - b; }).forEach(function (k) { blocks.push(byIndex[k]); });
    warnings.push(units.length + ' groups were combined into ' + blocks.length + ' block(s).');
  }
  var count = blocks.reduce(function (s, b) { return s + b.length; }, 0);
  if (count !== records.length) fatal.push('Internal check failed: ' + (records.length - count) + ' record(s) would be lost while forming blocks. Nothing was generated.');
  return { blocks: blocks, warnings: warnings, fatal: fatal };
}

/** Serializers turn blocks into output rows. Add new ones here for a verified Slack schema. */
var PAYLOAD_SERIALIZERS = {
  ROWS: function (blocks) {
    var out = [];
    blocks.forEach(function (b, i) { b.forEach(function (r) { r.blockNumber = i + 1; out.push(r); }); });
    return out;
  }
};

/**
 * Builds payload records (stages 1–3) from injected data. Pure.
 * @param {Object} input {
 *   records: schedule records (any status), cfg: payload config, urlCfg: URL config,
 *   from, to: ISO dates, teamsById,
 *   resolve(teamId, rec) -> {staff|null, member: bool, method: string},
 *   identifierOf(staff) -> string, slackIdOf(staff) -> string,
 *   generationId, existingHashes: {hash: generationId} }
 */
function buildPayloadPlan_(input) {
  var cfg = input.cfg, urlCfg = input.urlCfg;
  var rep = newReport_();
  var S = { teams: [], dateFrom: input.from, dateTo: input.to, considered: 0, generated: 0, blocks: 0, unknownEmployees: 0,
    ambiguousTeam: 0, missingIds: 0, invalidUrls: 0, urlWarnings: 0, skipped: 0, skippedMeetings: 0, skippedActivity: 0,
    skippedInactive: 0, skippedUnresolved: 0, skippedMissingId: 0 };
  if (!cfg.teamIds.length) rep.fatal.push('Select at least one team in Configure Payload Generation.');
  cfg.teamIds.forEach(function (t) { if (!input.teamsById[t]) rep.fatal.push('Team ' + t + ' no longer exists. Update the payload configuration.'); });
  if (!(input.from && input.to) || input.from > input.to) rep.fatal.push('Choose a valid date or date range.');
  var dispCheck = renderTemplate_(cfg.displayTemplate, {}, DISPLAY_PLACEHOLDERS);
  dispCheck.unknown.forEach(function (u) { rep.fatal.push('Employee display template: unsupported placeholder {' + u + '}.'); });
  var lineCheck = renderTemplate_(cfg.lineTemplate, {}, LINE_PLACEHOLDERS);
  lineCheck.unknown.forEach(function (u) { rep.fatal.push('Line template: unsupported placeholder {' + u + '}.'); });
  mergeReport_(rep, validateUrlConfig_(urlCfg, null));
  if (rep.fatal.length) return { report: rep, summary: S, records: [], blocks: [], hash: '' };

  var out = [], missingNames = {};
  input.records.forEach(function (rec) {
    if (rec.recordStatus !== RECORD_STATUS.ACTIVE) return;
    if (cfg.teamIds.indexOf(rec.teamId) < 0 || rec.shiftDate < input.from || rec.shiftDate > input.to) return;
    if (!isIsoDateTime_(rec.shiftStart) || !isIsoDateTime_(rec.shiftEnd)) return;
    S.considered++;
    var isMeeting = str_(rec.activityCategory).toUpperCase() === ACTIVITY_CATEGORY.MEETING;
    var activity = rec.shiftType || rec.activity || (isMeeting ? 'Meeting' : 'Shift');
    if (isMeeting && !cfg.includeMeetings) { S.skippedMeetings++; S.skipped++; return; }
    if (cfg.activityTypes.length && cfg.activityTypes.indexOf(normShiftType_(activity)) < 0) { S.skippedActivity++; S.skipped++; return; }
    var team = input.teamsById[rec.teamId];
    var res = input.resolve(rec.teamId, rec);
    var status = 'OK', messages = [];
    if (!res.staff) { S.unknownEmployees++; status = 'UNRESOLVED_EMPLOYEE'; messages.push('Employee not found in the staff directory.'); }
    else if (!res.member) { S.ambiguousTeam++; status = 'NOT_TEAM_MEMBER'; messages.push('Employee is not an active member of ' + team.teamName + '.'); }
    if (status !== 'OK' && cfg.excludeUnresolved) { S.skippedUnresolved++; S.skipped++; return; }
    if (res.staff && !res.staff.active && cfg.excludeInactive) { S.skippedInactive++; S.skipped++; return; }
    var name = res.staff ? res.staff.employeeName : rec.employeeName;
    var empId = res.staff ? res.staff.employeeId : rec.employeeId;
    var startTime = rec.shiftStart.substr(11, 5), endTime = rec.shiftEnd.substr(11, 5);
    var identifier = res.staff ? str_(input.identifierOf(res.staff)) : '';
    var url = buildDashboardUrl_(urlCfg, { identifier: identifier, employeeName: name, teamId: rec.teamId, teamName: team.teamName,
      date: rec.shiftDate, startTime: startTime, endTime: endTime });
    if (url.status === 'MISSING_ID') {
      S.missingIds++;
      missingNames[name || empId] = true;
      if (urlCfg.missingPolicy === 'SKIP_RECORD') { S.skippedMissingId++; S.skipped++; return; }
      if (status === 'OK') status = 'MISSING_DASHBOARD_ID';
      messages = messages.concat(url.messages);
    } else if (url.status === 'INVALID') {
      S.invalidUrls++;
      if (status === 'OK') status = 'INVALID_URL';
      messages = messages.concat(url.messages);
    } else if (url.status === 'WARNING') {
      S.urlWarnings++;
      if (status === 'OK') status = 'URL_WARNING';
      messages = messages.concat(url.messages);
    }
    var display = renderTemplate_(cfg.displayTemplate, { EMPLOYEE_NAME: name, INTERNAL_EMPLOYEE_ID: empId, TEAM_NAME: team.teamName }, DISPLAY_PLACEHOLDERS).text;
    out.push({
      scheduleDate: rec.shiftDate, employeeId: empId, employeeName: name, employeeDisplay: display,
      teamId: rec.teamId, teamName: team.teamName, activityType: activity,
      activityCategory: isMeeting ? ACTIVITY_CATEGORY.MEETING : ACTIVITY_CATEGORY.SHIFT,
      startDateTime: rec.shiftStart, endDateTime: rec.shiftEnd, startTime: startTime, endTime: endTime,
      dashboardId: identifier, dashboardUrl: url.url, sourceRecordKey: rec.recordKey, sourceImportId: rec.lastImportId || '',
      payloadStatus: status, message: messages.join(' '), slackUserId: res.staff ? str_(input.slackIdOf(res.staff)) : ''
    });
  });
  if (urlCfg.missingPolicy === 'BLOCK' && S.missingIds) {
    rep.fatal.push(S.missingIds + ' record(s) have no dashboard identifier (' + Object.keys(missingNames).slice(0, 15).join(', ') +
      (Object.keys(missingNames).length > 15 ? ', …' : '') + '). Fill the identifier in the staff directory, or change the missing-identifier policy.');
  }
  out.sort(function (a, b) {
    var ka = payloadGroupKey_(a, cfg.groupBy), kb = payloadGroupKey_(b, cfg.groupBy);
    return ka < kb ? -1 : ka > kb ? 1 : (a.scheduleDate < b.scheduleDate ? -1 : a.scheduleDate > b.scheduleDate ? 1 :
      (a.startDateTime < b.startDateTime ? -1 : a.startDateTime > b.startDateTime ? 1 : a.employeeName.localeCompare(b.employeeName)));
  });
  out.forEach(function (r) { r.groupKey = payloadGroupKey_(r, cfg.groupBy); });
  var grouped = groupIntoBlocks_(out, cfg.groupBy, cfg.blockCount, cfg.recordsPerBlock);
  grouped.warnings.forEach(function (w) { rep.info.push(w); });
  grouped.fatal.forEach(function (f) { rep.fatal.push(f); });
  var rows = PAYLOAD_SERIALIZERS[cfg.serializer](grouped.blocks);
  rows.forEach(function (r, i) {
    r.lineText = renderTemplate_(cfg.lineTemplate, {
      DISPLAY: r.employeeDisplay, EMPLOYEE_NAME: r.employeeName, INTERNAL_EMPLOYEE_ID: r.employeeId, EMPLOYEE_ID: r.dashboardId,
      TEAM_ID: r.teamId, TEAM_NAME: r.teamName, DATE: r.scheduleDate, START_TIME: r.startTime, END_TIME: r.endTime,
      ACTIVITY: r.activityType, URL: r.dashboardUrl
    }, LINE_PLACEHOLDERS).text.replace(/\s+/g, ' ').trim();
    r.payloadId = input.generationId + '-' + ('000' + (i + 1)).slice(-4);
    r.generationId = input.generationId;
  });
  var hash = hash64_(stableStringify_(rows.map(function (r) {
    return [r.sourceRecordKey, r.teamId, r.employeeDisplay, r.startDateTime, r.endDateTime, r.dashboardUrl, r.blockNumber, r.lineText];
  })));
  rows.forEach(function (r) { r.contentHash = hash; });
  S.teams = cfg.teamIds.map(function (t) { return input.teamsById[t] ? input.teamsById[t].teamName : t; });
  S.generated = rows.length;
  S.blocks = grouped.blocks.length;
  if (S.unknownEmployees) rep.warnings.push(S.unknownEmployees + ' record(s) belong to employees not found in the staff directory' + (cfg.excludeUnresolved ? ' (excluded).' : '.'));
  if (S.ambiguousTeam) rep.warnings.push(S.ambiguousTeam + ' record(s) belong to employees who are not active members of the record\'s team' + (cfg.excludeUnresolved ? ' (excluded).' : '.'));
  if (S.missingIds && urlCfg.missingPolicy !== 'BLOCK') rep.warnings.push(S.missingIds + ' record(s) have no dashboard identifier' + (urlCfg.missingPolicy === 'SKIP_RECORD' ? ' (skipped).' : ' (URL left blank).'));
  if (S.invalidUrls) rep.warnings.push(S.invalidUrls + ' generated URL(s) are invalid and were left blank. Check the URL template.');
  if (S.urlWarnings) rep.warnings.push(S.urlWarnings + ' URL(s) contain unusual characters (kept as configured).');
  if (input.existingHashes && input.existingHashes[hash] && rows.length) {
    rep.warnings.push('Identical payloads were already generated in ' + input.existingHashes[hash] + '.');
  }
  if (!rows.length && !rep.fatal.length) rep.warnings.push('No schedule records match the selected scope.');
  return { report: rep, summary: S, records: rows, blocks: grouped.blocks, hash: hash };
}

/* ======================================================================== */
/* Service                                                                   */
/* ======================================================================== */

function loadPayloadConfig_() { return normalizePayloadConfig_(parseJson_(getConfig_().SLACK_PAYLOAD_CONFIG, {})); }
function loadUrlConfig_() { return normalizeUrlConfig_(parseJson_(getConfig_().DASHBOARD_URL_CONFIG, {})); }

/** Field keys that can supply an identifier: Employee ID plus configured staff fields. */
function identifierFieldOptions_() {
  return [{ key: 'employeeId', label: 'Employee ID' }].concat(listStaffFields_().map(function (f) {
    return { key: STAFF_REGISTRY_PREFIX + f.fieldKey, label: f.displayName + (f.fieldType === 'IDENTIFIER' ? '' : ' (text field)') };
  }));
}

/** Resolves the configured date scope to {from, to}. */
function resolvePayloadDates_(cfg, override) {
  var today = todayIso_(getConfig_().TIMEZONE);
  if (override && isIsoDate_(override.dateFrom)) return { from: override.dateFrom, to: isIsoDate_(override.dateTo) ? override.dateTo : override.dateFrom };
  if (cfg.dateMode === 'TOMORROW') return { from: addDays_(today, 1), to: addDays_(today, 1) };
  if (cfg.dateMode === 'DATE') return { from: cfg.dateFrom, to: cfg.dateFrom };
  if (cfg.dateMode === 'RANGE') return { from: cfg.dateFrom, to: cfg.dateTo };
  return { from: today, to: today };
}

/** Collects all inputs and builds the plan (no writes). */
function preparePayloadRun_(override) {
  var cfg = loadPayloadConfig_(), urlCfg = loadUrlConfig_();
  if (override && Array.isArray(override.teamIds) && override.teamIds.length) cfg.teamIds = override.teamIds;
  var range = resolvePayloadDates_(cfg, override);
  var teams = listTeams_();
  var teamsById = {};
  teams.forEach(function (t) { teamsById[t.teamId] = t; });
  var dates = [];
  if (isIsoDate_(range.from) && isIsoDate_(range.to) && range.from <= range.to) {
    if (dayNumber_(range.to) - dayNumber_(range.from) + 1 > MAX_PAYLOAD_DAYS_) fail_('VALIDATION', 'The date range is longer than ' + MAX_PAYLOAD_DAYS_ + ' days. Choose a shorter range.');
    for (var d = range.from; d <= range.to; d = addDays_(d, 1)) dates.push(d);
  }
  var selected = cfg.teamIds.filter(function (t) { return teamsById[t]; });
  var records = selected.length && dates.length ? queryScheduleRecords_({ teamIds: selected, dates: dates }) : [];
  var cfgAll = getConfig_();
  var staff = {};
  selected.forEach(function (t) { staff[t] = teamsById[t].status === TEAM_STATUS.READY ? tryStaffIndex_(teamsById[t]) : null; });
  var fieldOf = function (s, key) { return !key ? '' : key === 'employeeId' ? s.employeeId : str_(s.fields ? s.fields[key] : ''); };
  var existingHashes = {};
  if (getSheet_(T_SLACK_PAYLOADS.sheet)) {
    readTable_(T_SLACK_PAYLOADS).rows.forEach(function (r) { if (str_(r.contentHash)) existingHashes[str_(r.contentHash)] = str_(r.generationId); });
  }
  var generationId = newId_('GEN');
  var plan = buildPayloadPlan_({
    records: records, cfg: cfg, urlCfg: urlCfg, from: range.from, to: range.to, teamsById: teamsById,
    resolve: function (teamId, rec) {
      var idx = staff[teamId];
      if (!idx) return { staff: null, member: false };
      var team = teamsById[teamId];
      var m = matchEmployee_(idx, rec.employeeId, rec.employeeName, team.settings.import.nameMatch || cfgAll.NAME_MATCH_STRATEGY);
      return { staff: m.staff, member: m.staff ? (idx.isMember ? idx.isMember(m.staff).member : true) : false, method: m.status };
    },
    identifierOf: function (s) { return fieldOf(s, urlCfg.identifierField); },
    slackIdOf: function (s) { return fieldOf(s, cfg.slackUserIdField); },
    generationId: generationId, existingHashes: existingHashes
  });
  plan.cfg = cfg; plan.urlCfg = urlCfg; plan.range = range; plan.generationId = generationId;
  plan.token = hashString_([plan.hash, cfg.outputMode, range.from, range.to, cfg.teamIds.join(',')].join('|'));
  return plan;
}

/**
 * Writes a plan. REPLACE removes only existing payload rows of the selected teams
 * within the selected dates; APPEND adds a new generation. One write per run.
 */
function writePayloads_(plan) {
  var t = readTable_(T_SLACK_PAYLOADS);
  var now = new Date();
  var newRows = plan.records.map(function (r) {
    r.generatedAt = now;
    return objectToRow_(T_SLACK_PAYLOADS, t.header, r, null);
  });
  var removed = 0;
  if (plan.cfg.outputMode === 'REPLACE') {
    var kept = [];
    for (var i = 1; i < t.values.length; i++) {
      var row = t.values[i];
      if (row.every(isBlank_)) continue;
      var o = rowToObject_(T_SLACK_PAYLOADS, t.idx, row, i + 1);
      var date = cellToIsoDate_(o.scheduleDate, getTz_());
      var inScope = plan.cfg.teamIds.indexOf(str_(o.teamId)) >= 0 && date >= plan.range.from && date <= plan.range.to;
      if (inScope) removed++; else kept.push(row);
    }
    replaceAllRows_(t.sheet, T_SLACK_PAYLOADS, t.header, kept.concat(newRows), t.lastRow);
  } else if (newRows.length) {
    writeRows_(t.sheet, T_SLACK_PAYLOADS, t.header, t.lastRow + 1, newRows);
  }
  return { removed: removed, written: newRows.length };
}

/** Number of distinct employees among the payload records. */
function payloadEmployeeCount_(records) {
  return uniq_(records.map(function (r) { return str_(r.employeeId) || normName_(r.employeeName); })).length;
}

function summaryForClient_(plan) {
  return {
    generationId: plan.generationId, token: plan.token, summary: plan.summary, report: plan.report,
    employees: payloadEmployeeCount_(plan.records), // v1.1.2
    teamNames: uniq_(plan.records.map(function (r) { return r.teamName; })),
    canGenerate: !plan.report.fatal.length && plan.records.length > 0, outputMode: plan.cfg.outputMode,
    range: plan.range, duplicate: plan.report.warnings.some(function (w) { return /^Identical payloads/.test(w); }),
    sample: plan.records.slice(0, 60).map(function (r) {
      return { block: r.blockNumber, group: r.groupKey, date: r.scheduleDate, display: r.employeeDisplay, team: r.teamName,
        activity: r.activityType, start: r.startTime, end: r.endTime, dashboardId: r.dashboardId, url: r.dashboardUrl, status: r.payloadStatus, message: r.message };
    })
  };
}

/** Report for Validate Payload Data. */
function validatePayloads_() {
  var rep = newReport_();
  var urlCfg = loadUrlConfig_(), cfg = loadPayloadConfig_();
  var fields = identifierFieldOptions_().map(function (f) { return f.key; });
  mergeReport_(rep, validateUrlConfig_(urlCfg, fields));
  if (cfg.slackUserIdField && fields.indexOf(cfg.slackUserIdField) < 0) rep.warnings.push('The Slack user ID field "' + cfg.slackUserIdField + '" no longer exists.');
  if (!cfg.teamIds.length) rep.warnings.push('No teams are selected in Configure Payload Generation.');
  var teamIds = listTeams_().map(function (t) { return t.teamId; });
  cfg.teamIds.forEach(function (t) { if (teamIds.indexOf(t) < 0) rep.warnings.push('Configured team ' + t + ' no longer exists.'); });
  if (!getSheet_(T_SLACK_PAYLOADS.sheet)) { rep.info.push('No payloads generated yet.'); return rep; }
  var rows = readTable_(T_SLACK_PAYLOADS).rows;
  var byStatus = {}, stale = 0, invalid = 0, gens = {};
  var current = {};
  readAllScheduleRecords_().records.forEach(function (r) { current[r.recordKey] = r; });
  rows.forEach(function (r) {
    var st = str_(r.payloadStatus) || 'OK';
    byStatus[st] = (byStatus[st] || 0) + 1;
    gens[str_(r.generationId)] = true;
    var url = str_(r.dashboardUrl);
    if (url && validateGeneratedUrl_(url).status === 'INVALID') invalid++;
    var src = current[str_(r.sourceRecordKey)];
    if (!src || src.recordStatus !== RECORD_STATUS.ACTIVE || (str_(r.sourceImportId) && src.lastImportId !== str_(r.sourceImportId))) stale++;
  });
  rep.info.push(rows.length + ' payload record(s) in ' + Object.keys(gens).length + ' generation(s). Status: ' +
    Object.keys(byStatus).map(function (k) { return k + ' ' + byStatus[k]; }).join(', ') + '.');
  if (invalid) rep.fatal.push(invalid + ' stored payload URL(s) are invalid.');
  if (stale) rep.warnings.push(stale + ' payload record(s) refer to schedule records that were removed or changed by a later import. Generate the payloads again (Replace mode).');
  ['MISSING_DASHBOARD_ID', 'UNRESOLVED_EMPLOYEE', 'NOT_TEAM_MEMBER', 'INVALID_URL'].forEach(function (s) {
    if (byStatus[s]) rep.warnings.push(byStatus[s] + ' payload record(s) have status ' + s + '.');
  });
  return rep;
}

/* ------------------------------------------------------------------------ */
/* Client API (SlackDialog.html)                                             */
/* ------------------------------------------------------------------------ */

function apiSlackBootstrap() {
  return apiCall_('apiSlackBootstrap', function () {
    requireInitialized_();
    var known = getKnownShiftTypes_();
    listTeams_().forEach(function (t) { known = uniq_(known.concat(t.settings.import.knownShiftTypes)); });
    return {
      payloadConfig: loadPayloadConfig_(), urlConfig: loadUrlConfig_(),
      teams: listTeams_().map(function (t) { return { teamId: t.teamId, teamName: t.teamName, status: t.status }; }),
      identifierFields: identifierFieldOptions_(), knownActivityTypes: known.sort(),
      groupFields: GROUP_FIELDS, dateModes: PAYLOAD_DATE_MODES, policies: MISSING_ID_POLICIES, encodings: URL_ENCODINGS,
      urlPlaceholders: URL_PLACEHOLDERS, linePlaceholders: LINE_PLACEHOLDERS, displayPlaceholders: DISPLAY_PLACEHOLDERS,
      today: todayIso_(getConfig_().TIMEZONE)
    };
  });
}

function apiSlackSaveConfig(input) {
  return apiCall_('apiSlackSaveConfig', function () {
    requireInitialized_();
    var cfg = normalizePayloadConfig_(input);
    var rep = newReport_();
    if (!cfg.teamIds.length) rep.fatal.push('Select at least one team.');
    if ((cfg.dateMode === 'DATE' || cfg.dateMode === 'RANGE') && !cfg.dateFrom) rep.fatal.push('Choose the date.');
    if (cfg.dateMode === 'RANGE' && (!cfg.dateTo || cfg.dateTo < cfg.dateFrom)) rep.fatal.push('The end date must be on or after the start date.');
    if (cfg.dateMode === 'RANGE' && cfg.dateTo && dayNumber_(cfg.dateTo) - dayNumber_(cfg.dateFrom) + 1 > MAX_PAYLOAD_DAYS_) rep.fatal.push('The range may be at most ' + MAX_PAYLOAD_DAYS_ + ' days.');
    renderTemplate_(cfg.displayTemplate, {}, DISPLAY_PLACEHOLDERS).unknown.forEach(function (u) { rep.fatal.push('Display template: unsupported {' + u + '}.'); });
    renderTemplate_(cfg.lineTemplate, {}, LINE_PLACEHOLDERS).unknown.forEach(function (u) { rep.fatal.push('Line template: unsupported {' + u + '}.'); });
    var fields = identifierFieldOptions_().map(function (f) { return f.key; });
    if (cfg.slackUserIdField && fields.indexOf(cfg.slackUserIdField) < 0) rep.fatal.push('The Slack user ID field does not exist.');
    if (rep.fatal.length) fail_('VALIDATION', rep.fatal.join(' '), rep);
    return withLock_(function () { setConfigValues_({ SLACK_PAYLOAD_CONFIG: JSON.stringify(cfg) }); return cfg; });
  });
}

function apiSlackSaveUrlConfig(input) {
  return apiCall_('apiSlackSaveUrlConfig', function () {
    requireInitialized_();
    var cfg = normalizeUrlConfig_(input);
    var rep = validateUrlConfig_(cfg, identifierFieldOptions_().map(function (f) { return f.key; }));
    if (rep.fatal.length) fail_('VALIDATION', rep.fatal.join(' '), rep);
    return withLock_(function () { setConfigValues_({ DASHBOARD_URL_CONFIG: JSON.stringify(cfg) }); return { config: cfg, report: rep }; });
  });
}

/** URL preview with the same function the generator uses (unsaved settings allowed). */
function apiSlackPreviewUrl(input, sample) {
  return apiCall_('apiSlackPreviewUrl', function () {
    var cfg = normalizeUrlConfig_(input);
    var s = sample || {};
    var result = buildDashboardUrl_(cfg, { identifier: s.identifier, employeeName: s.employeeName, teamId: s.teamId, teamName: s.teamName,
      date: s.date, startTime: s.startTime, endTime: s.endTime });
    var check = validateUrlConfig_(cfg, identifierFieldOptions_().map(function (f) { return f.key; }));
    return { result: result, report: check };
  });
}

/** Dry run: what Generate would produce now (nothing is written). */
function apiSlackPreview(override) {
  return apiCall_('apiSlackPreview', function () {
    requireInitialized_();
    return summaryForClient_(preparePayloadRun_(override || null));
  });
}

/** Generates payloads. Refuses if the result differs from the reviewed preview (token). */
function apiSlackGenerate(override, token, confirmDuplicate) {
  return apiCall_('apiSlackGenerate', function () {
    requireInitialized_();
    return withLock_(function () {
      var plan = preparePayloadRun_(override || null);
      if (plan.token !== token) {
        return { status: 'CHANGED', preview: summaryForClient_(plan), message: 'The schedule data or the configuration changed since the preview. Review the new preview and generate again.' };
      }
      if (plan.report.fatal.length) fail_('BLOCKED', plan.report.fatal.join(' '), plan.report);
      if (!plan.records.length) fail_('BLOCKED', 'No payload records to generate for this scope.');
      var duplicate = plan.report.warnings.some(function (w) { return /^Identical payloads/.test(w); });
      if (duplicate && plan.cfg.outputMode === 'APPEND' && !confirmDuplicate) {
        fail_('DUPLICATE', 'Identical payloads were already generated. Tick "Generate anyway" to append another copy, or use Replace mode.');
      }
      var w = writePayloads_(plan);
      return { status: 'GENERATED', generationId: plan.generationId, written: w.written, removed: w.removed, summary: plan.summary, report: plan.report,
        employees: payloadEmployeeCount_(plan.records), outputMode: plan.cfg.outputMode, range: plan.range };
    }, 60000);
  });
}

/** Shows and activates the _SLACK_PAYLOADS sheet (v1.1.2, "Open generated payloads"). */
function apiSlackOpenPayloadSheet() {
  return apiCall_('apiSlackOpenPayloadSheet', function () {
    requireInitialized_();
    var sh = requireSheet_(T_SLACK_PAYLOADS.sheet, 'Run Setup / Configure Spreadsheet → Upgrade.');
    if (sh.isSheetHidden()) sh.showSheet();
    sh.activate();
    return { sheet: sh.getName() };
  });
}

function apiValidatePayloads() {
  return apiCall_('apiValidatePayloads', function () { requireInitialized_(); return validatePayloads_(); });
}
