/**
 * WebApp.gs
 * The web app: the same tools as the Sheets menu, in a browser tab (Deploy → New deployment →
 * Web app; see docs/WEB_APP.md). doGet(e) renders one page per tool, ?page=<key>, from the
 * existing dialog files plus a navigation bar (WebShell.html), so a dialog and its page are the
 * same file. window.WEB_APP tells the page it runs in the web app (ClientCore: closeDialog goes
 * back, sheets open in a new tab). Daily schedules, staff sheets and the Dashboard stay sheets:
 * the pages link to them.
 *
 * Access: the web app runs as the person opening it (appsscript.json → webapp), so only people
 * who can edit the spreadsheet can use it. The spreadsheet is found by the ID remembered in
 * getSs_() the last time it was opened.
 *
 * Dependencies: Schema.gs, Utils.gs, ConfigService.gs, Setup.gs, TeamService.gs, AuditService.gs,
 *   ValidationService.gs, ScheduleService.gs, MonitoringLinkService.gs
 */

/**
 * Pages: key → file, title, nav label (shown in the bar when set), where Close/Cancel go back to,
 * narrow (sidebar pages), init (needs an initialized spreadsheet), the page's BOOT data and
 * prefetch: the API calls the page makes when it opens, [[name, arg1, …], …]. doGet answers them
 * while building the page (WEB_APP.prefetch), so the page shows its data without a second round trip.
 */
var WEB_PAGES = {
  home: { file: 'WebHome', title: 'Home', nav: 'Home', init: false, prefetch: function () { return [['apiWebHome']]; } },
  schedule: { file: 'WebSchedule', title: 'Schedule', nav: 'Schedule',
    boot: function (p) { return { date: webDateParam_(p.date), teamIds: webListParam_(p.teams), flag: str_(p.flag), q: str_(p.q) }; },
    prefetch: function (p, b) { return [['apiWebDay', b.date, b.teamIds]]; } },
  dashboard: { file: 'WebDashboard', title: 'Dashboard', nav: 'Dashboard',
    boot: function (p) { return { date: webDateParam_(p.date) }; }, prefetch: function (p, b) { return [['apiWebDashboard', b.date]]; } },
  'import': { file: 'ImportDialog', title: 'Import Quinyx Export', nav: 'Import', prefetch: function () { return [['apiImportBootstrap']]; } },
  teams: { file: 'TeamManager', title: 'Manage Existing Teams', nav: 'Teams', prefetch: function () { return [['apiListTeams']]; } },
  team: { file: 'TeamDialog', title: 'Team', back: 'teams',
    boot: function (p) { return { teamId: str_(p.teamId), title: p.teamId ? 'Edit Team' : 'Create New Team' }; },
    prefetch: function (p, b) { return [['apiTeamDialogBootstrap', b.teamId]]; } },
  staff: { file: 'WebStaff', title: 'Staff', nav: 'Staff',
    boot: function (p) { return { teamId: str_(p.teamId), q: str_(p.q) }; }, prefetch: function (p, b) { return [['apiWebStaff', b.teamId]]; } },
  person: { file: 'WebPerson', title: 'Person', back: 'schedule',
    boot: function (p) { return { key: str_(p.key), week: webDateParam_(p.week) }; }, prefetch: function (p, b) { return [['apiWebPerson', b.key, b.week]]; } },
  links: { file: 'MonitoringLinksDialog', title: 'Monitoring Links', nav: 'Links', prefetch: function () { return [['apiLinksBootstrap']]; } },
  output: { file: 'WebLinksOutput', title: 'Monitoring Links output', back: 'links', prefetch: function () { return [['apiWebLinksOutput']]; } },
  settings: { file: 'SettingsDialog', title: 'Configure Display Settings', nav: 'Settings', prefetch: function () { return [['apiGetSettings']]; } },
  viewer: { file: 'Navigator', title: 'Schedule Viewer (sheet)', back: 'schedule', narrow: true,
    boot: function (p) { return { focus: str_(p.focus) }; }, prefetch: function () { return [['apiNavigatorBootstrap']]; } },
  directory: { file: 'StaffSidebar', title: 'Staff Directory (sidebar)', back: 'staff', narrow: true, prefetch: function () { return [['apiStaffBootstrap']]; } },
  history: { file: 'HistoryDialog', title: 'Import History', prefetch: function () { return [['apiImportHistory', 100]]; } },
  fields: { file: 'StaffFieldsDialog', title: 'Configure Staff Fields', back: 'staff', prefetch: function () { return [['apiStaffFieldsBootstrap']]; } },
  ids: { file: 'EmployeeIdDialog', title: 'Import Employee IDs', back: 'staff', prefetch: function () { return [['apiImportBootstrap']]; } },
  setup: { file: 'SetupDialog', title: 'Setup / Configure Spreadsheet', init: false, boot: function () { return { state: getSetupState_() }; } },
  help: { file: 'ReportDialog', title: 'About / Help', init: false, boot: function () { return { title: APP.NAME + ' ' + APP.VERSION, help: true }; } }
};

