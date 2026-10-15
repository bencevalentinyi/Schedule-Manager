/**
 * MembershipService.gs  (v1.1.1)
 * Shared staff directories and explicit employee-to-team membership.
 *
 * Rules
 *  - A staff directory is a staff sheet, identified by its sheet ID. Several teams
 *    may use the same directory (team.settings.staffSheetId).
 *  - Dedicated directory (used by exactly one team): every employee in it is a
 *    member of that team (implicit, as in earlier versions).
 *  - Shared directory (used by 2+ teams): membership is EXPLICIT — an employee is
 *    a member of team T only with an ACTIVE row (Employee ID, T) in _TEAM_MEMBERSHIP.
 *    Sharing never makes everyone a member of every team.
 *  - When a dedicated directory becomes shared, its existing employees receive
 *    explicit memberships for the team(s) already using it (backfill), so nothing
 *    changes for those teams.
 *  - The employee record itself (name, IDs, Active…) exists once, in the directory.
 *
 * Dependencies: Schema.gs, Utils.gs, SheetStore.gs, TeamService.gs, StaffService.gs
 */

var MEMBERSHIP_STATUS = { ACTIVE: 'ACTIVE', INACTIVE: 'INACTIVE' };

/** Teams (any status) whose staff directory is the given sheet ID. */
function teamsUsingStaffSheet_(sheetId, teams) {
  if (sheetId === null || sheetId === undefined || sheetId === '') return [];
  return (teams || listTeams_()).filter(function (t) { return String(t.settings.staffSheetId) === String(sheetId); });
}

function isSharedDirectory_(team, teams) {
  return teamsUsingStaffSheet_(team.settings.staffSheetId, teams).length > 1;
}

/** All membership rows; [] before the v1.1.1 upgrade created the sheet. */
function readMemberships_() {
  if (!getSheet_(T_MEMBERSHIP.sheet)) return [];
  return readTable_(T_MEMBERSHIP).rows.map(function (r) {
    return { employeeId: str_(r.employeeId), teamId: str_(r.teamId), status: str_(r.status).toUpperCase() || MEMBERSHIP_STATUS.ACTIVE,
      teamRole: str_(r.teamRole), source: str_(r.source), _row: r._row };
  }).filter(function (m) { return m.employeeId && m.teamId; });
}

/** teamId -> idKey(employeeId) -> membership (pure). */
function membershipIndex_(rows) {
  var idx = {};
  rows.forEach(function (m) {
    (idx[m.teamId] = idx[m.teamId] || {})[idKey_(m.employeeId)] = m;
  });
  return idx;
}

/**
 * Membership checker for one team (pure given its inputs).
 * @return {function(staffRow): {member: boolean, status: string, role: string}}
 */
function membershipChecker_(teamId, shared, index) {
  var mine = (index && index[teamId]) || {};
  return function (staff) {
    if (!staff) return { member: false, status: 'UNKNOWN', role: '' };
    if (!shared) return { member: true, status: 'DIRECTORY', role: '' };
    var m = mine[idKey_(staff.employeeId)];
    if (!m) return { member: false, status: 'NONE', role: '' };
    return { member: m.status === MEMBERSHIP_STATUS.ACTIVE, status: m.status, role: m.teamRole };
  };
}

/** Checker for a team using live data. */
function memberCheckForTeam_(team, teams, memberships) {
  var shared = isSharedDirectory_(team, teams);
  return membershipChecker_(team.teamId, shared, membershipIndex_(memberships || (shared ? readMemberships_() : [])));
}

/**
 * Upserts memberships. Each change: {employeeId, teamId, status, teamRole?, source}.
 * Existing rows are updated in place; new rows are appended in one batch.
 */
function setMemberships_(changes) {
  if (!changes.length) return { updated: 0, added: 0 };
  var rows = readMemberships_();
  var byKey = {};
  rows.forEach(function (m) { byKey[m.teamId + '|' + idKey_(m.employeeId)] = m; });
  var now = new Date(), adds = [], updated = 0;
  changes.forEach(function (c) {
    var id = normalizeEmployeeId_(c.employeeId, false);
    if (!id || !c.teamId) return;
    var status = c.status === MEMBERSHIP_STATUS.INACTIVE ? MEMBERSHIP_STATUS.INACTIVE : MEMBERSHIP_STATUS.ACTIVE;
    var cur = byKey[c.teamId + '|' + idKey_(id)];
    if (cur) {
      var role = c.teamRole === undefined ? cur.teamRole : str_(c.teamRole);
      if (cur.status === status && cur.teamRole === role) return;
      updateObject_(T_MEMBERSHIP, { _row: cur._row, status: status, teamRole: role, source: c.source || cur.source, updatedAt: now });
      updated++;
    } else {
      var row = { employeeId: id, teamId: c.teamId, status: status, teamRole: str_(c.teamRole), source: c.source || 'ADMIN', createdAt: now, updatedAt: now };
      adds.push(row);
      byKey[c.teamId + '|' + idKey_(id)] = row;
    }
  });
  appendObjects_(T_MEMBERSHIP, adds);
  return { updated: updated, added: adds.length };
}

