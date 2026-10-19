/**
 * MonitoringLinkService.gs
 * The "Monitoring Links" sheet: monitoring links and daily list plans that a Slack Workflow
 * (or a person) reads. Each saved item is one row, looked up by its Name.
 *
 *  - LINK: a dashboard URL filled with the IDs of the employees who are working. Base URL,
 *    the staff column holding the platform ID (e.g. "Aircall ID"), separator, optional text
 *    before/after each ID, URL encoding, max IDs per link.
 *  - PLAN: a text list built from the schedule ("08:00 - 16:00 Ann Lee"), one line per shift
 *    and/or meeting, with a configurable line format ({START} {END} {NAME} {TYPE} {TEAM} {ID} {ROLE} {TAGS}),
 *    in sections by the staff sheet's Role column (own headings, e.g. shift leads first), with extra
 *    text by time (e.g. ":aircall:" for everyone working during 08:00–14:00).
 *
 * Both have teams and "who" (working now / at a time / during a window / the whole day).
 * Items are configuration stored in the spreadsheet (_CONFIG key LINK_TEMPLATES), never in
 * code, in the order shown in the dialog; that order is also the row order of the sheet.
 *
 * Sheet layout (Slack-readable): column names in row 1, then one row per item:
 *   Name | Kind | Date | Updated | Count | Missing | Text | URL | URL 2 | ...
 * generateMonitoringLinks() rebuilds it and is meant for a time-driven trigger that the
 * administrator adds (Apps Script → Triggers); the code never creates triggers.
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
var LINK_KINDS = { LINK: 'Monitoring link', PLAN: 'Daily list plan' };
var PLAN_INCLUDE = { SHIFTS: 'Shifts', MEETINGS: 'Meetings and trainings', BOTH: 'Shifts, meetings and trainings' };
/** Extra text by time: when a line's shift matches, the text is added after the name (or at {TAGS}). */
var PLAN_TAG_MODES = {
  OVERLAPS: 'Works during part of',
  COVERS: 'Works the whole window',
  STARTS_BEFORE: 'Starts before',
  STARTS_FROM: 'Starts at or after',
  ENDS_AFTER: 'Ends after'
};
var PLAN_TAG_WINDOW_MODES_ = ['OVERLAPS', 'COVERS'];

/** Splits a role list ("A, B" or an array) into clean role names. Pure. */
function planRoleList_(v) {
  return (Array.isArray(v) ? v : splitList_(v)).map(function (r) { return str_(r).replace(/\s+/g, ' '); }).filter(Boolean);
}

/**
 * Plan sections from a stored item: [{heading, roles}], whether everyone else is listed (and its
 * heading), and roles to leave out. Older items (roles + roleMode + roleHeadings) are converted. Pure.
 */
function planSections_(t) {
  if (Array.isArray(t.sections)) {
    return {
      sections: t.sections.map(function (s) { s = s || {}; return { heading: str_(s.heading), roles: planRoleList_(s.roles) }; })
        .filter(function (s) { return s.roles.length || s.heading; }),
      showRest: t.showRest === undefined ? true : !!t.showRest,
      restHeading: str_(t.restHeading),
      excludeRoles: planRoleList_(t.excludeRoles)
    };
  }
  var roles = planRoleList_(t.roles), mode = t.roleMode || 'FIRST', heads = !!t.roleHeadings;
  if (mode === 'EXCEPT') return { sections: [], showRest: true, restHeading: '', excludeRoles: roles };
  return {
    sections: roles.map(function (r) { return { heading: heads ? r : '', roles: [r] }; }),
    showRest: mode !== 'ONLY',
    restHeading: heads ? str_(t.restHeading === undefined ? 'Others' : t.restHeading) : '',
    excludeRoles: []
  };
}
var PLAN_DEFAULT_LINE_ = '{START} - {END} {NAME}';
var LINKS_SHEET_ = 'Monitoring Links';

