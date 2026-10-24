/**
 * Main.gs
 * Entry points: onOpen (menu), onEdit (view refresh / staff timestamps),
 * menu handlers and dialog openers.
 *
 * Dependencies: every service file.
 */

function onOpen() {
  var ui = SpreadsheetApp.getUi();
  var menu = ui.createMenu(APP.MENU)
    .addSubMenu(ui.createMenu('Setup & Configuration')
      .addItem('Setup / Configure Spreadsheet', 'menuSetup')
      .addItem('Create New Team', 'menuCreateTeam')
      .addItem('Manage Existing Teams', 'menuManageTeams')
      .addItem('Configure Staff Fields', 'menuStaffFields')
      .addItem('Configure Display Settings', 'menuDisplaySettings')
      .addItem('Validate Spreadsheet Structure', 'menuValidateStructure'))
    .addSubMenu(ui.createMenu('Schedule Import')
      .addItem('Import Quinyx Export', 'menuImport')
      .addItem('Import History', 'menuImportHistory')
      .addItem('Undo Last Import', 'menuUndoLastImport'))
    .addSubMenu(ui.createMenu('Schedule Management')
      .addItem('Schedule Viewer (date, filters, refresh)', 'menuViewTeamSchedule')
      .addItem("Open Today's Schedule", 'menuOpenToday')
      .addItem('Select Schedule Date', 'menuSelectDate')
      .addItem('Refresh Schedule Data', 'menuRefresh')
      .addSeparator()
      .addItem('View Staff Directory', 'menuViewStaff')
      .addItem('Import Staff Data (IDs, emails…)', 'menuImportEmployeeIds')
      .addItem('Monitoring Links', 'menuMonitoringLinks'))
    .addSubMenu(ui.createMenu('Maintenance')
      .addItem('Rebuild Missing Sheets', 'menuRebuildMissing')
      .addItem('Repair Formatting', 'menuRepairFormatting')
      .addItem('Validate Data', 'menuValidateData')
      .addItem('Open System Configuration', 'menuOpenConfig')
      .addSeparator()
      .addItem('Open Web App', 'menuOpenWebApp')
      .addItem('About / Help', 'menuHelp'));
  addExtensionsMenu_(ui, menu);
  menu.addToUi();
}

/**
 * Optional extension files (e.g. TaxiRequests.gs) register themselves in SM_EXTENSIONS: {id, title, menu: [{label, fn}], tests}.
 * Without such a file there is no Extensions menu and nothing else changes.
 */
function smExtensions_() {
  return typeof SM_EXTENSIONS !== 'undefined' && Array.isArray(SM_EXTENSIONS) ? SM_EXTENSIONS : [];
}

function addExtensionsMenu_(ui, menu) {
  var items = [];
  smExtensions_().forEach(function (e) { (e.menu || []).forEach(function (m) { items.push(m); }); });
  if (!items.length) return;
  var sub = ui.createMenu('Extensions');
  items.forEach(function (m) { sub.addItem(m.label, m.fn); });
  menu.addSubMenu(sub);
}

/**
 * Simple trigger. Re-renders a team view when its date/filter cells change and
 * stamps "Last Updated" on edited staff rows. Never throws.
 */
