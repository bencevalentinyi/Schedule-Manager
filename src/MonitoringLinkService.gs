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
 *    text by time (e.g. a marker for everyone working during 08:00–14:00).
 *
 *  - LIST: an agent list, e.g. the Slack IDs of everyone working yesterday / today / tomorrow,
 *    optionally only those NOT working on another day (who to add to / remove from a channel).
 *
 * All have teams and "who" (working now / at a time / during a window / the whole day).
 * Items are configuration stored in the spreadsheet (_CONFIG key LINK_TEMPLATES), never in
 * code, in the order shown in the dialog; that order is also the row order of the sheet.
 *
 * Sheet layout (Slack-readable, LINK_SHEET_SETTINGS): by default ONE ROW: A1 "Key" / A2 "DAILY",
 * B1 "Header_Date" / B2 the date, then one column per item (name in row 1, link or plan text in
 * row 2), so a Slack Workflow selects the row where Key = DAILY. Alternatively one row per item:
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
var LINK_KINDS = { LINK: 'Monitoring link', PLAN: 'Daily list plan', LIST: 'Agent list' };
/** Agent list: the day it lists, relative to the run date, and the day it can be compared with. */
var LIST_DAYS = { YESTERDAY: 'Yesterday', TODAY: 'Today', TOMORROW: 'Tomorrow' };
var LIST_DAY_OFFSETS_ = { YESTERDAY: -1, TODAY: 0, TOMORROW: 1 };
/** Agent list value "Name" (instead of a staff column). */
var LIST_NAME_FIELD_ = 'NAME';
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
      sections: t.sections.map(function (s) { s = s || {}; return { heading: str_(s.heading), roles: planRoleList_(s.roles), noTags: !!s.noTags }; })
        .filter(function (s) { return s.roles.length || s.heading; }),
      showRest: t.showRest === undefined ? true : !!t.showRest,
      restHeading: str_(t.restHeading),
      excludeRoles: planRoleList_(t.excludeRoles)
    };
  }
  var roles = planRoleList_(t.roles), mode = t.roleMode || 'FIRST', heads = !!t.roleHeadings;
  if (mode === 'EXCEPT') return { sections: [], showRest: true, restHeading: '', excludeRoles: roles };
  return {
    sections: roles.map(function (r) { return { heading: heads ? r : '', roles: [r], noTags: false }; }),
    showRest: mode !== 'ONLY',
    restHeading: heads ? str_(t.restHeading === undefined ? 'Others' : t.restHeading) : '',
    excludeRoles: planRoleList_(t.excludeRoles)
  };
}
var PLAN_DEFAULT_LINE_ = '{START} - {END} {NAME}';
var PLAN_SECTION_FIELD_DEFAULT_ = 'role';
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
    // The staff column the sections (and "leave out") match against: Role by default, or Notes, Team, any own column…
    sectionField: str_(t.sectionField) || PLAN_SECTION_FIELD_DEFAULT_,
    tags: (Array.isArray(t.tags) ? t.tags : []).map(function (g) {
      g = g || {};
      return { text: str_(g.text), mode: PLAN_TAG_MODES[g.mode] ? g.mode : 'OVERLAPS', from: str_(g.from) || '08:00', to: str_(g.to) || '14:00' };
    }).filter(function (g) { return g.text; }),
    // both
    idField: str_(t.idField) || 'employeeId',
    teamIds: (Array.isArray(t.teamIds) ? t.teamIds : []).map(str_).filter(Boolean),
    who: LINK_WHO[t.who] ? t.who : (t.kind === 'PLAN' || t.kind === 'LIST' ? 'DAY' : 'NOW'),
    at: str_(t.at) || '12:00',
    from: str_(t.from) || '08:00',
    to: str_(t.to) || '16:00',
    excludeMeetings: !!t.excludeMeetings,
    // Overnight shifts that started the day before ("from previous day") are left out unless ticked.
    includePrevDay: !!t.includePrevDay,
    // agent list
    listDay: LIST_DAYS[t.listDay] ? t.listDay : 'TODAY',
    exceptDay: LIST_DAYS[t.exceptDay] ? t.exceptDay : ''
  };
}

/**
 * Validation messages for an item (empty list = valid). Pure.
 * @param {string[]=} sectionFieldKeys staff columns a plan can be sectioned by (checked when given)
 */