/* ------------------------------------------------------------------------ */
/* Items (pure normalization + storage)                                      */
/* ------------------------------------------------------------------------ */

/** An item (link or plan) with defaults and types fixed. Pure. */
function normalizeLinkTemplate_(t) {
  t = t || {};
  var max = Math.floor(toNumber_(t.maxPerLink, 0));
  var text = function (v, dflt) { return v === undefined || v === null ? dflt : String(v); };
  var sec = planSections_(t);
  return {
    id: str_(t.id),
    kind: LINK_KINDS[t.kind] ? t.kind : 'LINK',
    name: str_(t.name).substr(0, 80),
    // link
    baseUrl: str_(t.baseUrl),
    separator: text(t.separator, ','),
    prefix: text(t.prefix, ''),
    suffix: text(t.suffix, ''),
    encode: t.encode === undefined ? true : !!t.encode,
    maxPerLink: max > 0 ? max : 0,
    // plan
    include: PLAN_INCLUDE[t.include] ? t.include : 'SHIFTS',
    lineTemplate: text(t.lineTemplate, '') || PLAN_DEFAULT_LINE_,
    groupByTeam: !!t.groupByTeam,
    emptyText: text(t.emptyText, 'No one scheduled'),
    sections: sec.sections,
    showRest: sec.showRest,
    restHeading: sec.restHeading,
    excludeRoles: sec.excludeRoles,
    tags: (Array.isArray(t.tags) ? t.tags : []).map(function (g) {
      g = g || {};
      return { text: str_(g.text), mode: PLAN_TAG_MODES[g.mode] ? g.mode : 'OVERLAPS', from: str_(g.from) || '08:00', to: str_(g.to) || '14:00' };
    }).filter(function (g) { return g.text; }),
    // both
    idField: str_(t.idField) || 'employeeId',
    teamIds: (Array.isArray(t.teamIds) ? t.teamIds : []).map(str_).filter(Boolean),
    who: LINK_WHO[t.who] ? t.who : (t.kind === 'PLAN' ? 'DAY' : 'NOW'),
    at: str_(t.at) || '12:00',
    from: str_(t.from) || '08:00',
    to: str_(t.to) || '16:00',
    excludeMeetings: !!t.excludeMeetings
  };
}