function onEdit(e) {
  if (!e || !e.range) return;
  try {
    var sh = e.range.getSheet();
    if (sh.getName().charAt(0) === '_') {
      if (sh.getName() === T_CONFIG.sheet) resetConfigMemo_(); // edited by hand: drop the cached configuration
      return;
    }
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

/**
 * Installation self-check. Select "checkInstall" in the Apps Script editor and
 * click Run: the log lists every missing or broken project file.
 * Uses no other project file, so it works even when some files are missing.
 */
function checkInstall() {
  var g = (function () { return this; })() || globalThis;
  var scripts = {
    Schema: 'APP', Utils: 'logError_', SheetStore: 'readTable_', ConfigService: 'getConfig_', Setup: 'initializeSystem_',
    TeamTypeService: 'listTeamTypes_', TeamService: 'listTeams_', StaffFieldService: 'listStaffFields_', StaffService: 'layoutStaffSheet_', StaffImportService: 'planStaffImport_',
    ScheduleService: 'renderDailyView_', DashboardService: 'rebuildDashboard_', QuinyxParser: 'parseCsv_',
    MonitoringLinkService: 'buildMonitoringUrls_', ImportMappingService: 'listProfiles_', ImportService: 'buildImportPlan_', ValidationService: 'validateStructure_',
    AuditService: 'readImportLog_', WebApp: 'doGet', WebDataService: 'apiWebDay', Main: 'onOpen', Tests: 'runUnitTests'
  };
  var html = ['Styles', 'ClientCore', 'SetupDialog', 'TeamDialog', 'TeamManager', 'StaffFieldsDialog', 'SettingsDialog', 'StaffImportDialog', 'MonitoringLinksDialog', 'ImportDialog', 'ImportPreview', 'HistoryDialog', 'StaffSidebar', 'Navigator', 'ReportDialog',
    'WebShell', 'WebHome', 'WebSchedule', 'WebDashboard', 'WebPerson', 'WebStaff', 'WebLinksOutput'];
  var problems = [];
  Object.keys(scripts).forEach(function (file) {
    if (typeof g[scripts[file]] === 'undefined') problems.push('Script file "' + file + '" is missing, empty, incomplete or contains another file\'s code (expected to define ' + scripts[file] + ').');
  });
  html.forEach(function (file) {
    try {
      var content = HtmlService.createHtmlOutputFromFile(file).getContent();
      if (!content || content.length < 50) problems.push('HTML file "' + file + '" is empty.');
    } catch (e) {
      problems.push('HTML file "' + file + '" is missing or misnamed (create it with + → HTML, exact name "' + file + '").');
    }
  });
  // Theme files are optional: a missing one only means that theme falls back to the default look.
  if (typeof g.THEMES !== 'undefined') Object.keys(g.THEMES).forEach(function (k) {
    var file = g.THEMES[k].file;
    if (!file) return;
    try { HtmlService.createHtmlOutputFromFile(file); console.log('Theme ' + k + ': "' + file + '" present.'); }
    catch (e) { console.log('Theme ' + k + ': "' + file + '" not added (optional; the default look is used).'); }
  });
  if (typeof g.APP !== 'undefined' && g.APP.VERSION) console.log('Code version: ' + g.APP.VERSION);
  // Web app tab icon: which address the active theme gives, and whether Apps Script accepts it.
  if (typeof g.themeFaviconUrl_ === 'function') {
    try {
      var icon = g.themeFaviconUrl_();
      var themeKey = '';
      try { themeKey = g.getConfig_().UI_THEME; } catch (e) { themeKey = '(not set up)'; }
      var accepted = 'accepted';
      try { HtmlService.createHtmlOutput('').setFaviconUrl(icon); } catch (e) { accepted = 'REFUSED: ' + e.message; }
      console.log('Web app tab icon (theme ' + themeKey + '): ' + icon + ' (' + accepted + ')');
      console.log('Web app URL: ' + (g.webAppUrl_() || 'not deployed') + '. The deployed version only changes with Deploy → Manage deployments → Edit → New version.');
    } catch (e) { console.log('PROBLEM: the web app tab icon could not be checked: ' + e.message); }
  }
  if (problems.length) problems.forEach(function (p) { console.log('PROBLEM: ' + p); });
  else console.log('All ' + Object.keys(scripts).length + ' script files and ' + html.length + ' HTML files are present. If something still fails, check Executions for the error message.');
  return problems;
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
 * Standard dialog sizes [width, height]. Every page has a fixed
 * header and footer and scrolls internally, so these sizes fit all content.
 */
var DIALOG_SIZE = {
  SMALL: [520, 420],    // short reports, confirmations
  MEDIUM: [780, 620],   // forms and configuration
  LARGE: [960, 700]     // wizards and wide tables
};

/**
 * Opens an HTML template as a modal dialog or sidebar.
 * @param {string} file template name
 * @param {Object} data passed to the page as BOOT (JSON); data.title is also the page heading
 * @param {number[]|number} size DIALOG_SIZE entry (or a width, followed by height)
 */
function showHtml_(file, title, data, size, height, sidebar) {
  var t = HtmlService.createTemplateFromFile(file);
  data = data || {};
  if (data.title === undefined) data.title = title;
  t.bootJson = jsonForHtml_(data);
  var out = t.evaluate().setTitle(title);
  if (sidebar) {
    SpreadsheetApp.getUi().showSidebar(out);
  } else {
    var dims = Array.isArray(size) ? size : [size || DIALOG_SIZE.MEDIUM[0], height || DIALOG_SIZE.MEDIUM[1]];
    out.setWidth(dims[0]).setHeight(dims[1]);
    // The page shows its own title and subtitle; the frame shows the application name.
    SpreadsheetApp.getUi().showModalDialog(out, APP.NAME);
  }
}

function showReport_(title, report, intro) {
  showHtml_('ReportDialog', title, { title: title, intro: intro || '', report: report }, DIALOG_SIZE.MEDIUM);
}

function showTeamDialog_(teamId) {
  showHtml_('TeamDialog', teamId ? 'Edit Team' : 'Create New Team', { teamId: teamId || '' }, DIALOG_SIZE.LARGE);
}

function showScheduleViewer_(focus) {
  showHtml_('Navigator', 'Schedule Viewer', { focus: focus || '' }, 0, 0, true);
}

/* ------------------------------------------------------------------------ */
/* Setup & Configuration                                                     */
/* ------------------------------------------------------------------------ */

function menuSetup() {
  menuRun_('menuSetup', function () {
    // The state is passed in directly so the dialog renders even if google.script.run is blocked.
    showHtml_('SetupDialog', 'Setup / Configure Spreadsheet', { state: getSetupState_() }, DIALOG_SIZE.MEDIUM);
  }, false);
}

function menuCreateTeam() {
  menuRun_('menuCreateTeam', function () { showTeamDialog_(null); });
}

function menuManageTeams() {
  menuRun_('menuManageTeams', function () { showHtml_('TeamManager', 'Manage Existing Teams', {}, DIALOG_SIZE.LARGE); });
}

function menuStaffFields() {
  menuRun_('menuStaffFields', function () { showHtml_('StaffFieldsDialog', 'Configure Staff Fields', {}, DIALOG_SIZE.LARGE); });
}

function menuDisplaySettings() {
  menuRun_('menuDisplaySettings', function () { showHtml_('SettingsDialog', 'Configure Display Settings', {}, DIALOG_SIZE.LARGE); });
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
    showHtml_('ImportDialog', 'Import Quinyx Export', {}, DIALOG_SIZE.LARGE);
  });
}

function menuImportHistory() {
  menuRun_('menuImportHistory', function () { showHtml_('HistoryDialog', 'Import History', {}, DIALOG_SIZE.LARGE); });
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
      showScheduleViewer_('today');
      return;
    }
    renderTeamView_(team, { date: todayIso_(cfg.TIMEZONE) });
    resolveTeamSheet_(team, 'schedule').activate();
  });
}

