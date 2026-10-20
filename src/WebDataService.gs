/**
 * WebDataService.gs
 * Data for the web app's own pages (WebSchedule, WebDashboard, WebPerson, WebStaff, WebLinksOutput).
 * Read-only apart from staff edits. Every number comes from the same functions as the sheets
 * (dayView_ → buildDayRows_, workMinutesByEmployee_, headcountByHour_), so the web app and the daily
 * sheets / Dashboard always agree.
 *
 * Speed: one read of _SCHEDULE_DATA per call (all chosen teams and days at once, only the matching
 * rows), one staff-sheet read per team, and the configuration from the script cache (getConfig_).
 *
 * Dependencies: Utils.gs, ConfigService.gs, TeamService.gs, StaffService.gs, ScheduleService.gs,
 *   AuditService.gs, MonitoringLinkService.gs
 */

/** The person key used in links: "ID:<Employee ID>" or "NM:<name>". Pure. */
function webPersonKey_(employeeId, employeeName) {
  return employeeId ? 'ID:' + str_(employeeId) : 'NM:' + str_(employeeName).replace(/\s+/g, ' ').trim();
}

/** Does a record belong to the person key? IDs ignore case/leading spaces; names ignore case and spaces. Pure. */
function webRecordIsPerson_(r, key) {
  key = str_(key);
  if (key.indexOf('ID:') === 0) return !!r.employeeId && idKey_(r.employeeId) === idKey_(key.substr(3));
  if (key.indexOf('NM:') === 0) return !r.employeeId && normName_(r.employeeName) === normName_(key.substr(3));
  return false;
}

/** Wall-clock HH:mm of absolute minutes. Pure. */
function webHm_(abs) { return minutesToHm_(((abs % 1440) + 1440) % 1440); }

/** One display row for the client. Pure. */
function webDayRow_(row, base, staffIdx, nameStrategy) {
  var r = row.rec;
  var m = staffIdx ? matchEmployee_(staffIdx, r.employeeId, r.employeeName, nameStrategy) : { staff: null };
  return {
    name: displayName_(row), employeeId: r.employeeId, key: webPersonKey_(r.employeeId, r.employeeName),
    role: m.staff ? str_(m.staff.fields.role) : '', type: typeOptionLabel_(row),
    start: webHm_(row.startMin), end: webHm_(row.endMin), from: row.startMin - base, to: row.endMin - base,
    meeting: activityCategoryOf_(row) === ACTIVITY_CATEGORY.MEETING, carry: !!row.carry, flags: row.flags
  };
}

function readyTeams_() {
  return listTeams_().filter(function (t) { return t.status === TEAM_STATUS.READY; });
}

/**
 * Schedule page: the day of the chosen teams (default: every active team), with rows, summary and
 * headcount per team, plus the headcount of all of them together.
 */
function apiWebDay(dateIso, teamIds) {
  return apiCall_('apiWebDay', function () {
    requireInitialized_();
    var cfg = getConfig_();
    var today = todayIso_(cfg.TIMEZONE);
    var date = isIsoDate_(dateIso) ? dateIso : today;
    var teams = readyTeams_();
    var wanted = (teamIds || []).filter(Boolean);
    var chosen = teams.filter(function (t) { return wanted.length ? wanted.indexOf(t.teamId) >= 0 : t.active; });
    if (!chosen.length && !wanted.length) chosen = teams;
    var recs = chosen.length ? queryScheduleRecords_({ teamIds: chosen.map(function (t) { return t.teamId; }), dates: [addDays_(date, -1), date, addDays_(date, 1)] }) : [];
    var base = dayNumber_(date) * 1440;
    var all = [];
    var views = chosen.map(function (team) {
      var idx = tryStaffIndex_(team);
      var dv = dayView_(team, date, recs.filter(function (r) { return r.teamId === team.teamId; }), idx, cfg);
      all = all.concat(dv.rows);
      var strategy = team.settings.import.nameMatch || cfg.NAME_MATCH_STRATEGY;
      var sh = resolveTeamSheet_(team, 'schedule');
      return {
        teamId: team.teamId, teamName: team.teamName, hoursLabel: dv.win.label, staffSheetOk: !!idx,
        window: { from: dv.win.startMin, to: dv.win.endMin }, summary: dv.summary, headcount: dv.headcount,
        rows: dv.rows.map(function (row) { return webDayRow_(row, base, idx, strategy); }),
        sheet: sh ? sheetLink_(sh) : null
      };
    });
    return {
      date: date, today: today, weekday: weekdayOf_(date),
      teams: teams.map(function (t) { return { teamId: t.teamId, teamName: t.teamName, active: t.active }; }),
      selected: chosen.map(function (t) { return t.teamId; }),
      views: views,
      headcount: headcountByHour_(all.filter(function (r) { return activityCategoryOf_(r) === ACTIVITY_CATEGORY.SHIFT; }), date, 0, 1440)
    };
  });
}