/** A yyyy-MM-dd URL parameter, or '' (the page then uses today). Pure. */
function webDateParam_(v) { v = str_(v); return isIsoDate_(v) ? v : ''; }
/** A comma-separated URL parameter as a list. Pure. */
function webListParam_(v) { return str_(v).split(',').map(str_).filter(Boolean); }

/**
 * Answers a page's prefetch calls: {"<name><JSON args>": {ok, data|error}}, the key ClientCore's api()
 * looks up. A failing call is passed on as its error, so the page shows it as usual.
 */
function webPrefetch_(calls) {
  var g = (function () { return this; })() || globalThis;
  var out = {};
  (calls || []).forEach(function (c) {
    var name = c[0], args = c.slice(1);
    if (!/^api\w+$/.test(name) || typeof g[name] !== 'function') return;
    out[name + JSON.stringify(args)] = g[name].apply(null, args);
  });
  return out;
}
var WEB_MAX_WIDTH_ = { wide: 1180, narrow: 760 };

/**
 * Browser-tab icon. Apps Script only takes an icon by URL, so the icons are hosted: the Default one
 * here, a theme's own in its theme file as a first-line marker "<!-- favicon: https://… -->". A brand
 * copy of a theme file (kept outside the repository) can point to a brand icon the same way.
 */
var WEB_DEFAULT_FAVICON_ = 'https://raw.githubusercontent.com/bencevalentinyi/Schedule-Manager/main/assets/favicons/default.png';

/** The icon URL from a theme file's "<!-- favicon: URL -->" marker, or ''. Only http(s) URLs. Pure. */
function faviconFromThemeHtml_(html) {
  var m = /<!--\s*favicon:\s*(https?:\/\/[^\s<>"]+)\s*-->/i.exec(str_(html));
  return m ? m[1] : '';
}

/** The icon of the active theme (Display Settings → Theme), or the default icon. */
function themeFaviconUrl_() {
  try {
    var theme = THEMES[getConfig_().UI_THEME];
    if (theme && theme.file) {
      var url = faviconFromThemeHtml_(HtmlService.createHtmlOutputFromFile(theme.file).getContent());
      if (url) return url;
    }
  } catch (e) { /* no theme file or not set up yet: default icon */ }
  return WEB_DEFAULT_FAVICON_;
}

/** Sets the tab icon; an icon Apps Script refuses never stops the page from opening. */
function withFavicon_(out) {
  try { out.setFaviconUrl(themeFaviconUrl_()); } catch (e) { logError_('withFavicon_', e); }
  return out;
}

/** Web app entry point (GET). */
function doGet(e) {
  var params = (e && e.parameter) || {};
  var key = WEB_PAGES[params.page] ? params.page : 'home';
  try {
    var page = WEB_PAGES[key];
    // Before setup only Home, Setup and Help open; the others need the system sheets.
    if (page.init !== false && !isInitialized_()) { key = 'setup'; page = WEB_PAGES.setup; }
    return renderWebPage_(key, params);
  } catch (err) {
    logError_('doGet', err);
    return webErrorPage_(toUserError_(err));
  }
}

/** The page's HTML: the dialog file evaluated with its BOOT data, plus the navigation bar. */
function renderWebPage_(key, params) {
  var page = WEB_PAGES[key];
  var t = HtmlService.createTemplateFromFile(page.file);
  var data = page.boot ? page.boot(params) : {};
  if (data.title === undefined) data.title = page.title;
  t.bootJson = jsonForHtml_(data);
  var url = webAppUrl_();
  var client = { url: url, page: key, back: page.back || 'home', spreadsheetUrl: getSs_().getUrl(),
    prefetch: page.prefetch ? webPrefetch_(page.prefetch(params, data)) : {} };
  var shell = HtmlService.createTemplateFromFile('WebShell');
  shell.nav = webNav_(key, url);
  shell.spreadsheetUrl = client.spreadsheetUrl;
  shell.appName = APP.NAME;
  shell.homeUrl = url + '?page=home';
  var head = '<script>window.WEB_APP = ' + jsonForHtml_(client) + ';</script>' +
    '<style>:root { --web-max: ' + (page.narrow ? WEB_MAX_WIDTH_.narrow : WEB_MAX_WIDTH_.wide) + 'px; }</style>';
  var content = t.evaluate().getContent();
  // Sidebar pages (Schedule, Staff) have no page header; give them one so the theme's mark and top bar show.
  var top = shell.evaluate().getContent() + webPageHeader_(content, data.title || page.title);
  var html = injectWebShell_(content, head, top);
  return withFavicon_(HtmlService.createHtmlOutput(html)
    .setTitle(APP.NAME + ' · ' + (data.title || page.title))
    .addMetaTag('viewport', 'width=device-width, initial-scale=1'));
}

/**
 * Adds the web-app parts to a page: `head` before </head>, the navigation bar right after <body>,
 * and the class "web-page" on <body>. Pure.
 */
function injectWebShell_(html, head, nav) {
  var out = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, head + '</head>') : head + html;
  var tagged = false;
  out = out.replace(/<body([^>]*)>/i, function (m, attrs) {
    tagged = true;
    var withClass = /\bclass\s*=\s*"/i.test(attrs) ? attrs.replace(/\bclass\s*=\s*"/i, 'class="web-page ') : attrs + ' class="web-page"';
    return '<body' + withClass + '>' + nav;
  });
  return tagged ? out : nav + out;
}

