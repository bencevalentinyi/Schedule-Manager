/**
 * MonitoringLinkService.gs
 * Monitoring links: dashboard URLs filled with the IDs of the employees who are working.
 *
 * A link template is configuration, stored in the spreadsheet (_CONFIG key LINK_TEMPLATES),
 * never in code: base URL, which staff column holds the platform ID (e.g. "Aircall ID"),
 * separator, optional text before/after each ID, URL encoding, max IDs per link, teams and
 * "who" (working now / at a time / during a window / the whole day).
 *
 * Generated links are written to the "Monitoring Links" sheet (themed); people without an ID
 * in the chosen column are listed, never dropped silently.
 *
 * Dependencies: Schema.gs, Utils.gs, ConfigService.gs, TeamService.gs, StaffService.gs,
 *   StaffFieldService.gs, ScheduleService.gs
 */

var LINK_WHO = {
  NOW: 'Working now',
  AT: 'Working at a time',
  WINDOW: 'Working during a window',
  DAY: 'Working that day'
};
var LINKS_SHEET_ = 'Monitoring Links';

/* ------------------------------------------------------------------------ */
/* Templates (pure normalization + storage)                                  */
/* ------------------------------------------------------------------------ */

/** A template with defaults and types fixed. Pure. */
function normalizeLinkTemplate_(t) {
  t = t || {};
  var max = Math.floor(toNumber_(t.maxPerLink, 0));
  return {
    id: str_(t.id),
    name: str_(t.name).substr(0, 80),
    baseUrl: str_(t.baseUrl),
    idField: str_(t.idField) || 'employeeId',
    separator: t.separator === undefined || t.separator === null ? ',' : String(t.separator),
    prefix: t.prefix === undefined || t.prefix === null ? '' : String(t.prefix),
    suffix: t.suffix === undefined || t.suffix === null ? '' : String(t.suffix),
    encode: t.encode === undefined ? true : !!t.encode,
    maxPerLink: max > 0 ? max : 0,
    teamIds: (Array.isArray(t.teamIds) ? t.teamIds : []).map(str_).filter(Boolean),
    who: LINK_WHO[t.who] ? t.who : 'NOW',
    at: str_(t.at) || '12:00',
    from: str_(t.from) || '08:00',
    to: str_(t.to) || '16:00',
    excludeMeetings: !!t.excludeMeetings
  };
}

/** Validation messages for a template (empty list = valid). Pure. */
function validateLinkTemplate_(t, idFieldKeys) {
  var errs = [];
  if (!t.name) errs.push('Enter a name.');
  if (!/^https?:\/\/\S+$/i.test(t.baseUrl)) errs.push('The base URL must start with http:// or https:// and contain no spaces.');
  if (idFieldKeys && idFieldKeys.indexOf(t.idField) < 0) errs.push('The ID column "' + t.idField + '" is not a staff column.');
  if (t.who === 'AT' && hmToMinutes_(t.at) === null) errs.push('Enter the time as HH:mm.');
  if (t.who === 'WINDOW') {
    var f = hmToMinutes_(t.from), to = hmToMinutes_(t.to);
    if (f === null || to === null) errs.push('Enter the window as HH:mm – HH:mm.');
    else if (to <= f) errs.push('The window must end after it starts.');
  }
  return errs;
}

function loadLinkTemplates_() {
  var list = parseJson_(getConfig_().LINK_TEMPLATES, []);
  return (Array.isArray(list) ? list : []).map(normalizeLinkTemplate_).filter(function (t) { return t.id; });
}

function saveLinkTemplates_(list) {
  setConfigValues_({ LINK_TEMPLATES: JSON.stringify(list) });
}

/* ------------------------------------------------------------------------ */
/* Who is working (pure)                                                     */
/* ------------------------------------------------------------------------ */

/**
 * The people working, from stored schedule records. Pure.
 * @param {Object[]} records ACTIVE/REMOVED records of the teams (the date and the day before)
 * @param {{date: string, who: string, atMin?: number, fromMin?: number, toMin?: number, excludeMeetings?: boolean}} opts
 *   atMin/fromMin/toMin are minutes from 00:00 of the date
 * @return {Array<{identity, teamId, employeeId, employeeName, startAbs, rec}>} one entry per person, by start time
 */