function weekdayOf_(dateIso) {
  return Utilities.formatDate(new Date(Date.UTC(+dateIso.substr(0, 4), +dateIso.substr(5, 2) - 1, +dateIso.substr(8, 2), 12)), 'UTC', 'EEEE');
}

/** Dashboard page: every team's day in numbers (as the Dashboard sheet), totals and recent imports. */
function apiWebDashboard(dateIso) {
  return apiCall_('apiWebDashboard', function () {
    requireInitialized_();
    var cfg = getConfig_();
    var tz = getTz_();
    var today = todayIso_(cfg.TIMEZONE);
    var date = isIsoDate_(dateIso) ? dateIso : today;
    var teams = listTeams_();
    var recs = queryScheduleRecords_({ dates: [addDays_(date, -1), date, addDays_(date, 1)] });
    var log = readImportLog_();
    var allRows = [];
    var rows = teams.map(function (team) {
      var ready = team.status === TEAM_STATUS.READY;
      var dv = dayView_(team, date, recs.filter(function (r) { return r.teamId === team.teamId; }), ready ? tryStaffIndex_(team) : null, cfg);
      if (team.active) allRows = allRows.concat(dv.rows);
      var li = null;
      for (var i = 0; i < log.length; i++) if (log[i].teams.indexOf('[' + team.teamId + ']') >= 0) { li = log[i]; break; }
      var sh = ready ? resolveTeamSheet_(team, 'schedule') : null;
      return {
        teamId: team.teamId, teamName: team.teamName, active: team.active, status: team.status, summary: dv.summary,
        headcount: dv.headcount, lastImport: li ? { timestamp: formatTimestamp_(li.timestamp, tz), status: li.status } : null,
        sheet: sh ? sheetLink_(sh) : null
      };
    });
    var sum = function (k) { return rows.filter(function (r) { return r.active; }).reduce(function (s, r) { return s + (r.summary[k] || 0); }, 0); };
    return {
      date: date, today: today, weekday: weekdayOf_(date), teams: rows,
      totals: { shifts: sum('shifts'), meetings: sum('meetings'), staff: sum('staff'), workingHours: formatMinutesAsDuration_(sum('workMinutes')),
        overlaps: sum('overlaps'), unknown: sum('unknown') },
      headcount: headcountByHour_(allRows.filter(function (r) { return activityCategoryOf_(r) === ACTIVITY_CATEGORY.SHIFT; }), date, 0, 1440),
      imports: log.slice(0, 6).map(function (e) {
        return { importId: e.importId, timestamp: formatTimestamp_(e.timestamp, tz), sourceFile: e.sourceFile, teams: e.teams, status: e.status,
          inserted: e.rowsInserted, updated: e.rowsUpdated, removed: e.rowsRemoved };
      })
    };
  });
}

/** Monday of the week containing the date. Pure. */
function weekStartOf_(dateIso) {
  var n = dayNumber_(dateIso);
  var dow = (n + 3) % 7; // day 0 (1970-01-01) was a Thursday → Monday = 0
  return isoFromDayNumber_(n - dow);
}

/** Person page: one person's shifts and meetings for a week (Monday–Sunday) in every team, and their staff details. */
function apiWebPerson(key, weekIso) {
  return apiCall_('apiWebPerson', function () {
    requireInitialized_();
    key = str_(key);
    if (!/^(ID|NM):./.test(key)) fail_('VALIDATION', 'No person was chosen. Open a person from the Schedule or Staff page.');
    var cfg = getConfig_();
    var today = todayIso_(cfg.TIMEZONE);
    var start = weekStartOf_(isIsoDate_(weekIso) ? weekIso : today);
    var days = [];
    for (var i = -1; i < 7; i++) days.push(addDays_(start, i));
    var teams = readyTeams_();
    var teamName = {};
    teams.forEach(function (t) { teamName[t.teamId] = t.teamName; });
    var recs = queryScheduleRecords_({ dates: days }).filter(function (r) {
      return r.recordStatus === RECORD_STATUS.ACTIVE && webRecordIsPerson_(r, key) && isIsoDateTime_(r.shiftStart) && isIsoDateTime_(r.shiftEnd);
    });
    var name = '';
    recs.forEach(function (r) { if (!name && r.employeeName) name = r.employeeName; });
    var items = recs.map(function (r) {
      return { rec: r, startMin: wallMinutes_(r.shiftStart), endMin: wallMinutes_(r.shiftEnd), activityCategory: activityCategoryOf_(r) };
    });
    var week = days.slice(1).map(function (d) {
      var own = items.filter(function (x) { return x.rec.shiftDate === d; }).sort(function (a, b) { return a.startMin - b.startMin; });
      var work = workMinutesByEmployee_(own);
      var minutes = Object.keys(work).reduce(function (s, k) { return s + work[k]; }, 0);
      return {
        date: d, weekday: weekdayOf_(d), minutes: minutes, hours: formatMinutesAsDuration_(minutes),
        items: own.map(function (x) {
          return { team: teamName[x.rec.teamId] || x.rec.teamId, type: x.rec.shiftType || x.rec.activity, start: webHm_(x.startMin), end: webHm_(x.endMin),
            meeting: x.activityCategory === ACTIVITY_CATEGORY.MEETING, overnight: Math.floor(x.endMin / 1440) > Math.floor(x.startMin / 1440) && x.endMin % 1440 !== 0 };
        })
      };
    });
    // Staff details from every staff sheet that lists the person.
    var listings = [];
    var idPart = key.indexOf('ID:') === 0 ? key.substr(3) : '';
    var namePart = key.indexOf('NM:') === 0 ? key.substr(3) : name;
    teams.forEach(function (t) {
      var st = null;
      try { st = staffListFor_(t, '', 5000); } catch (e) { logError_('apiWebPerson.staff', e); return; }
      var hit = st.rows.filter(function (r) {
        return idPart ? idKey_(r.employeeId) === idKey_(idPart) : normName_(r.employeeName) === normName_(namePart);
      })[0];
      if (!hit) return;
      if (!name) name = hit.employeeName;
      listings.push({ teamId: t.teamId, teamName: t.teamName, employeeId: hit.employeeId,
        fields: st.fields.map(function (f) { return { label: f.label, value: str_(hit.values[f.label]) }; }).filter(function (f) { return f.value; }) });
    });
    var total = week.reduce(function (s, d) { return s + d.minutes; }, 0);
    return {
      key: key, name: name || namePart || idPart, employeeId: idPart, weekStart: start, weekEnd: addDays_(start, 6),
      prevWeek: addDays_(start, -7), nextWeek: addDays_(start, 7), today: today,
      week: week, totalHours: formatMinutesAsDuration_(total), shifts: items.filter(function (x) { return x.activityCategory === ACTIVITY_CATEGORY.SHIFT && days.indexOf(x.rec.shiftDate) > 0; }).length,
      listings: listings
    };
  });
}

