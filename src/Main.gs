/**
 * Main.gs
 * Entry points: onOpen (menu), onEdit (view refresh / staff timestamps),
 * menu handlers and dialog openers.
 *
 * Dependencies: every service file.
 */

function onOpen() {
  var ui = SpreadsheetApp.getUi();
  ui.createMenu(APP.MENU)
    .addSubMenu(ui.createMenu('Setup & Configuration')
      .addItem('Setup / Configure Spreadsheet', 'menuSetup')
      .addItem('Create New Team', 'menuCreateTeam')
      .addItem('Manage Existing Teams', 'menuManageTeams')
      .addItem('Configure Team Types', 'menuTeamTypes')
      .addItem('Configure Staff Fields', 'menuStaffFields')
      .addItem('Configure Import Settings', 'menuImportSettings')
      .addItem('Configure Display Settings', 'menuDisplaySettings')
      .addItem('Validate Spreadsheet Structure', 'menuValidateStructure'))
    .addSubMenu(ui.createMenu('Schedule Import')
      .addItem('Import Quinyx Export', 'menuImport')
      .addItem('Preview Import (no changes)', 'menuPreviewImport')
      .addItem('Import History', 'menuImportHistory')
      .addItem('Undo Last Import', 'menuUndoLastImport'))
    .addSubMenu(ui.createMenu('Schedule Management')
      .addItem("Open Today's Schedule", 'menuOpenToday')
      .addItem('Select Schedule Date', 'menuSelectDate')
      .addItem('Refresh Schedule Data', 'menuRefresh')
      .addItem('View Team Schedule', 'menuViewTeamSchedule')
      .addItem('View Staff Directory', 'menuViewStaff'))
    .addSubMenu(ui.createMenu('Maintenance')
      .addItem('Rebuild Missing Sheets', 'menuRebuildMissing')
      .addItem('Repair Formatting', 'menuRepairFormatting')
      .addItem('Validate Data', 'menuValidateData')
      .addItem('Open System Configuration', 'menuOpenConfig')
      .addSeparator()
      .addItem('About / Help', 'menuHelp'))
    .addToUi();
}

/**
 * Simple trigger. Re-renders a team view when its date/filter cells change and
 * stamps "Last Updated" on edited staff rows. Never throws.
 */
function onEdit(e) {
  if (!e || !e.range) return;
  try {
    var sh = e.range.getSheet();
    if (sh.getName().charAt(0) === '_') return;
    var entry = getSheetIndex_()[String(sh.getSheetId())];
    if (!entry) return;
    if (entry.kind === 'schedule' && (e.range.getRow() > VIEW.FILTER_ROW || e.range.getLastRow() < VIEW.FILTER_ROW)) return;
    if (entry.kind === 'staff' && e.range.getLastRow() <= STAFF_LAYOUT.HEADER_ROW) return;
    var team = getTeam_(entry.teamId);
    if (!team || team.status !== TEAM_STATUS.READY) return;
    if (entry.kind === 'schedule') handleScheduleEdit_(team, e.range);
    else stampStaffRows_(sh, e.range);
  } catch (err) {
    logError_('onEdit', err);
  }
}

/* ------------------------------------------------------------------------ */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------ */

/** Runs a menu action and shows a readable alert on failure. */
function menuRun_(name, fn, needsInit) {
  try {
    if (needsInit !== false) requireInitialized_();
    return fn();
  } catch (e) {
    logError_(name, e);
    var u = toUserError_(e);
    SpreadsheetApp.getUi().alert(APP.NAME, u.message, SpreadsheetApp.getUi().ButtonSet.OK);
    return null;
  }
}

/**
 * Opens an HTML template as a modal dialog or sidebar.
 * @param {string} file template name
 * @param {Object} data passed to the page as BOOT (JSON)
 */