function selectWorking_(records, opts) {
  var base = dayNumber_(opts.date) * 1440;
  var active = records.filter(function (r) {
    return r.recordStatus === RECORD_STATUS.ACTIVE && isIsoDateTime_(r.shiftStart) && isIsoDateTime_(r.shiftEnd);
  });
  var span = function (r) { return { s: wallMinutes_(r.shiftStart), e: wallMinutes_(r.shiftEnd) }; };
  var test;
  if (opts.who === 'DAY') {
    test = function (s) { return s.s < base + 1440 && s.e > base; };
  } else if (opts.who === 'WINDOW') {
    test = function (s) { return s.s < base + opts.toMin && s.e > base + opts.fromMin; };
  } else {
    var at = base + opts.atMin;
    test = function (s) { return s.s <= at && s.e > at; };
  }
  var inMeeting = {};
  if (opts.excludeMeetings && opts.who !== 'DAY' && opts.who !== 'WINDOW') {
    active.forEach(function (r) {
      if (activityCategoryOf_(r) === ACTIVITY_CATEGORY.MEETING && test(span(r))) inMeeting[employeeIdentity_(r)] = true;
    });
  }
  var people = {};
  active.forEach(function (r) {
    if (activityCategoryOf_(r) !== ACTIVITY_CATEGORY.SHIFT) return;
    var s = span(r);
    if (!test(s)) return;
    var id = employeeIdentity_(r);
    if (inMeeting[id]) return;
    if (!people[id] || s.s < people[id].startAbs) {
      people[id] = { identity: id, teamId: r.teamId, employeeId: r.employeeId, employeeName: r.employeeName, startAbs: s.s, rec: r };
    }
  });
  return Object.keys(people).map(function (k) { return people[k]; })
    .sort(function (a, b) { return a.startAbs - b.startAbs || str_(a.employeeName).localeCompare(str_(b.employeeName)); });
}

/* ------------------------------------------------------------------------ */
/* URL building (pure)                                                       */
/* ------------------------------------------------------------------------ */

/**
 * Builds the link(s) for a list of platform IDs, exactly as configured. Pure.
 * "{IDS}" in the base URL is replaced by the joined IDs; without it they are appended at the end.
 * @return {string[]} one URL per chunk of maxPerLink IDs (one URL when there is no limit)
 */
function buildMonitoringUrls_(t, ids) {
  var unique = [];
  ids.forEach(function (id) { if (id && unique.indexOf(id) < 0) unique.push(id); });
  if (!unique.length) return [];
  var size = t.maxPerLink > 0 ? t.maxPerLink : unique.length;
  var urls = [];
  for (var i = 0; i < unique.length; i += size) {
    var joined = unique.slice(i, i + size).map(function (id) {
      return t.prefix + (t.encode ? encodeURIComponent(id) : id) + t.suffix;
    }).join(t.separator);
    urls.push(t.baseUrl.indexOf('{IDS}') >= 0 ? t.baseUrl.split('{IDS}').join(joined) : t.baseUrl + joined);
  }
  return urls;
}

/* ------------------------------------------------------------------------ */
/* Generation (reads the spreadsheet)                                        */
/* ------------------------------------------------------------------------ */

/** Staff columns that can hold a platform ID: Employee ID and every custom staff column. */
function linkIdFieldOptions_() {
  var opts = [{ key: 'employeeId', label: 'Employee ID' }];
  listStaffFields_().forEach(function (f) { opts.push({ key: STAFF_REGISTRY_PREFIX + f.fieldKey, label: f.displayName }); });
  return opts;
}

/** Date/time context for a run: date (yyyy-MM-dd) and "now" in minutes from 00:00, in the configured time zone. */
function linkRunContext_(dateIso) {
  var tz = getConfig_().TIMEZONE;
  var now = new Date();
  var today = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  var nowMin = hmToMinutes_(Utilities.formatDate(now, tz, 'HH:mm'));
  return { date: dateIso || today, today: today, nowMin: nowMin };
}

/**
 * Builds the result of one template: the links, who is in them and who is missing an ID.
 * @return {{template, label, date, whenLabel, urls: string[], people: number, withId: number,
 *   missing: string[], teams: string[]}}
 */