/**
 * Gives every employee of a directory an ACTIVE membership in the given teams
 * when no membership row exists yet (never re-activates INACTIVE rows).
 */
function backfillMemberships_(team, teamIds, source) {
  var st = readStaff_(team);
  var existing = membershipIndex_(readMemberships_());
  var changes = [];
  st.rows.forEach(function (r) {
    if (!r.employeeId) return;
    teamIds.forEach(function (t) {
      if (existing[t] && existing[t][idKey_(r.employeeId)]) return;
      changes.push({ employeeId: r.employeeId, teamId: t, status: MEMBERSHIP_STATUS.ACTIVE, source: source });
    });
  });
  return setMemberships_(changes).added;
}

/**
 * Called after a team starts using a directory. If the directory is now shared,
 * the teams that already used it keep all their employees (backfill); the new
 * team gets members only if addAllToNewTeam is true.
 */
function onDirectoryShared_(team, addAllToNewTeam) {
  var teams = listTeams_();
  var users = teamsUsingStaffSheet_(team.settings.staffSheetId, teams);
  if (users.length < 2) return { shared: false, backfilled: 0, addedToNew: 0 };
  var others = users.filter(function (t) { return t.teamId !== team.teamId; }).map(function (t) { return t.teamId; });
  var backfilled = backfillMemberships_(team, others, 'BACKFILL');
  var addedToNew = addAllToNewTeam ? backfillMemberships_(team, [team.teamId], 'ADMIN') : 0;
  return { shared: true, backfilled: backfilled, addedToNew: addedToNew };
}

/** Staff directories that a team may share: staff sheets of other READY teams. */
function listStaffDirectories_(excludeTeamId) {
  var teams = listTeams_();
  var dirs = {};
  teams.forEach(function (t) {
    if (t.status !== TEAM_STATUS.READY || !t.settings.staffSheetId) return;
    var sh = resolveTeamSheet_(t, 'staff');
    if (!sh) return;
    var id = String(sh.getSheetId());
    dirs[id] = dirs[id] || { sheetId: sh.getSheetId(), sheetName: sh.getName(), teams: [] };
    dirs[id].teams.push({ teamId: t.teamId, teamName: t.teamName });
  });
  return Object.keys(dirs).map(function (k) { return dirs[k]; }).filter(function (d) {
    return !excludeTeamId || d.teams.some(function (t) { return t.teamId !== excludeTeamId; });
  });
}

/* ------------------------------------------------------------------------ */
/* Client API (StaffSidebar.html)                                            */
/* ------------------------------------------------------------------------ */

/** Memberships of one employee across all teams sharing the team's directory. */
function apiStaffMemberships(teamId, employeeId) {
  return apiCall_('apiStaffMemberships', function () {
    var team = requireTeam_(teamId);
    var teams = listTeams_();
    var users = teamsUsingStaffSheet_(team.settings.staffSheetId, teams);
    var shared = users.length > 1;
    var idx = membershipIndex_(readMemberships_());
    return {
      shared: shared,
      teams: users.map(function (t) {
        var m = idx[t.teamId] && idx[t.teamId][idKey_(employeeId)];
        return { teamId: t.teamId, teamName: t.teamName, member: !shared || !!(m && m.status === MEMBERSHIP_STATUS.ACTIVE), teamRole: m ? m.teamRole : '' };
      })
    };
  });
}

/** Saves memberships of one employee: list of {teamId, member, teamRole}. */
function apiStaffSaveMemberships(teamId, employeeId, list) {
  return apiCall_('apiStaffSaveMemberships', function () {
    return withLock_(function () {
      var team = requireTeam_(teamId);
      var users = teamsUsingStaffSheet_(team.settings.staffSheetId).map(function (t) { return t.teamId; });
      var changes = (list || []).filter(function (x) { return users.indexOf(x.teamId) >= 0; }).map(function (x) {
        return { employeeId: employeeId, teamId: x.teamId, status: x.member ? MEMBERSHIP_STATUS.ACTIVE : MEMBERSHIP_STATUS.INACTIVE,
          teamRole: x.teamRole, source: 'STAFF_SIDEBAR' };
      });
      var r = setMemberships_(changes);
      users.forEach(function (id) { var t = getTeam_(id); if (t && t.status === TEAM_STATUS.READY) renderTeamViewSafe_(t, {}); });
      return r;
    });
  });
}