function menuSelectDate() {
  menuRun_('menuSelectDate', function () { showScheduleViewer_('date'); });
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
  menuRun_('menuViewTeamSchedule', function () { showScheduleViewer_('team'); });
}

function menuViewStaff() {
  menuRun_('menuViewStaff', function () { showHtml_('StaffSidebar', 'Staff Directory', {}, 0, 0, true); });
}

function menuImportEmployeeIds() {
  menuRun_('menuImportEmployeeIds', function () { showHtml_('StaffImportDialog', 'Import Staff Data', {}, DIALOG_SIZE.LARGE); });
}

function menuMonitoringLinks() {
  menuRun_('menuMonitoringLinks', function () { showHtml_('MonitoringLinksDialog', 'Monitoring Links', {}, DIALOG_SIZE.LARGE); });
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
    getSs_().toast('Prefer Configure Display Settings: it validates values before saving. Maintenance → Repair Formatting hides this sheet again.', APP.NAME, 6);
  });
}

/** Shows the web app's link (after it was deployed: Deploy → New deployment → Web app). */
function menuOpenWebApp() {
  menuRun_('menuOpenWebApp', function () {
    getSs_(); // remembers this spreadsheet for the web app
    var url = webAppUrl_();
    var body = url
      ? '<p>Open the same tools in a browser tab:</p><p><a href="' + escapeHtml_(url) + '" target="_blank" rel="noopener" style="font-weight:600">Open the web app ↗</a></p>' +
        '<p style="color:#545d69">Anyone who can edit this spreadsheet can use it. Bookmark the link.</p>'
      : '<p>The web app is not deployed yet.</p><p style="color:#545d69">In the Apps Script editor: <b>Deploy → New deployment</b>, type <b>Web app</b>, Execute as <b>User accessing the web app</b>, then <b>Deploy</b>. See docs/WEB_APP.md.</p>';
    var out = HtmlService.createHtmlOutput('<div style="font:13px/1.5 Arial,sans-serif;padding:4px 8px">' + body + '</div>').setWidth(420).setHeight(200);
    SpreadsheetApp.getUi().showModalDialog(out, 'Web App');
  }, false);
}

function menuHelp() {
  menuRun_('menuHelp', function () {
    showHtml_('ReportDialog', 'About / Help', { title: APP.NAME + ' ' + APP.VERSION, help: true }, DIALOG_SIZE.MEDIUM);
  }, false);
}