/** Validation messages for an item (empty list = valid). Pure. */
function validateLinkTemplate_(t, idFieldKeys, otherNames) {
  var errs = [];
  if (!t.name) errs.push('Enter a name.');
  else if ((otherNames || []).some(function (n) { return normName_(n) === normName_(t.name); })) errs.push('The name "' + t.name + '" is already used; Slack looks rows up by name, so names must be unique.');
  if (t.kind === 'LINK' && !/^https?:\/\/\S+$/i.test(t.baseUrl)) errs.push('The base URL must start with http:// or https:// and contain no spaces.');
  if (t.kind === 'PLAN' && !t.lineTemplate.trim()) errs.push('Enter the line format.');
  var usesId = t.kind === 'LINK' || t.lineTemplate.indexOf('{ID}') >= 0;
  if (usesId && idFieldKeys && idFieldKeys.indexOf(t.idField) < 0) errs.push('The ID column "' + t.idField + '" is not a staff column.');
  if (t.who === 'AT' && hmToMinutes_(t.at) === null) errs.push('Enter the time as HH:mm.');
  (t.tags || []).forEach(function (g) {
    var isWindow = PLAN_TAG_WINDOW_MODES_.indexOf(g.mode) >= 0;
    if (hmToMinutes_(g.from) === null || (isWindow && hmToMinutes_(g.to) === null)) errs.push('Extra text "' + g.text + '": enter the time(s) as HH:mm.');
    else if (isWindow && hmToMinutes_(g.to) <= hmToMinutes_(g.from)) errs.push('Extra text "' + g.text + '": the window must end after it starts.');
  });
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

/** Moves the item with this id by delta places (-1 up, +1 down). Pure; returns a new list. */
function moveLinkTemplate_(list, id, delta) {
  var out = list.slice();
  var i = out.map(function (t) { return t.id; }).indexOf(id);
  var j = i + delta;
  if (i < 0 || j < 0 || j >= out.length) return out;
  var x = out[i]; out[i] = out[j]; out[j] = x;
  return out;
}

/* ------------------------------------------------------------------------ */
/* Who is working (pure)                                                     */
/* ------------------------------------------------------------------------ */

/** The time test of "who" for a date: function({s, e}) in absolute minutes. Pure. */
function linkTimeTest_(opts) {
  var base = dayNumber_(opts.date) * 1440;
  if (opts.who === 'DAY') return function (x) { return x.s < base + 1440 && x.e > base; };
  if (opts.who === 'WINDOW') return function (x) { return x.s < base + opts.toMin && x.e > base + opts.fromMin; };
  var at = base + opts.atMin;
  return function (x) { return x.s <= at && x.e > at; };
}

/**
 * Every assignment (shift and/or meeting) that matches the time test, sorted by start. Pure.
 * @param {{date, who, atMin?, fromMin?, toMin?, excludeMeetings?, include?: 'SHIFTS'|'MEETINGS'|'BOTH'}} opts
 * @return {Array<{rec, s, e, category, identity}>}
 */
function selectAssignments_(records, opts) {
  var test = linkTimeTest_(opts);
  var include = opts.include || 'SHIFTS';
  var items = records.filter(function (r) {
    return r.recordStatus === RECORD_STATUS.ACTIVE && isIsoDateTime_(r.shiftStart) && isIsoDateTime_(r.shiftEnd);
  }).map(function (r) {
    return { rec: r, s: wallMinutes_(r.shiftStart), e: wallMinutes_(r.shiftEnd), category: activityCategoryOf_(r), identity: employeeIdentity_(r) };
  }).filter(function (x) { return test(x); });
  var inMeeting = {};
  if (opts.excludeMeetings && (opts.who === 'NOW' || opts.who === 'AT')) {
    items.forEach(function (x) { if (x.category === ACTIVITY_CATEGORY.MEETING) inMeeting[x.identity] = true; });
  }
  return items.filter(function (x) {
    if (inMeeting[x.identity] && x.category === ACTIVITY_CATEGORY.SHIFT) return false;
    if (include === 'SHIFTS') return x.category === ACTIVITY_CATEGORY.SHIFT;
    if (include === 'MEETINGS') return x.category === ACTIVITY_CATEGORY.MEETING;
    return true;
  }).sort(function (a, b) { return a.s - b.s || a.e - b.e || str_(a.rec.employeeName).localeCompare(str_(b.rec.employeeName)); });
}

/**
 * The people working (one entry per person, earliest shift first), from stored records. Pure.
 * @return {Array<{identity, teamId, employeeId, employeeName, startAbs, rec}>}
 */
function selectWorking_(records, opts) {
  var seen = {}, out = [];
  selectAssignments_(records, { date: opts.date, who: opts.who, atMin: opts.atMin, fromMin: opts.fromMin, toMin: opts.toMin,
    excludeMeetings: opts.excludeMeetings, include: 'SHIFTS' }).forEach(function (x) {
    if (seen[x.identity]) return;
    seen[x.identity] = true;
    out.push({ identity: x.identity, teamId: x.rec.teamId, employeeId: x.rec.employeeId, employeeName: x.rec.employeeName, startAbs: x.s, rec: x.rec });
  });
  return out;
}

/* ------------------------------------------------------------------------ */
/* Building links and plans (pure)                                           */
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

/**
 * Puts the assignments into the plan's sections by the staff sheet's Role column. Pure.
 * Each person goes to the first section listing their role (roles match ignoring case and spaces);
 * everyone else follows (or is left out when "everyone else" is off); excluded roles are dropped.
 * Within a section the order stays by start time.
 * @return {Array<{x, rank}>} rank = section index, or the number of sections for everyone else
 */
function orderPlanItems_(t, items, roleOf) {
  var sectionRoles = t.sections.map(function (s) { return s.roles.map(normText_); });
  var excluded = t.excludeRoles.map(normText_);
  var ranked = [];
  items.forEach(function (x, i) {
    var role = normText_(roleOf(x.rec));
    if (role && excluded.indexOf(role) >= 0) return;
    var rank = -1;
    for (var k = 0; k < sectionRoles.length && rank < 0; k++) if (role && sectionRoles[k].indexOf(role) >= 0) rank = k;
    if (rank < 0) { if (!t.showRest) return; rank = sectionRoles.length; }
    ranked.push({ x: x, rank: rank, i: i });
  });
  ranked.sort(function (a, b) { return a.rank - b.rank || a.i - b.i; });
  return ranked;
}

/** The extra texts of the time rules that match one assignment (absolute minutes; base = 00:00 of the date). Pure. */
function planTagsFor_(t, x, base) {
  return t.tags.filter(function (g) {
    var from = base + (hmToMinutes_(g.from) || 0), to = base + (hmToMinutes_(g.to) || 0);
    if (g.mode === 'OVERLAPS') return x.s < to && x.e > from;
    if (g.mode === 'COVERS') return x.s <= from && x.e >= to;
    if (g.mode === 'STARTS_BEFORE') return x.s < from;
    if (g.mode === 'STARTS_FROM') return x.s >= from;
    if (g.mode === 'ENDS_AFTER') return x.e > from;
    return false;
  }).map(function (g) { return g.text; });
}

/**
 * The plan text: one line per assignment from the line format, in sections (each with an optional
 * heading), optionally grouped by team; time rules add extra text after the name (or at {TAGS}). Pure.
 * @param {Object} t normalized PLAN item
 * @param {Array} items from selectAssignments_
 * @param {Object} teamNames teamId -> team name
 * @param {function(Object): string} idOf the chosen ID column value of a record's employee ('' if none)
 * @param {function(Object): string=} roleOf the employee's Role from the staff sheet ('' if none)
 * @param {string=} dateIso the plan's date, for the time rules (default: each shift's own day)
 */
function buildPlanText_(t, items, teamNames, idOf, roleOf, dateIso) {
  roleOf = roleOf || function () { return ''; };
  var hm = function (abs) { return minutesToHm_(((abs % 1440) + 1440) % 1440); };
  var hasTagsSlot = t.lineTemplate.indexOf('{TAGS}') >= 0;
  var line = function (x) {
    var r = x.rec;
    var base = dateIso ? dayNumber_(dateIso) * 1440 : Math.floor(x.s / 1440) * 1440;
    var tags = planTagsFor_(t, x, base).join(' ');
    var name = str_(r.employeeName) || str_(r.employeeId);
    var values = { START: hm(x.s), END: hm(x.e), NAME: hasTagsSlot || !tags ? name : name + ' ' + tags,
      TYPE: str_(r.shiftType) || str_(r.activity), TEAM: teamNames[r.teamId] || r.teamId, ID: idOf(r),
      EMPLOYEE_ID: str_(r.employeeId), ROLE: roleOf(r), TAGS: tags };
    return t.lineTemplate.replace(/\{(START|END|NAME|TYPE|TEAM|ID|EMPLOYEE_ID|ROLE|TAGS)\}/g, function (m, k) { return values[k]; })
      .replace(/ {2,}/g, ' ').replace(/^ +| +$/g, '');
  };
  var titleOf = function (rank) { return rank < t.sections.length ? t.sections[rank].heading : t.restHeading; };
  /** Lines of one group, a heading above each section that has one; sections apart by a blank line when headed. */
  var block = function (ranked) {
    var parts = [], cur = null;
    ranked.forEach(function (p) {
      if (!cur || cur.rank !== p.rank) { cur = { rank: p.rank, lines: [] }; parts.push(cur); }
      cur.lines.push(line(p.x));
    });
    var headed = parts.some(function (s) { return titleOf(s.rank); });
    return parts.map(function (s) { return (titleOf(s.rank) ? titleOf(s.rank) + '\n' : '') + s.lines.join('\n'); }).join(headed ? '\n\n' : '\n');
  };
  var ranked = orderPlanItems_(t, items, roleOf);
  if (!ranked.length) return t.emptyText;
  if (!t.groupByTeam) return block(ranked);
  var order = [], groups = {};
  ranked.forEach(function (p) {
    var k = p.x.rec.teamId;
    if (!groups[k]) { groups[k] = []; order.push(k); }
    groups[k].push(p);
  });
  return order.map(function (k) { return (teamNames[k] || k) + '\n' + block(groups[k]); }).join('\n\n');
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
  return { date: dateIso || today, today: today, nowMin: nowMin, updated: Utilities.formatDate(now, tz, 'yyyy-MM-dd HH:mm') };
}

function teamsByIdForLinks_() {
  var m = {};
  listTeams_().forEach(function (t) { if (t.status === TEAM_STATUS.READY) m[t.teamId] = t; });
  return m;
}

/** Looks up a record's employee in its team's staff sheet (cached per team) and returns the chosen column. */
function linkIdReader_(idField, teamsById, staffCache) {
  return function (r) {
    var team = teamsById[r.teamId];
    if (!team) return '';
    if (!staffCache[r.teamId]) {
      var st = null;
      try { st = readStaff_(team); } catch (e) { logError_('linkIdReader_', e); }
      staffCache[r.teamId] = st ? buildStaffIndex_(st.rows) : null;
    }
    var m = matchEmployee_(staffCache[r.teamId], r.employeeId, r.employeeName, getConfig_().NAME_MATCH_STRATEGY);
    if (!m.staff) return '';
    return idField === 'employeeId' ? str_(m.staff.employeeId) : str_(m.staff.fields[idField]);
  };
}

/**
 * Builds one item (link or plan) for a run.
 * @return {{template, date, whenLabel, urls: string[], text: string, count: number, people: number, missing: string[], teams: string[]}}
 */
function generateLink_(t, ctx, teamsById, staffCache) {
  var teamIds = t.teamIds.length ? t.teamIds.filter(function (id) { return teamsById[id]; })
    : Object.keys(teamsById).filter(function (id) { return teamsById[id].active; });
  var prev = isoFromDayNumber_(dayNumber_(ctx.date) - 1);
  var records = teamIds.length ? queryScheduleRecords_({ teamIds: teamIds, dates: [prev, ctx.date] }) : [];
  var opts = { date: ctx.date, who: t.who, atMin: t.who === 'NOW' ? ctx.nowMin : hmToMinutes_(t.at),
    fromMin: hmToMinutes_(t.from), toMin: hmToMinutes_(t.to), excludeMeetings: t.excludeMeetings };
  var whenLabel = (t.who === 'NOW' ? 'now (' + minutesToHm_(ctx.nowMin) + ')' : t.who === 'AT' ? 'at ' + t.at
    : t.who === 'WINDOW' ? t.from + '–' + t.to : 'whole day') +
    (t.excludeMeetings && (t.who === 'NOW' || t.who === 'AT') ? ', not in a meeting' : '');
  var idOf = linkIdReader_(t.idField, teamsById, staffCache);
  var res = { template: t, date: ctx.date, whenLabel: whenLabel, urls: [], text: '', count: 0, people: 0, missing: [],
    teams: teamIds.map(function (id) { return teamsById[id].teamName; }) };

  if (t.kind === 'PLAN') {
    opts.include = t.include;
    var items = selectAssignments_(records, opts);
    var names = {};
    teamIds.forEach(function (id) { names[id] = teamsById[id].teamName; });
    var needsId = t.lineTemplate.indexOf('{ID}') >= 0;
    var missing = {};
    var reader = function (r) {
      var v = needsId ? idOf(r) : '';
      if (needsId && !v) missing[str_(r.employeeName) || str_(r.employeeId)] = true;
      return v;
    };
    var roleOf = linkIdReader_('role', teamsById, staffCache); // the staff sheet's Role column
    res.text = buildPlanText_(t, items, names, reader, roleOf, ctx.date);
    var listed = orderPlanItems_(t, items, roleOf).map(function (p) { return p.x; });
    res.count = listed.length;
    res.people = uniq_(listed.map(function (x) { return x.identity; })).length;
    res.missing = Object.keys(missing);
    return res;
  }

  var people = selectWorking_(records, opts);
  var ids = [];
  people.forEach(function (p) {
    var id = idOf(p.rec);
    if (id) ids.push(id); else res.missing.push(p.employeeName || p.employeeId);
  });
  res.urls = buildMonitoringUrls_(t, ids);
  res.people = people.length;
  res.count = uniq_(ids).length;
  res.text = res.count + ' agent(s) working ' + whenLabel;
  return res;
}

/** Sheet rows (row 1 = column names) for generated items, in item order. Pure. */
function linksSheetRows_(results, updated) {
  var urlCols = Math.max(1, results.reduce(function (n, r) { return Math.max(n, r.urls.length); }, 0));
  var header = ['Name', 'Kind', 'Date', 'Updated', 'Count', 'Missing', 'Text', 'URL'];
  for (var i = 2; i <= urlCols; i++) header.push('URL ' + i);
  var rows = results.map(function (r) {
    var row = [r.template.name, r.template.kind === 'PLAN' ? 'Plan' : 'Link', r.date, updated,
      r.template.kind === 'PLAN' ? r.count : r.count + (r.missing.length ? ' of ' + r.people : ''), r.missing.join(', '), r.text];
    for (var j = 0; j < urlCols; j++) row.push(r.urls[j] || '');
    return row;
  });
  return { header: header, rows: rows, urlCols: urlCols };
}

/**
 * Rewrites the "Monitoring Links" sheet: column names in row 1, one row per item in the saved
 * order, so a Slack Workflow can look a row up by Name. URL cells are plain text and clickable.
 */
function writeLinksSheet_(results, updated) {
  var ss = getSs_();
  var sh = ss.getSheetByName(LINKS_SHEET_) || ss.insertSheet(LINKS_SHEET_);
  var th = sheetTheme_();
  var t = linksSheetRows_(results, updated);
  var width = t.header.length;
  sh.clear();
  ensureColumns_(sh, width);
  sh.getRange(1, 1, 1, width).setValues([t.header]).setFontWeight('bold').setBackground(th.header).setFontColor(th.headerText);
  if (t.rows.length) {
    ensureRows_(sh, t.rows.length + 1);
    var body = sh.getRange(2, 1, t.rows.length, width);
    body.setNumberFormat('@').setValues(t.rows.map(function (r) { return r.map(function (v, i) { return i === 0 || i === 6 ? safeCell_(v) : v; }); }))
      .setVerticalAlignment('top');
    // URL cells: the text is the URL itself (what Slack reads) and it is clickable (no HYPERLINK length limit).
    var urlRange = sh.getRange(2, 8, t.rows.length, t.urlCols);
    urlRange.setRichTextValues(t.rows.map(function (r) {
      return r.slice(7).map(function (u) {
        return u ? SpreadsheetApp.newRichTextValue().setText(u).setLinkUrl(u).build() : SpreadsheetApp.newRichTextValue().setText('').build();
      });
    })).setWrap(false);
    sh.getRange(2, 7, t.rows.length, 1).setWrap(true);
    sh.getRange(2, 6, t.rows.length, 1).setWrap(true);
  }
  sh.setFrozenRows(1);
  [200, 60, 90, 120, 70, 200, 320].forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  for (var c = 8; c <= width; c++) sh.setColumnWidth(c, 320);
  sh.setTabColor(th.accent);
  applySheetFont_(sh, th);
  return sh;
}

/** Builds every saved item and rewrites the sheet. Call under lock. */
function generateAllLinks_(dateIso) {
  var ctx = linkRunContext_(dateIso);
  var teams = teamsByIdForLinks_(), cache = {};
  var results = loadLinkTemplates_().map(function (t) { return generateLink_(t, ctx, teams, cache); });
  var sh = writeLinksSheet_(results, ctx.updated);
  return { sheet: sh.getName(), results: results };
}

/**
 * Entry point for a time-driven trigger (Apps Script → Triggers → Add trigger → generateMonitoringLinks,
 * time-driven). Rebuilds every monitoring link and daily list plan for today; "Working now" items
 * use the time the trigger runs. Never shows UI.
 */
function generateMonitoringLinks() {
  try {
    requireInitialized_();
    var r = withLock_(function () { return generateAllLinks_(''); }, 60000);
    console.log('Monitoring Links: ' + r.results.length + ' item(s) written to "' + r.sheet + '".');
    return r.results.length;
  } catch (e) {
    logError_('generateMonitoringLinks', e);
    throw e;
  }
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
      who: LINK_WHO, kinds: LINK_KINDS, include: PLAN_INCLUDE, tagModes: PLAN_TAG_MODES, tagWindowModes: PLAN_TAG_WINDOW_MODES_, defaultLine: PLAN_DEFAULT_LINE_,
      today: ctx.today
    };
  });
}