function validateLinkTemplate_(t, idFieldKeys, otherNames, sectionFieldKeys) {
  var errs = [];
  var sectioned = t.kind === 'PLAN' && (t.sections.length || t.excludeRoles.length);
  if (sectioned && sectionFieldKeys && sectionFieldKeys.indexOf(t.sectionField) < 0) errs.push('The section column "' + t.sectionField + '" is not a staff column.');
  if (!t.name) errs.push('Enter a name.');
  else if ((otherNames || []).some(function (n) { return normName_(n) === normName_(t.name); })) errs.push('The name "' + t.name + '" is already used; Slack looks rows up by name, so names must be unique.');
  if (t.kind === 'LINK' && !/^https?:\/\/\S+$/i.test(t.baseUrl)) errs.push('The base URL must start with http:// or https:// and contain no spaces.');
  if (t.kind === 'PLAN' && !t.lineTemplate.trim()) errs.push('Enter the line format.');
  var usesId = t.kind === 'LINK' || (t.kind === 'PLAN' && t.lineTemplate.indexOf('{ID}') >= 0) || (t.kind === 'LIST' && t.idField !== LIST_NAME_FIELD_);
  if (t.kind === 'LIST' && t.exceptDay && t.exceptDay === t.listDay) errs.push('Compare the list with a different day.');
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
    else if (to === f) errs.push('The window must not start and end at the same time.');
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

/** True when a window's end is before its start, i.e. it runs past midnight into the next day. Pure. */
function linkWindowCrossesMidnight_(fromMin, toMin) {
  return fromMin !== null && toMin !== null && toMin < fromMin;
}

/** The time test of "who" for a date: function({s, e}) in absolute minutes. Pure. */
function linkTimeTest_(opts) {
  var base = dayNumber_(opts.date) * 1440;
  if (opts.who === 'DAY') return function (x) { return x.s < base + 1440 && x.e > base; };
  if (opts.who === 'WINDOW') {
    // Until earlier than From: the window ends the next day (e.g. 23:00 – 08:00).
    var to = linkWindowCrossesMidnight_(opts.fromMin, opts.toMin) ? opts.toMin + 1440 : opts.toMin;
    return function (x) { return x.s < base + to && x.e > base + opts.fromMin; };
  }
  var at = base + opts.atMin;
  return function (x) { return x.s <= at && x.e > at; };
}

/**
 * Every assignment (shift and/or meeting) that matches the time test, sorted by start. Pure.
 * excludePrevDay leaves out what started before the date (overnight shifts "from previous day").
 * @param {{date, who, atMin?, fromMin?, toMin?, excludeMeetings?, excludePrevDay?, include?: 'SHIFTS'|'MEETINGS'|'BOTH'}} opts
 * @return {Array<{rec, s, e, category, identity}>}
 */
function selectAssignments_(records, opts) {
  var test = linkTimeTest_(opts);
  var include = opts.include || 'SHIFTS';
  var dayStart = dayNumber_(opts.date) * 1440;
  var items = records.filter(function (r) {
    return r.recordStatus === RECORD_STATUS.ACTIVE && isIsoDateTime_(r.shiftStart) && isIsoDateTime_(r.shiftEnd);
  }).map(function (r) {
    return { rec: r, s: wallMinutes_(r.shiftStart), e: wallMinutes_(r.shiftEnd), category: activityCategoryOf_(r), identity: employeeIdentity_(r) };
  }).filter(function (x) { return test(x) && !(opts.excludePrevDay && x.s < dayStart); });
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
    excludeMeetings: opts.excludeMeetings, excludePrevDay: opts.excludePrevDay, include: 'SHIFTS' }).forEach(function (x) {
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
 * Puts the assignments into the plan's sections by one staff-sheet column (t.sectionField: Role by
 * default, or Notes, Team, Skills, an own column…). Pure.
 * Each person goes to the first section listing their value (matched ignoring case and spaces; a cell
 * with several comma-separated values, e.g. "Chat, Phone", matches a section listing any of them);
 * everyone else follows (or is left out when "everyone else" is off); people with a left-out value
 * are dropped. Within a section the order stays by start time.
 * @param {function(Object): string} valueOf the record's employee's value in that column ('' if none)
 * @return {Array<{x, rank}>} rank = section index, or the number of sections for everyone else
 */
function orderPlanItems_(t, items, valueOf) {
  var sectionValues = t.sections.map(function (s) { return s.roles.map(normText_); });
  var excluded = t.excludeRoles.map(normText_);
  var hits = function (vals, list) { return vals.some(function (v) { return list.indexOf(v) >= 0; }); };
  var ranked = [];
  items.forEach(function (x, i) {
    var vals = planCellValues_(valueOf(x.rec));
    if (hits(vals, excluded)) return;
    var rank = -1;
    for (var k = 0; k < sectionValues.length && rank < 0; k++) if (hits(vals, sectionValues[k])) rank = k;
    if (rank < 0) { if (!t.showRest) return; rank = sectionValues.length; }
    ranked.push({ x: x, rank: rank, i: i });
  });
  ranked.sort(function (a, b) { return a.rank - b.rank || a.i - b.i; });
  return ranked;
}

/** A cell's values for section matching: the whole cell and each comma-separated part, normalized. Pure. */
function planCellValues_(cell) {
  var whole = normText_(cell);
  if (!whole) return [];
  return uniq_([whole].concat(planRoleList_(cell).map(normText_))).filter(Boolean);
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
 * @param {function(Object): string=} roleOf the employee's Role from the staff sheet ('' if none), for {ROLE}
 * @param {string=} dateIso the plan's date, for the time rules (default: each shift's own day)
 * @param {function(Object): string=} sectionOf the employee's value in the section column (default: roleOf)
 */
function buildPlanText_(t, items, teamNames, idOf, roleOf, dateIso, sectionOf) {
  roleOf = roleOf || function () { return ''; };
  sectionOf = sectionOf || roleOf;
  var hm = function (abs) { return minutesToHm_(((abs % 1440) + 1440) % 1440); };
  var hasTagsSlot = t.lineTemplate.indexOf('{TAGS}') >= 0;
  var line = function (x, rank) {
    var r = x.rec;
    var base = dateIso ? dayNumber_(dateIso) * 1440 : Math.floor(x.s / 1440) * 1440;
    // A section can be set to "No extra text" (e.g. shift leads): the time rules skip its people.
    var quiet = rank < t.sections.length && t.sections[rank].noTags;
    var tags = quiet ? '' : planTagsFor_(t, x, base).join(' ');
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
      cur.lines.push(line(p.x, p.rank));
    });
    var headed = parts.some(function (s) { return titleOf(s.rank); });
    return parts.map(function (s) { return (titleOf(s.rank) ? titleOf(s.rank) + '\n' : '') + s.lines.join('\n'); }).join(headed ? '\n\n' : '\n');
  };
  var ranked = orderPlanItems_(t, items, sectionOf);
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