/** A page header with the title for pages that have none (sidebar pages), else ''. Pure. */
function webPageHeader_(html, title) {
  return /class\s*=\s*"[^"]*\bapp-header\b/i.test(html) ? '' : '<header class="app-header"><h1>' + escapeHtml_(title) + '</h1></header>';
}

/** Navigation items in order, with the current one marked. Pure apart from the URL passed in. */
function webNav_(current, url) {
  return Object.keys(WEB_PAGES).filter(function (k) { return WEB_PAGES[k].nav; }).map(function (k) {
    return { key: k, label: WEB_PAGES[k].nav, href: url + '?page=' + k, current: k === current || WEB_PAGES[current].back === k };
  });
}

/** The deployed web app's URL ('' when the script is not deployed as a web app). */
function webAppUrl_() {
  try { return ScriptApp.getService().getUrl() || ''; } catch (e) { return ''; }
}

function webErrorPage_(u) {
  var noAccess = /permission|access|not found|No item with the given ID/i.test(u.message);
  var body = '<main class="app-body"><div class="alert error" role="alert"><span class="alert-icon" aria-hidden="true">✕</span><div class="alert-body">' +
    '<span class="alert-title">' + escapeHtml_(noAccess ? 'You have no access to the schedule spreadsheet' : 'The page could not be opened') + '</span>' +
    '<div>' + escapeHtml_(u.message) + '</div>' +
    '<div class="small mt-2">' + escapeHtml_(noAccess ? 'Ask the owner to share the spreadsheet with you (editor), then reload this page.'
      : 'Reload the page. If it keeps failing, open the spreadsheet once and check Apps Script → Executions.') + '</div></div></div></main>';
  var styles = '';
  try { styles = include('Styles'); } catch (e) { styles = ''; }
  return withFavicon_(HtmlService.createHtmlOutput('<!DOCTYPE html><html><head><meta charset="utf-8">' + styles + '</head><body>' + body + '</body></html>')
    .setTitle(APP.NAME).addMetaTag('viewport', 'width=device-width, initial-scale=1'));
}

function escapeHtml_(s) {
  return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/* ------------------------------------------------------------------------ */
/* Client API (WebHome.html)                                                 */
/* ------------------------------------------------------------------------ */

/** Home page: setup state, teams with links to their sheets, the last import and the Monitoring Links sheet. */
function apiWebHome() {
  return apiCall_('apiWebHome', function () {
    var ss = getSs_();
    // Quick check from the (cached) configuration; the full sheet inspection only before setup.
    var state = isInitialized_()
      ? { initialized: true, healthy: true, needsUpgrade: versionNeedsUpgrade_(getConfig_().SYSTEM_VERSION), version: getConfig_().SYSTEM_VERSION, codeVersion: APP.VERSION }
      : getSetupState_();
    var out = { state: state, appName: APP.NAME, version: APP.VERSION, user: currentUserEmail_(), spreadsheetUrl: ss.getUrl(),
      spreadsheetName: ss.getName(), teams: [], lastImport: null, linksSheet: null, linkItems: 0 };
    if (!state.initialized || state.needsUpgrade) return out;
    out.teams = listTeams_().map(function (t) {
      var link = function (kind) { var sh = resolveTeamSheet_(t, kind); return sh ? sheetLink_(sh) : null; };
      return { teamId: t.teamId, teamName: t.teamName, active: t.active, status: t.status, schedule: link('schedule'), staff: link('staff') };
    });
    var last = readImportLog_()[0];
    if (last) out.lastImport = { importId: last.importId, status: last.status, sourceFile: last.sourceFile, timestamp: formatTimestamp_(last.timestamp), teams: last.teams };
    var links = ss.getSheetByName(LINKS_SHEET_);
    if (links) out.linksSheet = sheetLink_(links);
    out.linkItems = loadLinkTemplates_().length;
    return out;
  });
}

/** Maintenance from the web app (the Sheets menu's Maintenance and Validate items). Returns a report. */
function apiWebMaintenance(action) {
  return apiCall_('apiWebMaintenance', function () {
    if (action === 'structure') return { title: 'Spreadsheet Structure', report: validateStructure_() };
    requireInitialized_();
    if (action === 'data') return { title: 'Validate Data', report: validateData_() };
    if (action === 'repair') return { title: 'Repair Formatting', report: withLock_(function () { return repairAllFormatting_(); }, 60000) };
    if (action === 'rebuild') return { title: 'Rebuild Missing Sheets', report: withLock_(function () { return rebuildMissingSheets_(); }, 60000) };
    if (action === 'refresh') return { title: 'Refresh Schedule Data', report: refreshAllViews_() };
    fail_('VALIDATION', 'Unknown action "' + action + '".');
  });
}

/** The web app's URL for the Sheets menu ("Open Web App"). */
function apiWebAppUrl() {
  return apiCall_('apiWebAppUrl', function () { return { url: webAppUrl_() }; });
}