function apiLinksSave(input) {
  return apiCall_('apiLinksSave', function () {
    requireInitialized_();
    return withLock_(function () {
      var t = normalizeLinkTemplate_(input);
      var list = loadLinkTemplates_();
      var others = list.filter(function (x) { return x.id !== t.id; }).map(function (x) { return x.name; });
      var errs = validateLinkTemplate_(t, linkIdFieldOptions_().map(function (f) { return f.key; }), others);
      if (errs.length) fail_('VALIDATION', errs.join(' '));
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

/** Moves an item up (-1) or down (+1); the order is also the row order of the sheet. */
function apiLinksMove(id, delta) {
  return apiCall_('apiLinksMove', function () {
    requireInitialized_();
    return withLock_(function () {
      var list = moveLinkTemplate_(loadLinkTemplates_(), id, delta < 0 ? -1 : 1);
      saveLinkTemplates_(list);
      return { templates: list };
    });
  });
}

/** Builds one (possibly unsaved) item without writing anything. */
function apiLinksPreview(input, dateIso) {
  return apiCall_('apiLinksPreview', function () {
    requireInitialized_();
    var t = normalizeLinkTemplate_(input);
    var errs = validateLinkTemplate_(t, linkIdFieldOptions_().map(function (f) { return f.key; }), null);
    if (errs.length) fail_('VALIDATION', errs.join(' '));
    var r = generateLink_(t, linkRunContext_(dateIso), teamsByIdForLinks_(), {});
    return { kind: t.kind, urls: r.urls, text: r.text, count: r.count, people: r.people, missing: r.missing, teams: r.teams, whenLabel: r.whenLabel, date: r.date };
  });
}

/** Builds every saved item and rewrites the "Monitoring Links" sheet. */
function apiLinksGenerateAll(dateIso) {
  return apiCall_('apiLinksGenerateAll', function () {
    requireInitialized_();
    return withLock_(function () {
      var r = generateAllLinks_(dateIso);
      return {
        sheet: r.sheet,
        results: r.results.map(function (x) {
          return { name: x.template.name, kind: x.template.kind, urls: x.urls.length, count: x.count, people: x.people, missing: x.missing.length };
        })
      };
    }, 60000);
  });
}

function apiLinksOpenSheet() {
  return apiCall_('apiLinksOpenSheet', function () {
    var sh = getSs_().getSheetByName(LINKS_SHEET_);
    if (!sh) fail_('NOT_FOUND', 'The Monitoring Links sheet does not exist yet. Click "Generate all" first.');
    sh.activate();
    return true;
  });
}