function generateLink_(t, ctx, teamsById, staffCache) {
  var teamIds = t.teamIds.length ? t.teamIds.filter(function (id) { return teamsById[id]; })
    : Object.keys(teamsById).filter(function (id) { return teamsById[id].active; });
  var prev = isoFromDayNumber_(dayNumber_(ctx.date) - 1);
  var records = teamIds.length ? queryScheduleRecords_({ teamIds: teamIds, dates: [prev, ctx.date] }) : [];
  var atMin = t.who === 'NOW' ? ctx.nowMin : hmToMinutes_(t.at);
  var people = selectWorking_(records, { date: ctx.date, who: t.who, atMin: atMin, fromMin: hmToMinutes_(t.from), toMin: hmToMinutes_(t.to), excludeMeetings: t.excludeMeetings });
  var ids = [], missing = [];
  people.forEach(function (p) {
    var team = teamsById[p.teamId];
    if (!staffCache[p.teamId]) {
      var st = null;
      try { st = readStaff_(team); } catch (e) { logError_('generateLink_', e); }
      staffCache[p.teamId] = st ? { st: st, index: buildStaffIndex_(st.rows) } : { st: null, index: null };
    }
    var c = staffCache[p.teamId];
    var m = matchEmployee_(c.index, p.employeeId, p.employeeName, getConfig_().NAME_MATCH_STRATEGY);
    var id = !m.staff ? '' : t.idField === 'employeeId' ? str_(m.staff.employeeId) : str_(m.staff.fields[t.idField]);
    if (id) ids.push(id); else missing.push(p.employeeName || p.employeeId);
  });
  var whenLabel = t.who === 'NOW' ? 'now (' + minutesToHm_(ctx.nowMin) + ')' : t.who === 'AT' ? 'at ' + t.at
    : t.who === 'WINDOW' ? t.from + '–' + t.to : 'whole day';
  return {
    template: t, date: ctx.date, whenLabel: whenLabel + (t.excludeMeetings && (t.who === 'NOW' || t.who === 'AT') ? ', not in a meeting' : ''),
    urls: buildMonitoringUrls_(t, ids), people: people.length, withId: uniq_(ids).length, missing: missing,
    teams: teamIds.map(function (id) { return teamsById[id].teamName; })
  };
}

function teamsByIdForLinks_() {
  var m = {};
  listTeams_().forEach(function (t) { if (t.status === TEAM_STATUS.READY) m[t.teamId] = t; });
  return m;
}

/** Writes every result to the "Monitoring Links" sheet (rebuilt each time) in the active theme. */
function writeLinksSheet_(results) {
  var ss = getSs_();
  var sh = ss.getSheetByName(LINKS_SHEET_) || ss.insertSheet(LINKS_SHEET_);
  var th = sheetTheme_();
  sh.clear();
  sh.getRange(1, 1).setValue(LINKS_SHEET_).setFontSize(16).setFontWeight('bold').setFontColor(th.accent);
  sh.getRange(2, 1).setValue('Generated ' + Utilities.formatDate(new Date(), getTz_(), 'yyyy-MM-dd HH:mm') +
    ' · Schedule Manager → Schedule Management → Monitoring Links → Generate all links').setFontColor('#5f6368');
  var header = ['Link', 'Teams', 'Date', 'Who', 'Agents', 'Open', 'URL', 'Missing ID'];
  var H = 4;
  sh.getRange(H, 1, 1, header.length).setValues([header]).setFontWeight('bold').setBackground(th.header).setFontColor(th.headerText);
  var rows = [], links = [];
  results.forEach(function (r) {
    var urls = r.urls.length ? r.urls : [''];
    urls.forEach(function (u, i) {
      rows.push([safeCell_(r.template.name) + (urls.length > 1 ? ' (' + (i + 1) + '/' + urls.length + ')' : ''), safeCell_(r.teams.join(', ')), r.date,
        r.whenLabel, r.withId + (r.missing.length ? ' of ' + r.people : ''), '', u, safeCell_(r.missing.join(', '))]);
      links.push(u);
    });
  });
  if (rows.length) {
    var body = sh.getRange(H + 1, 1, rows.length, header.length);
    body.setNumberFormat('@').setValues(rows).setVerticalAlignment('top');
    // A rich-text link has no length limit, unlike a HYPERLINK formula.
    sh.getRange(H + 1, 6, rows.length, 1).setRichTextValues(links.map(function (u) {
      return [u ? SpreadsheetApp.newRichTextValue().setText('Open').setLinkUrl(u).build() : SpreadsheetApp.newRichTextValue().setText('No one with an ID').build()];
    }));
    sh.getRange(H + 1, 7, rows.length, 1).setWrap(false);
    sh.getRange(H + 1, 8, rows.length, 1).setWrap(true);
  } else {
    sh.getRange(H + 1, 1).setValue('No link templates yet. Add one under Schedule Management → Monitoring Links.');
  }
  sh.setFrozenRows(H);
  [200, 160, 90, 150, 70, 70, 360, 260].forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  sh.setTabColor(th.accent);
  applySheetFont_(sh, th);
  return sh;
}