/** Staff page: the ready teams and the chosen team's whole staff list (searched in the browser). */
function apiWebStaff(teamId) {
  return apiCall_('apiWebStaff', function () {
    requireInitialized_();
    var teams = readyTeams_();
    if (!teams.length) return { teams: [], teamId: '', list: null };
    var team = teams.filter(function (t) { return t.teamId === teamId; })[0] || teams.filter(function (t) { return t.active; })[0] || teams[0];
    var list = staffListFor_(team, '', 5000);
    var sh = resolveTeamSheet_(team, 'staff');
    return {
      teams: teams.map(function (t) { return { teamId: t.teamId, teamName: t.teamName, active: t.active }; }),
      teamId: team.teamId, teamName: team.teamName, list: list, sheet: sh ? sheetLink_(sh) : null
    };
  });
}

function apiWebStaffDelete(teamId, employeeId) {
  return apiCall_('apiWebStaffDelete', function () {
    requireInitialized_();
    return withLock_(function () {
      var r = deleteStaff_(requireTeam_(teamId), employeeId);
      rebuildStaffMasterSafe_();
      return r;
    });
  });
}

/**
 * Monitoring Links output: what the "Monitoring Links" sheet holds now (what a Slack Workflow reads),
 * item by item, and when it was last generated.
 */
function apiWebLinksOutput() {
  return apiCall_('apiWebLinksOutput', function () {
    requireInitialized_();
    var settings = loadLinkSheetSettings_();
    var sh = getSs_().getSheetByName(LINKS_SHEET_);
    var out = { layout: settings.layout, items: [], updated: linksLastRun_(), sheet: sh ? sheetLink_(sh) : null, itemCount: loadLinkTemplates_().length };
    if (!sh || sh.getLastRow() < 2) return out;
    var v = sh.getRange(1, 1, sh.getLastRow(), Math.max(sh.getLastColumn(), 1)).getDisplayValues();
    out.items = linksOutputItems_(v, settings);
    return out;
  });
}

/**
 * The items of the Monitoring Links sheet's values (row 1 = names). One-row layout: every column after
 * the key and date is an item; one row per item: Name / Text / URL columns. Pure.
 * @return {Array<{name, value, url: boolean}>}
 */
function linksOutputItems_(values, settings) {
  var head = values[0] || [];
  var isUrl = function (s) { return /^https?:\/\//i.test(str_(s)); };
  if (settings.layout === 'ROW') {
    var row = values[1] || [];
    return head.map(function (h, i) { return { name: str_(h), value: str_(row[i]), url: isUrl(row[i]) }; })
      .filter(function (x, i) { return i > 1 && x.name; });
  }
  var col = function (label) { return head.indexOf(label); };
  var iText = col('Text'), iUrl = col('URL');
  var out = [];
  values.slice(1).forEach(function (r) {
    if (!str_(r[0])) return;
    var urls = iUrl >= 0 ? r.slice(iUrl).map(str_).filter(Boolean) : [];
    if (urls.length) urls.forEach(function (u, k) { out.push({ name: str_(r[0]) + (k ? ' ' + (k + 1) : ''), value: u, url: true }); });
    else out.push({ name: str_(r[0]), value: iText >= 0 ? str_(r[iText]) : '', url: false });
  });
  return out;
}