/** The run date moved by an agent-list day (YESTERDAY / TODAY / TOMORROW). Pure. */
function listDayDate_(dateIso, day) {
  return isoFromDayNumber_(dayNumber_(dateIso) + (LIST_DAY_OFFSETS_[day] || 0));
}

/**
 * Agent list text: one value per person (name or staff column, e.g. a Slack ID), in start-time order,
 * each with the text before/after it, joined by the separator. People in `except` (identities working
 * on the compared day) are left out, e.g. "worked yesterday but not today". Pure.
 * @param {Array} people from selectWorking_
 * @param {function(Object): string} valueOf the value of a record's employee ('' if none)
 * @param {Object=} except identity -> true
 * @param {function(Object): string=} roleOf the employee's Role from the staff sheet; people with a role in
 *   t.excludeRoles (e.g. Shift Lead) are left out (matched ignoring case and spaces)
 * @return {{text: string, values: string[], missing: string[], left: number, byRole: number}}
 *   left = people left out by the comparison, byRole = people left out by their role
 */
function buildAgentList_(t, people, valueOf, except, roleOf) {
  var values = [], missing = [], left = 0, byRole = 0, listed = [];
  var excluded = (t.excludeRoles || []).map(normText_);
  people.forEach(function (p) {
    if (except && except[p.identity]) { left++; return; }
    var role = roleOf && excluded.length ? normText_(roleOf(p.rec)) : '';
    if (role && excluded.indexOf(role) >= 0) { byRole++; return; }
    var v = valueOf(p.rec);
    if (!v) { missing.push(p.employeeName || p.employeeId); return; }
    if (values.indexOf(v) < 0) { values.push(v); listed.push(p.rec); }
  });
  // "\n" typed in the separator box means a line break (one value per line).
  var sep = t.separator.replace(/\\n/g, '\n');
  var text = values.length ? values.map(function (v) { return t.prefix + v + t.suffix; }).join(sep) : t.emptyText;
  // listed: one record per value, in order, so an export can write another staff column for the same people.
  return { text: text, values: values, missing: missing, left: left, byRole: byRole, listed: listed };
}

/* ------------------------------------------------------------------------ */
/* Generation (reads the spreadsheet)                                        */
/* ------------------------------------------------------------------------ */

/**
 * Staff columns a daily plan can be put into sections by: the standard ones that hold a category
 * (Role, Notes, Team, Skills, Email) and every own column.
 */