/* ------------------------------------------------------------------------ */
/* Client API                                                                */
/* ------------------------------------------------------------------------ */

function apiLinksBootstrap() {
  return apiCall_('apiLinksBootstrap', function () {
    requireInitialized_();
    var teams = teamsByIdForLinks_();
    var ctx = linkRunContext_('');
    return {
      templates: loadLinkTemplates_(),
      idFields: linkIdFieldOptions_(),
      teams: Object.keys(teams).map(function (k) { return { teamId: k, teamName: teams[k].teamName, active: teams[k].active }; }),
      who: LINK_WHO,
      today: ctx.today
    };
  });
}

function apiLinksSave(input) {
  return apiCall_('apiLinksSave', function () {
    requireInitialized_();
    return withLock_(function () {
      var t = normalizeLinkTemplate_(input);
      var errs = validateLinkTemplate_(t, linkIdFieldOptions_().map(function (f) { return f.key; }));
      if (errs.length) fail_('VALIDATION', errs.join(' '));
      var list = loadLinkTemplates_();
      if (!t.id) t.id = newId_('LNK');
      var i = list.map(function (x) { return x.id; }).indexOf(t.id);
      if (i >= 0) list[i] = t; else list.push(t);
      saveLinkTemplates_(list);
      return { template: t, templates: list };
    });
  });
}

function apiLinksDelete(id) {
  return apiCall_('apiLinksDelete', function () {
    requireInitialized_();
    return withLock_(function () {
      var list = loadLinkTemplates_().filter(function (t) { return t.id !== id; });
      saveLinkTemplates_(list);
      return { templates: list };
    });
  });
}

/** Builds the link(s) of one (possibly unsaved) template without writing anything. */
function apiLinksPreview(input, dateIso) {
  return apiCall_('apiLinksPreview', function () {
    requireInitialized_();
    var t = normalizeLinkTemplate_(input);
    var errs = validateLinkTemplate_(t, linkIdFieldOptions_().map(function (f) { return f.key; }));
    if (errs.length) fail_('VALIDATION', errs.join(' '));
    var r = generateLink_(t, linkRunContext_(dateIso), teamsByIdForLinks_(), {});
    return { urls: r.urls, people: r.people, withId: r.withId, missing: r.missing, teams: r.teams, whenLabel: r.whenLabel, date: r.date };
  });
}

/** Generates every saved template and writes the "Monitoring Links" sheet. */
function apiLinksGenerateAll(dateIso) {
  return apiCall_('apiLinksGenerateAll', function () {
    requireInitialized_();
    return withLock_(function () {
      var ctx = linkRunContext_(dateIso);
      var teams = teamsByIdForLinks_(), cache = {};
      var results = loadLinkTemplates_().map(function (t) { return generateLink_(t, ctx, teams, cache); });
      var sh = writeLinksSheet_(results);
      return {
        sheet: sh.getName(), links: results.reduce(function (n, r) { return n + r.urls.length; }, 0),
        results: results.map(function (r) { return { name: r.template.name, urls: r.urls.length, people: r.people, withId: r.withId, missing: r.missing.length }; })
      };
    }, 60000);
  });
}

function apiLinksOpenSheet() {
  return apiCall_('apiLinksOpenSheet', function () {
    var sh = getSs_().getSheetByName(LINKS_SHEET_);
    if (!sh) fail_('NOT_FOUND', 'The Monitoring Links sheet does not exist yet. Click "Generate all links" first.');
    sh.activate();
    return true;
  });
}