function showHtml_(file, title, data, width, height, sidebar) {
  var t = HtmlService.createTemplateFromFile(file);
  t.bootJson = jsonForHtml_(data || {});
  var out = t.evaluate().setTitle(title);
  if (sidebar) {
    SpreadsheetApp.getUi().showSidebar(out);
  } else {
    out.setWidth(width || 720).setHeight(height || 560);
    SpreadsheetApp.getUi().showModalDialog(out, title);
  }
}

function showReport_(title, report, intro) {
  showHtml_('ReportDialog', title, { title: title, intro: intro || '', report: report }, 680, 520);
}

function showTeamDialog_(teamId) {
  showHtml_('TeamDialog', teamId ? 'Edit Team' : 'Create New Team', { teamId: teamId || '' }, 780, 640);
}

/* ------------------------------------------------------------------------ */
/* Setup & Configuration                                                     */
/* ------------------------------------------------------------------------ */

function menuSetup() {
  menuRun_('menuSetup', function () {
    // The state is passed in directly so the dialog renders even if google.script.run is blocked.
    showHtml_('SetupDialog', 'Setup / Configure Spreadsheet', { state: getSetupState_() }, 700, 600);
  }, false);
}

function menuCreateTeam() {
  menuRun_('menuCreateTeam', function () { showTeamDialog_(null); });
}

function menuManageTeams() {
  menuRun_('menuManageTeams', function () { showHtml_('TeamManager', 'Manage Existing Teams', {}, 820, 580); });
}

function menuTeamTypes() {
  menuRun_('menuTeamTypes', function () { showHtml_('TeamTypeDialog', 'Configure Team Types', {}, 820, 640); });
}

function menuStaffFields() {
  menuRun_('menuStaffFields', function () { showHtml_('StaffFieldsDialog', 'Configure Staff Fields', {}, 820, 600); });
}

function menuImportSettings() {
  menuRun_('menuImportSettings', function () { showHtml_('SettingsDialog', 'Configure Import Settings', { tab: 'import' }, 820, 640); });
}

function menuDisplaySettings() {
  menuRun_('menuDisplaySettings', function () { showHtml_('SettingsDialog', 'Configure Display Settings', { tab: 'display' }, 820, 640); });
}

function menuValidateStructure() {
  menuRun_('menuValidateStructure', function () {
    showReport_('Spreadsheet Structure', validateStructure_(), 'Checks system sheets, columns, configuration and the references between teams, team types and import profiles.');
  }, false);
}

/* ------------------------------------------------------------------------ */
/* Schedule Import                                                           */
/* ------------------------------------------------------------------------ */

function menuImport() {
  menuRun_('menuImport', function () {
    showHtml_('ImportDialog', 'Import Quinyx Export', { previewOnly: false }, 900, 680);
  });
}

function menuPreviewImport() {
  menuRun_('menuPreviewImport', function () {
    showHtml_('ImportDialog', 'Preview Import (no changes are written)', { previewOnly: true }, 900, 680);
  });
}

function menuImportHistory() {
  menuRun_('menuImportHistory', function () { showHtml_('HistoryDialog', 'Import History', {}, 920, 600); });
}