function planSectionFieldOptions_() {
  var opts = ['role', 'notes', 'team', 'skills', 'email'].map(function (k) { return { key: k, label: STAFF_FIELD_DEFS[k].label }; });
  listStaffFields_().forEach(function (f) { opts.push({ key: STAFF_REGISTRY_PREFIX + f.fieldKey, label: f.displayName }); });
  return opts;
}

/**
 * Staff columns an item can write for each person: Employee ID, the standard columns (Email, Role,
 * Notes, Team, Skills) and every own column (e.g. "Aircall ID", "Slack ID").
 */
function linkIdFieldOptions_() {
  var opts = [{ key: 'employeeId', label: 'Employee ID' }];
  ['email', 'role', 'notes', 'team', 'skills'].forEach(function (k) { opts.push({ key: k, label: STAFF_FIELD_DEFS[k].label }); });
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
  var date = t.kind === 'LIST' ? listDayDate_(ctx.date, t.listDay) : ctx.date;
  var exceptDate = t.kind === 'LIST' && t.exceptDay ? listDayDate_(ctx.date, t.exceptDay) : '';
  // Each day's records plus the day before (overnight shifts reaching into it).
  var dates = [];
  [date, exceptDate].filter(Boolean).forEach(function (d) {
    [isoFromDayNumber_(dayNumber_(d) - 1), d].forEach(function (x) { if (dates.indexOf(x) < 0) dates.push(x); });
  });
  // A window past midnight also needs the shifts starting the next morning.
  var overnight = t.who === 'WINDOW' && linkWindowCrossesMidnight_(hmToMinutes_(t.from), hmToMinutes_(t.to));
  if (overnight) dates.push(isoFromDayNumber_(dayNumber_(date) + 1));
  var records = teamIds.length ? queryScheduleRecords_({ teamIds: teamIds, dates: dates }) : [];
  var opts = { date: date, who: t.who, atMin: t.who === 'NOW' ? ctx.nowMin : hmToMinutes_(t.at),
    fromMin: hmToMinutes_(t.from), toMin: hmToMinutes_(t.to), excludeMeetings: t.excludeMeetings, excludePrevDay: !t.includePrevDay };
  var whenLabel = (t.who === 'NOW' ? 'now (' + minutesToHm_(ctx.nowMin) + ')' : t.who === 'AT' ? 'at ' + t.at
    : t.who === 'WINDOW' ? t.from + '–' + t.to + (overnight ? ' (next day)' : '') : 'whole day') +
    (t.excludeMeetings && (t.who === 'NOW' || t.who === 'AT') ? ', not in a meeting' : '');
  var idOf = linkIdReader_(t.idField, teamsById, staffCache);
  if (t.kind === 'LIST') whenLabel = LIST_DAYS[t.listDay].toLowerCase() + ' (' + date + '), ' + whenLabel;
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
    var roleOf = linkIdReader_('role', teamsById, staffCache); // the staff sheet's Role column, for {ROLE}
    // Sections follow the chosen staff column (Role unless another one is chosen).
    var sectionOf = t.sectionField === 'role' ? roleOf : linkIdReader_(t.sectionField, teamsById, staffCache);
    res.text = buildPlanText_(t, items, names, reader, roleOf, ctx.date, sectionOf);
    var listed = orderPlanItems_(t, items, sectionOf).map(function (p) { return p.x; });
    res.listed = listed.map(function (x) { return x.rec; }); // in plan order (CSV: another staff column for them)
    res.count = listed.length;
    res.people = uniq_(listed.map(function (x) { return x.identity; })).length;
    res.missing = Object.keys(missing);
    return res;
  }

  if (t.kind === 'LIST') {
    var working = selectWorking_(records, opts);
    var except = null;
    if (exceptDate) {
      except = {};
      // Compared with the whole other day (shifts starting on it).
      selectWorking_(records, { date: exceptDate, who: 'DAY', excludePrevDay: true }).forEach(function (p) { except[p.identity] = true; });
    }
    var valueOf = t.idField === LIST_NAME_FIELD_ ? function (r) { return str_(r.employeeName) || str_(r.employeeId); } : idOf;
    var list = buildAgentList_(t, working, valueOf, except, linkIdReader_('role', teamsById, staffCache));
    res.text = list.text;
    res.values = list.values.map(function (v) { return t.prefix + v + t.suffix; }); // one per agent, for the CSV export
    res.rawValues = list.values.slice(); // without the text before/after each value
    res.listed = list.listed; // the people listed, in order (CSV: another staff column for them)
    res.count = list.values.length;
    res.people = working.length - list.left - list.byRole;
    res.missing = list.missing;
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

/* ------------------------------------------------------------------------ */
/* Sheet layout settings                                                     */
/* ------------------------------------------------------------------------ */

var LINK_SHEET_LAYOUTS = { ROW: 'One row (Key + date + one column per item)', ROWS: 'One row per item' };

/**
 * Sheet layout settings (stored in _CONFIG LINK_SHEET_SETTINGS). Pure.
 * ROW: A1 keyHeader / A2 keyValue, B1 dateHeader / B2 the date, then one column per item
 * (item name in row 1, its link or plan text in row 2). ROWS: one row per item.
 */
function normalizeLinkSheetSettings_(s) {
  s = s || {};
  var text = function (v, dflt) { return str_(v) || dflt; };
  return {
    layout: LINK_SHEET_LAYOUTS[s.layout] ? s.layout : 'ROW',
    keyHeader: text(s.keyHeader, 'Key'),
    keyValue: text(s.keyValue, 'DAILY'),
    dateHeader: text(s.dateHeader, 'Header_Date'),
    dateFormat: text(s.dateFormat, 'yyyy-MM-dd')
  };
}

function loadLinkSheetSettings_() {
  return normalizeLinkSheetSettings_(parseJson_(getConfig_().LINK_SHEET_SETTINGS, {}));
}

/** The date of a run in the configured format, e.g. "2026-10-19" or "2026. 10. 19". */
function formatLinkDate_(dateIso, fmt) {
  var tz = getConfig_().TIMEZONE;
  return Utilities.formatDate(Utilities.parseDate(dateIso + ' 12:00', tz, 'yyyy-MM-dd HH:mm'), tz, fmt);
}

/**
 * One-row layout: column names in row 1, values in row 2, in item order. A link split into
 * several URLs gets extra columns "Name 2", "Name 3". Pure.
 * @return {{header: string[], values: string[], urlCols: number[]}} urlCols = 0-based columns holding a URL
 */
function linksSheetRow_(results, settings, dateText) {
  var header = [settings.keyHeader, settings.dateHeader], values = [settings.keyValue, dateText], urlCols = [];
  results.forEach(function (r) {
    if (r.template.kind !== 'LINK') { header.push(r.template.name); values.push(r.text); return; }
    var urls = r.urls.length ? r.urls : [''];
    urls.forEach(function (u, i) {
      header.push(r.template.name + (i ? ' ' + (i + 1) : ''));
      values.push(u);
      urlCols.push(header.length - 1);
    });
  });
  return { header: header, values: values, urlCols: urlCols };
}

/** Sheet rows (row 1 = column names) for generated items, in item order. Pure. */
function linksSheetRows_(results, updated) {
  var urlCols = Math.max(1, results.reduce(function (n, r) { return Math.max(n, r.urls.length); }, 0));
  var header = ['Name', 'Kind', 'Date', 'Updated', 'Count', 'Missing', 'Text', 'URL'];
  for (var i = 2; i <= urlCols; i++) header.push('URL ' + i);
  var rows = results.map(function (r) {
    var row = [r.template.name, { PLAN: 'Plan', LIST: 'List', LINK: 'Link' }[r.template.kind], r.date, updated,
      r.template.kind === 'PLAN' ? r.count : r.count + (r.missing.length ? ' of ' + r.people : ''), r.missing.join(', '), r.text];
    for (var j = 0; j < urlCols; j++) row.push(r.urls[j] || '');
    return row;
  });
  return { header: header, rows: rows, urlCols: urlCols };
}

/** A rich-text value that shows the URL itself (what Slack reads) and is clickable (no HYPERLINK length limit). */
function linkRichText_(u) {
  return u ? SpreadsheetApp.newRichTextValue().setText(u).setLinkUrl(u).build() : SpreadsheetApp.newRichTextValue().setText('').build();
}

/** One-row layout: Key / date / one column per item (see linksSheetRow_). */
function writeLinksSheetRow_(sh, results, settings, dateIso, th) {
  var t = linksSheetRow_(results, settings, formatLinkDate_(dateIso, settings.dateFormat));
  var width = t.header.length;
  ensureColumns_(sh, width);
  sh.getRange(1, 1, 1, width).setValues([t.header.map(safeCell_)]).setFontWeight('bold').setBackground(th.header).setFontColor(th.headerText);
  sh.getRange(2, 1, 1, width).setNumberFormat('@').setValues([t.values.map(safeCell_)]).setVerticalAlignment('top').setWrap(true);
  t.urlCols.forEach(function (c) { sh.getRange(2, c + 1).setRichTextValue(linkRichText_(t.values[c])).setWrap(false); });
  for (var c = 1; c <= width; c++) sh.setColumnWidth(c, c <= 2 ? 120 : 280);
}

/**
 * Rewrites the "Monitoring Links" sheet in the chosen layout: one row (Key + date + one column
 * per item, for a Slack Workflow that selects the row where Key = DAILY), or one row per item.
 */
function writeLinksSheet_(results, updated, settings, dateIso) {
  var ss = getSs_();
  var sh = ss.getSheetByName(LINKS_SHEET_) || ss.insertSheet(LINKS_SHEET_);
  var th = sheetTheme_();
  settings = settings || loadLinkSheetSettings_();
  if (settings.layout === 'ROW') {
    sh.clear();
    writeLinksSheetRow_(sh, results, settings, dateIso, th);
    sh.setFrozenRows(1);
    sh.setTabColor(th.accent);
    applySheetFont_(sh, th);
    return sh;
  }
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
    var urlRange = sh.getRange(2, 8, t.rows.length, t.urlCols);
    urlRange.setRichTextValues(t.rows.map(function (r) { return r.slice(7).map(linkRichText_); })).setWrap(false);
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
  var sh = writeLinksSheet_(results, ctx.updated, loadLinkSheetSettings_(), ctx.date);
  try { PropertiesService.getScriptProperties().setProperty(LINKS_LAST_RUN_PROP_, ctx.updated); } catch (e) { /* shown as unknown */ }
  return { sheet: sh.getName(), results: results };
}

var LINKS_LAST_RUN_PROP_ = 'SM_LINKS_LAST_RUN';

/** When the Monitoring Links sheet was last generated ("yyyy-MM-dd HH:mm"), or ''. */
function linksLastRun_() {
  try { return PropertiesService.getScriptProperties().getProperty(LINKS_LAST_RUN_PROP_) || ''; } catch (e) { return ''; }
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
      idFields: linkIdFieldOptions_(), sectionFields: planSectionFieldOptions_(),
      teams: Object.keys(teams).map(function (k) { return { teamId: k, teamName: teams[k].teamName, active: teams[k].active }; }),
      who: LINK_WHO, kinds: LINK_KINDS, listDays: LIST_DAYS, listNameField: LIST_NAME_FIELD_, include: PLAN_INCLUDE, tagModes: PLAN_TAG_MODES, tagWindowModes: PLAN_TAG_WINDOW_MODES_, defaultLine: PLAN_DEFAULT_LINE_,
      sheetSettings: loadLinkSheetSettings_(), layouts: LINK_SHEET_LAYOUTS,
      csvSettings: normalizeLinkCsvSettings_(parseJson_(getConfig_().LINK_CSV_SETTINGS, {})), csvLayouts: LINK_CSV_LAYOUTS, csvDelimiters: LINK_CSV_DELIMITERS,
      today: ctx.today
    };
  });
}

