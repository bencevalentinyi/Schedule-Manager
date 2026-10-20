/**
 * DashboardService.gs
 * The all-teams dashboard sheet (name configurable via DASHBOARD_SHEET):
 * today's scheduled staff per team, peak headcount, data-quality counts, last
 * import, quick links, and recent import statistics. Fully regenerated each time.
 *
 * Dependencies: Schema.gs, Utils.gs, ConfigService.gs, TeamService.gs,
 *   TeamTypeService.gs, ScheduleService.gs, StaffService.gs, AuditService.gs
 */

function rebuildDashboard_() {
  var cfg = getConfig_();
  var th = sheetTheme_(cfg);
  var ss = getSs_();
  var tz = getTz_();
  var name = cfg.DASHBOARD_SHEET || 'Dashboard';
  var sh = ss.getSheetByName(name);
  var created = false;
  if (!sh) { sh = ss.insertSheet(name, 0); created = true; }

  var today = todayIso_(cfg.TIMEZONE);
  var teams = listTeams_();
  var typeNames = typeNameMap_();
  var recs = queryScheduleRecords_({ dates: [addDays_(today, -1), today, addDays_(today, 1)] });
  var log = readImportLog_();
  var link = function (s, label) { return s ? '=HYPERLINK("#gid=' + s.getSheetId() + '","' + label + '")' : 'missing'; };

  var teamRows = teams.map(function (team) {
    var ready = team.status === TEAM_STATUS.READY;
    // The same numbers as the team's daily sheet and the web app (dayView_).
    var S = dayView_(team, today, recs.filter(function (r) { return r.teamId === team.teamId; }), ready ? tryStaffIndex_(team) : null, cfg).summary;
    var li = null;
    for (var i = 0; i < log.length; i++) if (log[i].teams.indexOf('[' + team.teamId + ']') >= 0) { li = log[i]; break; }
    return [
      safeCell_(team.teamName), safeCell_(typeNames[team.teamTypeId] || team.teamTypeId),
      team.active ? 'Active' : 'Inactive', team.status,
      S.shifts, S.staff, S.workMinutes / 1440, S.peak, S.unknown, S.overlaps,
      li ? formatTimestamp_(li.timestamp, tz) + ' · ' + li.status : 'never',
      link(resolveTeamSheet_(team, 'schedule'), 'Schedule'), link(resolveTeamSheet_(team, 'staff'), 'Staff')
    ];
  });

  sh.clear(); // generated sheet: contents and formats are rebuilt every time (column widths are kept)
  sh.getRange(1, 1).setValue(APP.NAME + ' — Dashboard').setFontSize(16).setFontWeight('bold').setFontColor(th.accent);
  sh.getRange(2, 1).setValue('Today: ' + today + ' (' + Utilities.formatDate(new Date(), cfg.TIMEZONE, 'EEEE') + ')   ·   Updated ' +
    Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm') + '   ·   Refresh with Schedule Manager → Schedule Management → Refresh Schedule Data')
    .setFontColor('#5f6368');

  var header = ['Team', 'Team Type', 'Active', 'Setup Status', 'Shifts Today', 'Staff Today', 'Hours',
    'Peak Headcount', 'Unknown Employees', 'Overlaps', 'Last Import', 'Schedule', 'Staff'];
  var H = 4;
  sh.getRange(H, 1, 1, header.length).setValues([header]).setFontWeight('bold')
    .setBackground(th.header).setFontColor(th.headerText);
  if (teamRows.length) {
    sh.getRange(H + 1, 1, teamRows.length, header.length).setValues(teamRows);
    sh.getRange(H + 1, 7, teamRows.length, 1).setNumberFormat('[h]:mm');
  } else {
    sh.getRange(H + 1, 1).setValue('No teams yet. Use Schedule Manager → Setup & Configuration → Create New Team.');
  }

  var R = H + Math.max(teamRows.length, 1) + 3;
  var committed = log.filter(function (e) { return e.status === IMPORT_STATUS.COMMITTED; });
  sh.getRange(R - 1, 1).setValue('Recent imports  (' + log.length + ' total, ' + committed.length + ' committed, ' +
    committed.reduce(function (s, e) { return s + e.rowsInserted; }, 0) + ' shifts inserted, ' +
    committed.reduce(function (s, e) { return s + e.rowsUpdated; }, 0) + ' updated)').setFontWeight('bold');
  var ih = ['Import ID', 'Time', 'Source', 'Teams', 'Dates', 'Inserted', 'Updated', 'Removed', 'Rejected', 'Status'];
  sh.getRange(R, 1, 1, ih.length).setValues([ih]).setFontWeight('bold').setBackground(th.soft);
  var recent = log.slice(0, 10).map(function (e) {
    return [e.importId, formatTimestamp_(e.timestamp, tz), safeCell_(e.sourceFile), safeCell_(e.teams),
      e.dateFrom + (e.dateTo && e.dateTo !== e.dateFrom ? ' → ' + e.dateTo : ''),
      e.rowsInserted, e.rowsUpdated, e.rowsRemoved, e.rowsRejected, e.status];
  });
  if (recent.length) sh.getRange(R + 1, 1, recent.length, ih.length).setValues(recent);
  else sh.getRange(R + 1, 1).setValue('No imports yet.');

  if (created) {
    sh.setFrozenRows(H);
    [180, 140, 80, 105, 95, 90, 85, 115, 140, 80, 190, 90, 80].forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  }
  sh.setTabColor(th.accent); // every rebuild, so a theme change re-colors the tab
  applySheetFont_(sh, th);
  return created ? 'Created the "' + name + '" sheet.' : 'Refreshed the "' + name + '" sheet.';
}

/** Rebuilds the dashboard; returns a message, or null if it failed (logged). */
function rebuildDashboardSafe_() {
  try { return rebuildDashboard_(); }
  catch (e) { logError_('rebuildDashboardSafe_', e); return null; }
}