function menuUndoLastImport() {
  menuRun_('menuUndoLastImport', function () {
    var ui = SpreadsheetApp.getUi();
    var cand = findUndoCandidate_();
    if (!cand) { ui.alert(APP.NAME, 'There is no committed import to undo.', ui.ButtonSet.OK); return; }
    var msg = 'Undo import ' + cand.importId + '?\n\n' +
      'File: ' + cand.sourceFile + '\nTime: ' + formatTimestamp_(cand.timestamp) + '\nTeams: ' + cand.teams + '\n' +
      'Inserted ' + cand.rowsInserted + ', updated ' + cand.rowsUpdated + ', removed ' + cand.rowsRemoved + '.\n\n' +
      (cand.status === IMPORT_STATUS.COMMITTING ? 'This import was INTERRUPTED; undo rolls back whatever it wrote.\n\n' : '') +
      'Inserted shifts are deleted and updated/removed shifts are restored to their previous values.';
    if (ui.alert('Undo Last Import', msg, ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
    var r = withLock_(function () { return undoImport_(cand.importId); }, 60000);
    ui.alert(APP.NAME, 'Import ' + r.importId + ' was undone: ' + r.deleted + ' shift(s) deleted, ' + r.restored + ' restored' +
      (r.skipped ? ', ' + r.skipped + ' skipped because they were changed after that import' : '') + '.', ui.ButtonSet.OK);
  });
}

/* ------------------------------------------------------------------------ */
/* Schedule Management                                                       */
/* ------------------------------------------------------------------------ */

function menuOpenToday() {
  menuRun_('menuOpenToday', function () {
    var cfg = getConfig_();
    var current = teamForSheet_(getSs_().getActiveSheet());
    var ready = listTeams_().filter(function (t) { return t.status === TEAM_STATUS.READY; });
    var team = current ? current.team : (ready.length === 1 ? ready[0] : null);
    if (!team) {
      if (!ready.length) fail_('NO_TEAMS', 'There are no teams yet. Use Setup & Configuration → Create New Team.');
      showHtml_('Navigator', "Open Today's Schedule", { mode: 'today' }, 440, 300);
      return;
    }
    renderTeamView_(team, { date: todayIso_(cfg.TIMEZONE) });
    resolveTeamSheet_(team, 'schedule').activate();
  });
}

function menuSelectDate() {
  menuRun_('menuSelectDate', function () { showHtml_('Navigator', 'Select Schedule Date', { mode: 'date' }, 440, 320); });
}

function menuRefresh() {
  menuRun_('menuRefresh', function () {
    var ss = getSs_();
    var current = teamForSheet_(ss.getActiveSheet());
    if (current) {
      renderTeamView_(current.team, {});
      ss.toast('Schedule refreshed from stored data.', APP.NAME, 4);
      return;
    }
    var rep = refreshAllViews_();
    if (rep.warnings.length) showReport_('Refresh Schedule Data', rep);
    else ss.toast('All team views and the dashboard were refreshed.', APP.NAME, 4);
  });
}

function menuViewTeamSchedule() {
  menuRun_('menuViewTeamSchedule', function () { showHtml_('Navigator', 'View Team Schedule', { mode: 'team' }, 440, 300); });
}

function menuViewStaff() {
  menuRun_('menuViewStaff', function () { showHtml_('StaffSidebar', 'Staff Directory', {}, 0, 0, true); });
}

/* ------------------------------------------------------------------------ */
/* Maintenance                                                               */
/* ------------------------------------------------------------------------ */

function menuRebuildMissing() {
  menuRun_('menuRebuildMissing', function () {
    showReport_('Rebuild Missing Sheets', withLock_(function () { return rebuildMissingSheets_(); }, 60000));
  });
}

function menuRepairFormatting() {
  menuRun_('menuRepairFormatting', function () {
    showReport_('Repair Formatting', withLock_(function () { return repairAllFormatting_(); }, 60000),
      'Reapplied layout, formats, validation and conditional formatting. Data and selected dates/filters were kept.');
  });
}

function menuValidateData() {
  menuRun_('menuValidateData', function () {
    showReport_('Validate Data', validateData_(), 'Checks schedule records, staff sheets and import state. Nothing is modified except the derived _STAFF_MASTER index.');
  });
}

function menuOpenConfig() {
  menuRun_('menuOpenConfig', function () {
    var sh = requireSheet_(T_CONFIG.sheet);
    if (sh.isSheetHidden()) sh.showSheet();
    sh.activate();
    getSs_().toast('Prefer Configure Display/Import Settings: they validate values before saving.', APP.NAME, 6);
  });
}

function menuHelp() {
  menuRun_('menuHelp', function () {
    showHtml_('ReportDialog', 'About / Help', { title: APP.NAME + ' ' + APP.VERSION, help: true }, 720, 600);
  }, false);
}