/** Saves the sheet layout (one row with Key + date, or one row per item). */
function apiLinksSaveSheetSettings(input) {
  return apiCall_('apiLinksSaveSheetSettings', function () {
    requireInitialized_();
    return withLock_(function () {
      var s = normalizeLinkSheetSettings_(input);
      var errs = [];
      try { formatLinkDate_(linkRunContext_('').today, s.dateFormat); } catch (e) { errs.push('The date format "' + s.dateFormat + '" is not valid (e.g. yyyy-MM-dd or yyyy. MM. dd).'); }
      if (normName_(s.keyHeader) === normName_(s.dateHeader)) errs.push('The key and date column names must differ.');
      var clash = loadLinkTemplates_().filter(function (t) { return [s.keyHeader, s.dateHeader].map(normName_).indexOf(normName_(t.name)) >= 0; })[0];
      if (s.layout === 'ROW' && clash) errs.push('An item is already called "' + clash.name + '"; column names must be unique.');
      if (errs.length) fail_('VALIDATION', errs.join(' '));
      setConfigValues_({ LINK_SHEET_SETTINGS: JSON.stringify(s) });
      return s;
    });
  });
}

function apiLinksSave(input) {
  return apiCall_('apiLinksSave', function () {
    requireInitialized_();
    return withLock_(function () {
      var t = normalizeLinkTemplate_(input);
      var list = loadLinkTemplates_();
      var ss = loadLinkSheetSettings_();
      // Names must be unique: they are row names (one row per item) or column names (one row), next to Key and date.
      var others = list.filter(function (x) { return x.id !== t.id; }).map(function (x) { return x.name; }).concat([ss.keyHeader, ss.dateHeader]);
      var errs = validateLinkTemplate_(t, linkIdFieldOptions_().map(function (f) { return f.key; }), others, planSectionFieldOptions_().map(function (f) { return f.key; }));
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
    var errs = validateLinkTemplate_(t, linkIdFieldOptions_().map(function (f) { return f.key; }), null, planSectionFieldOptions_().map(function (f) { return f.key; }));
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

/* ------------------------------------------------------------------------ */
/* CSV export                                                                */
/* ------------------------------------------------------------------------ */

var LINK_CSV_LAYOUTS = { ROWS: 'One value per row (each agent, line or link)', CELL: 'Whole output in one cell' };
var LINK_CSV_DELIMITERS = { ',': 'Comma (,)', ';': 'Semicolon (;) — Excel with European settings', '\t': 'Tab' };

/** The export settings with defaults: columns [{id, header}] in order, layout, delimiter. Pure. */
function normalizeLinkCsvSettings_(s) {
  s = s || {};
  return {
    // field: '' = the output as it is; otherwise a staff column written for each listed person (e.g. email).
    columns: (Array.isArray(s.columns) ? s.columns : []).map(function (c) { return { id: str_(c && c.id), header: str_(c && c.header).substr(0, 120), field: str_(c && c.field) }; })
      .filter(function (c) { return c.id; }),
    layout: LINK_CSV_LAYOUTS[s.layout] ? s.layout : 'ROWS',
    delimiter: LINK_CSV_DELIMITERS[s.delimiter] ? s.delimiter : ',',
    // Agent lists without the text added before/after each value (e.g. "@" or "<@" … ">"); the sheet keeps it.
    plain: !!s.plain
  };
}

/**
 * An item's output as CSV values: agent-list values, plan lines (blank lines dropped), or link URLs. Pure.
 * plain: agent lists without the text before/after each value.
 */
function linkOutputValues_(r, plain) {
  var kind = r.template.kind;
  if (kind === 'LINK') return r.urls.slice();
  if (kind === 'LIST') { var v = plain ? r.rawValues : r.values; return v && v.length ? v.slice() : []; }
  return str_(r.text) === str_(r.template.emptyText) ? [] : str_(r.text).split('\n').map(function (l) { return l.replace(/\s+$/, ''); }).filter(Boolean);
}

/**
 * A staff column for the people an item lists, in order: each person once, people without a value left
 * out (and named in `missing`). Pure.
 * @param {Object[]} recs the listed records (res.listed)
 * @param {function(Object): string} valueOf the record's employee's value in that column
 */
function staffColumnValues_(recs, valueOf) {
  var values = [], missing = [], seen = {};
  (recs || []).forEach(function (r) {
    var who = employeeIdentity_(r);
    if (seen[who]) return;
    seen[who] = true;
    var v = str_(valueOf(r));
    if (v) values.push(v); else missing.push(str_(r.employeeName) || str_(r.employeeId));
  });
  return { values: values, missing: missing };
}

/**
 * One CSV field: quoted when it holds the delimiter, a quote or a line break. A cell that would run as a
 * formula when opened gets a ' in front: starting with =, with + or - not followed by a number, or with
 * @ followed by a function (@SUM(…)). A mention or name such as "@John Doe" stays as it is. Pure.
 */
function csvField_(v, delimiter) {
  var s = String(v === null || v === undefined ? '' : v);
  if (/^=/.test(s) || (/^[+\-]/.test(s) && !/^[+\-]?\d/.test(s)) || /^@\s*[A-Za-z_][\w.]*\s*\(/.test(s)) s = "'" + s;
  return s.indexOf(delimiter) >= 0 || /["\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/**
 * The CSV text. Pure.
 * @param {Array<{header: string, values: string[], text: string}>} columns in order
 * @param {{layout: 'ROWS'|'CELL', delimiter: string}} opts ROWS: each value its own row; CELL: one row, the whole output per cell
 * @return {{csv: string, rows: number}} rows = data rows (without the header)
 */
function buildLinksCsv_(columns, opts) {
  var d = opts.delimiter || ',';
  var lines = [columns.map(function (c) { return csvField_(c.header, d); }).join(d)];
  var rows = 0;
  if (opts.layout === 'CELL') {
    lines.push(columns.map(function (c) { return csvField_(c.text, d); }).join(d));
    rows = 1;
  } else {
    rows = columns.reduce(function (n, c) { return Math.max(n, c.values.length); }, 0);
    for (var i = 0; i < rows; i++) lines.push(columns.map(function (c) { return csvField_(c.values[i] === undefined ? '' : c.values[i], d); }).join(d));
  }
  return { csv: lines.join('\r\n') + '\r\n', rows: rows };
}

/** Builds the chosen items for a date and their CSV; remembers the choice. */
function linksCsvFor_(input, dateIso) {
  var s = normalizeLinkCsvSettings_(input);
  if (!s.columns.length) fail_('VALIDATION', 'Tick at least one item to export.');
  var byId = {};
  loadLinkTemplates_().forEach(function (t) { byId[t.id] = t; });
  var missing = s.columns.filter(function (c) { return !byId[c.id]; });
  if (missing.length) fail_('VALIDATION', 'An item in the export no longer exists. Tick the items again.');
  var heads = s.columns.map(function (c) { return normName_(c.header || byId[c.id].name); });
  if (heads.some(function (h, i) { return heads.indexOf(h) !== i; })) fail_('VALIDATION', 'Every column needs its own header.');
  var fieldKeys = linkIdFieldOptions_().map(function (f) { return f.key; }).concat([LIST_NAME_FIELD_]);
  var bad = s.columns.filter(function (c) { return c.field && fieldKeys.indexOf(c.field) < 0; })[0];
  if (bad) fail_('VALIDATION', 'The staff column "' + bad.field + '" for "' + (bad.header || byId[bad.id].name) + '" no longer exists.');
  var ctx = linkRunContext_(dateIso), teams = teamsByIdForLinks_(), cache = {};
  var missingAll = [];
  var cols = s.columns.map(function (c) {
    var r = generateLink_(byId[c.id], ctx, teams, cache);
    if (c.field && r.template.kind !== 'LINK') {
      // Another staff column for the same people, e.g. their email instead of their name.
      var valueOf = c.field === LIST_NAME_FIELD_ ? function (x) { return str_(x.employeeName) || str_(x.employeeId); } : linkIdReader_(c.field, teams, cache);
      var sv = staffColumnValues_(r.listed, valueOf);
      if (sv.missing.length) missingAll.push((c.header || byId[c.id].name) + ': ' + sv.missing.join(', '));
      return { header: c.header || byId[c.id].name, values: sv.values, text: sv.values.join(r.template.kind === 'LIST' ? r.template.separator.replace(/\\n/g, '\n') : '\n') };
    }
    var values = linkOutputValues_(r, s.plain);
    var text = r.template.kind === 'LINK' ? r.urls.join('\n')
      // Whole output in one cell, plain: the values joined as the list joins them, without the added text.
      : r.template.kind === 'LIST' && s.plain ? (values.length ? values.join(r.template.separator.replace(/\\n/g, '\n')) : r.text) : r.text;
    return { header: c.header || byId[c.id].name, values: values, text: text };
  });
  var out = buildLinksCsv_(cols, s);
  setConfigValues_({ LINK_CSV_SETTINGS: JSON.stringify(s) });
  var name = 'Monitoring Links ' + ctx.date + '.csv';
  return { csv: String.fromCharCode(0xFEFF) + out.csv, fileName: name, rows: out.rows, columns: cols.length, date: ctx.date, missing: missingAll }; // BOM: Excel reads it as UTF-8
}

/** The CSV text, for downloading in the browser. */
function apiLinksCsv(input, dateIso) {
  return apiCall_('apiLinksCsv', function () {
    requireInitialized_();
    return linksCsvFor_(input, dateIso);
  });
}

/** Saves the CSV as a file in your Google Drive (when the browser blocks the download) and returns its link. */
function apiLinksCsvToDrive(input, dateIso) {
  return apiCall_('apiLinksCsvToDrive', function () {
    requireInitialized_();
    var r = linksCsvFor_(input, dateIso);
    if (typeof Drive === 'undefined' || !Drive.Files || typeof Drive.Files.create !== 'function') {
      fail_('DRIVE_SERVICE', 'Saving to Drive needs the Drive advanced service (Apps Script editor → Services → Drive API). Use Download CSV instead.');
    }
    var file = Drive.Files.create({ name: r.fileName, mimeType: 'text/csv' }, Utilities.newBlob(r.csv, 'text/csv', r.fileName), { fields: 'id,name,webViewLink' });
    return { fileName: file.name || r.fileName, url: file.webViewLink || 'https://drive.google.com/file/d/' + file.id + '/view', rows: r.rows, columns: r.columns, date: r.date, missing: r.missing };
  });
}

function apiLinksOpenSheet() {
  return apiCall_('apiLinksOpenSheet', function () {
    var sh = getSs_().getSheetByName(LINKS_SHEET_);
    if (!sh) fail_('NOT_FOUND', 'The Monitoring Links sheet does not exist yet. Click "Generate all" first.');
    return activateSheet_(sh);
  });
}
