/**
 * Utils.gs
 * Shared helpers. Everything above the "Apps Script service helpers" divider is
 * pure JavaScript (no Google services) so it can be unit-tested anywhere.
 */

/* ------------------------------------------------------------------------ */
/* Errors and reports                                                        */
/* ------------------------------------------------------------------------ */

/**
 * Application error with a stable code and a user-facing message.
 * @param {string} code    Machine-readable code (e.g. MISSING_SHEET).
 * @param {string} message Message safe to show to the administrator.
 * @param {*=} details     Optional structured details (e.g. a validation report).
 */
function AppError(code, message, details) {
  this.name = 'AppError';
  this.code = code || 'ERROR';
  this.message = message;
  this.details = details || null;
  this.stack = new Error(message).stack;
}
AppError.prototype = Object.create(Error.prototype);
AppError.prototype.constructor = AppError;

function fail_(code, message, details) {
  throw new AppError(code, message, details);
}

/** A validation report separating fatal errors, warnings and information. */
function newReport_() {
  return { fatal: [], warnings: [], info: [] };
}

function mergeReport_(target, source) {
  if (!source) return target;
  ['fatal', 'warnings', 'info'].forEach(function (k) {
    (source[k] || []).forEach(function (m) { target[k].push(m); });
  });
  return target;
}

/* ------------------------------------------------------------------------ */
/* Value helpers                                                             */
/* ------------------------------------------------------------------------ */

function isBlank_(v) {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

function isDate_(v) {
  return Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime());
}

function str_(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

function toBool_(v) {
  if (v === true) return true;
  if (v === false || v === null || v === undefined) return false;
  return /^(true|yes|y|1|x|on)$/i.test(String(v).trim());
}

function toNumber_(v, fallback) {
  if (typeof v === 'number' && isFinite(v)) return v;
  var s = str_(v);
  if (s === '') return fallback;
  var n = Number(s.replace(',', '.'));
  return isFinite(n) ? n : fallback;
}

function parseJson_(v, fallback) {
  if (v && typeof v === 'object') return v;
  var s = str_(v);
  if (!s) return fallback;
  try { return JSON.parse(s); } catch (e) { return fallback; }
}

/** JSON.stringify with sorted keys, so equal objects produce equal strings. */
function stableStringify_(v) {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return '[' + v.map(stableStringify_).join(',') + ']';
  if (typeof v === 'object') {
    return '{' + Object.keys(v).sort().map(function (k) {
      return JSON.stringify(k) + ':' + stableStringify_(v[k]);
    }).join(',') + '}';
  }
  return JSON.stringify(v);
}

function uniq_(arr) {
  var seen = {}, out = [];
  arr.forEach(function (x) {
    var k = String(x);
    if (!seen[k]) { seen[k] = true; out.push(x); }
  });
  return out;
}

function splitList_(s) {
  return str_(s).split(/[,;\n]/).map(function (x) { return x.trim(); }).filter(Boolean);
}

/** Lower-case, accent-free, punctuation collapsed to single spaces. */
function normText_(s) {
  return String(s === null || s === undefined ? '' : s)
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** normText_ without spaces: used for header and team-name comparisons. */
function normKey_(s) {
  return normText_(s).replace(/ /g, '');
}

/** Name comparison form. Deliberately exact (after case/accent/space folding). */
function normName_(s) {
  return normText_(s);
}

/**
 * Normalizes an employee identifier: trims, removes inner whitespace, removes a
 * trailing ".0" produced by spreadsheet numbers, optionally strips leading zeros.
 */
function normalizeEmployeeId_(v, stripLeadingZeros) {
  var s = str_(v).replace(/\s+/g, '');
  if (/^\d+\.0+$/.test(s)) s = s.replace(/\.0+$/, '');
  if (stripLeadingZeros && /^0+\d/.test(s)) s = s.replace(/^0+/, '');
  return s;
}

/**
 * Shift-type comparison form: whitespace trimmed and collapsed, otherwise exact
 * (case-sensitive). Deliberately no fuzzy matching.
 */
function normShiftType_(s) {
  return str_(s).replace(/\s+/g, ' ');
}

/** 1-based column number for a letter ("A" -> 1, "AA" -> 27), or 0 if invalid/blank. */
function columnNumber_(letters) {
  var s = str_(letters).toUpperCase();
  if (!/^[A-Z]{1,3}$/.test(s)) return 0;
  var n = 0;
  for (var i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64);
  return n;
}

/** Case-insensitive lookup key for an employee ID. */
function idKey_(id) {
  return str_(id).toUpperCase();
}

/**
 * Prevents source data from being interpreted as a formula when written to a cell.
 * Strings beginning with = + - @ are prefixed with an apostrophe (stored as text).
 */
function safeCell_(v) {
  if (typeof v !== 'string') return v;
  return /^[=+\-@]/.test(v) ? "'" + v : v;
}

/** 32-bit FNV-1a hash as 8 hex chars (not cryptographic; used for change detection). */
function hashString_(s, seed) {
  var h = seed === undefined ? 0x811c9dc5 : seed;
  s = String(s);
  for (var i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ('0000000' + (h >>> 0).toString(16)).slice(-8);
}

function hash64_(s) {
  return hashString_(s) + hashString_(s, 0x6c62272e);
}

/* ------------------------------------------------------------------------ */
/* Calendar math on wall-clock values (timezone-free by design)             */
/* ------------------------------------------------------------------------ */
/*
 * Schedules are stored as wall-clock strings ("yyyy-MM-dd" and "yyyy-MM-dd HH:mm")
 * exactly as Quinyx shows them. Durations are computed on the wall clock, so a
 * shift crossing a DST change is off by the DST delta (documented limitation).
 */

function pad2_(n) { return (n < 10 ? '0' : '') + n; }

function ymd_(y, m, d) { return y + '-' + pad2_(m) + '-' + pad2_(d); }

function isValidYmd_(y, m, d) {
  if (!(y >= 1900 && y <= 2200) || !(m >= 1 && m <= 12) || !(d >= 1)) return false;
  var dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= dim;
}

function isIsoDate_(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
  return !!m && isValidYmd_(+m[1], +m[2], +m[3]);
}

function isIsoDateTime_(s) {
  var m = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})$/.exec(String(s));
  return !!m && isIsoDate_(m[1]) && +m[2] < 24 && +m[3] < 60;
}

/** Days since 1970-01-01 for an ISO date. */
function dayNumber_(iso) {
  var p = String(iso).split('-');
  return Math.round(Date.UTC(+p[0], +p[1] - 1, +p[2]) / 86400000);
}

function isoFromDayNumber_(n) {
  var d = new Date(n * 86400000);
  return ymd_(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

function addDays_(iso, k) { return isoFromDayNumber_(dayNumber_(iso) + k); }

/** Absolute wall-clock minutes for "yyyy-MM-dd HH:mm". */
function wallMinutes_(isoDateTime) {
  var s = String(isoDateTime);
  return dayNumber_(s.substr(0, 10)) * 1440 + (+s.substr(11, 2)) * 60 + (+s.substr(14, 2));
}

function isoDateTimeFromMinutes_(m) {
  var day = Math.floor(m / 1440), r = m - day * 1440;
  return isoFromDayNumber_(day) + ' ' + pad2_(Math.floor(r / 60)) + ':' + pad2_(r % 60);
}

function minutesToHm_(m) {
  var r = ((m % 1440) + 1440) % 1440;
  return pad2_(Math.floor(r / 60)) + ':' + pad2_(r % 60);
}

/** Google Sheets serial number (days since 1899-12-30) for absolute wall minutes. */
var SHEETS_EPOCH_DAY_ = 25569; // 1970-01-01 minus 1899-12-30
function serialFromMinutes_(m) { return m / 1440 + SHEETS_EPOCH_DAY_; }
function serialFromIsoDate_(iso) { return dayNumber_(iso) + SHEETS_EPOCH_DAY_; }

/** "HH:mm" -> minutes, or null. Accepts 24:00. */
function hmToMinutes_(s) {
  var m = /^(\d{1,2}):(\d{2})$/.exec(str_(s));
  if (!m) return null;
  var h = +m[1], mi = +m[2];
  if (mi > 59 || h > 24 || (h === 24 && mi > 0)) return null;
  return h * 60 + mi;
}

function formatMinutesAsDuration_(m) {
  var sign = m < 0 ? '-' : '';
  m = Math.abs(Math.round(m));
  return sign + Math.floor(m / 60) + ':' + pad2_(m % 60);
}

/* ------------------------------------------------------------------------ */
/* Sheet-name helpers (pure)                                                 */
/* ------------------------------------------------------------------------ */

var SHEET_NAME_MAX_ = 100;

/**
 * Makes a string safe as a worksheet name: removes characters that break XLSX
 * export or formulas ([ ] * ? / \ :), control characters and edge apostrophes.
 */
function sanitizeSheetName_(name) {
  var s = String(name === null || name === undefined ? '' : name)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\[\]\*\?\/\\:]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^'+|'+$/g, '')
    .trim();
  if (s.length > SHEET_NAME_MAX_) s = s.substr(0, SHEET_NAME_MAX_).trim();
  return s;
}

/** Applies a naming pattern containing {team}; truncates the team part to fit 100 chars. */
function applySheetPattern_(pattern, teamName) {
  var p = String(pattern || '{team}');
  if (p.indexOf('{team}') < 0) p = '{team} ' + p;
  var fixedLen = p.replace('{team}', '').length;
  var team = sanitizeSheetName_(teamName);
  var room = Math.max(1, SHEET_NAME_MAX_ - fixedLen);
  if (team.length > room) team = team.substr(0, room).trim();
  return sanitizeSheetName_(p.replace('{team}', team));
}

/** Returns a name not present in takenLower (lower-cased names), appending " (2)", " (3)"... */
function uniqueSheetName_(name, takenLower) {
  if (takenLower.indexOf(name.toLowerCase()) < 0) return name;
  for (var i = 2; i < 1000; i++) {
    var suffix = ' (' + i + ')';
    var candidate = name.length + suffix.length > SHEET_NAME_MAX_
      ? name.substr(0, SHEET_NAME_MAX_ - suffix.length).trim() + suffix
      : name + suffix;
    if (takenLower.indexOf(candidate.toLowerCase()) < 0) return candidate;
  }
  return name;
}

function columnLetter_(n) {
  var s = '';
  while (n > 0) {
    var r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Converts Date values in a structure to ISO strings so it can be returned to HTML. */
function toClient_(v) {
  if (isDate_(v)) return v.toISOString();
  if (Array.isArray(v)) return v.map(toClient_);
  if (v && typeof v === 'object') {
    var o = {};
    Object.keys(v).forEach(function (k) { if (k.charAt(0) !== '_' || k === '_row') o[k] = toClient_(v[k]); });
    return o;
  }
  return v;
}

/* ======================================================================== */
/* Apps Script service helpers (not pure)                                   */
/* ======================================================================== */

function getSs_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function getTz_() {
  return getSs_().getSpreadsheetTimeZone();
}

function todayIso_(tz) {
  return Utilities.formatDate(new Date(), tz || getTz_(), 'yyyy-MM-dd');
}

/** Converts a cell value (Date or text) to "yyyy-MM-dd" or ''. */
function cellToIsoDate_(v, tz) {
  if (isDate_(v)) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  var s = str_(v);
  if (isIsoDate_(s.substr(0, 10))) return s.substr(0, 10);
  return '';
}

/** Converts a cell value (Date or text) to "yyyy-MM-dd HH:mm" or the trimmed text. */
function cellToIsoDateTime_(v, tz) {
  if (isDate_(v)) return Utilities.formatDate(v, tz, 'yyyy-MM-dd HH:mm');
  return str_(v);
}

function formatTimestamp_(v, tz) {
  if (!isDate_(v)) return str_(v);
  return Utilities.formatDate(v, tz || getTz_(), 'yyyy-MM-dd HH:mm');
}

function newId_(prefix) {
  var stamp = Utilities.formatDate(new Date(), 'UTC', "yyyyMMdd'T'HHmmss");
  return prefix + '_' + stamp + '_' + Math.random().toString(36).slice(2, 6).toUpperCase();
}

function currentUserEmail_() {
  try { return Session.getActiveUser().getEmail() || ''; } catch (e) { return ''; }
}

/**
 * Runs fn while holding the document lock. Only public API entry points take the
 * lock; internal functions never do, so locks are never nested.
 */
function withLock_(fn, timeoutMs) {
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(timeoutMs || 30000)) {
    fail_('BUSY', 'Another Schedule Manager operation is currently running (for example an import). Wait a moment and try again.');
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/** Structured technical log. Never includes row data or personal data. */
function logError_(where, e) {
  var entry = {
    where: where,
    code: e && e.code,
    message: e && e.message ? e.message : String(e),
    stack: e && e.stack ? String(e.stack).split('\n').slice(0, 6).join(' | ') : ''
  };
  console.error(JSON.stringify(entry));
}

function logInfo_(where, data) {
  console.log(JSON.stringify({ where: where, data: data }));
}

/** Translates any error into a message suitable for the administrator. */
function toUserError_(e) {
  if (e instanceof AppError) return { code: e.code, message: e.message, details: toClient_(e.details) };
  var msg = String(e && e.message ? e.message : e);
  if (/permission|not authori[sz]ed|access denied/i.test(msg)) {
    return { code: 'PERMISSION', message: 'You do not have permission to perform this action, or the script has not been authorized. Ask the spreadsheet owner for edit access, or run any menu item once and accept the authorization prompt.' };
  }
  if (/Drive is not defined|Drive\.Files/i.test(msg)) {
    return { code: 'DRIVE_SERVICE', message: 'The Drive advanced service is not enabled. In the Apps Script editor open Services (+) and add "Drive API" (identifier "Drive"), or import the file as CSV.' };
  }
  if (/Service invoked too many times|exceeded maximum execution time/i.test(msg)) {
    return { code: 'QUOTA', message: 'Google Apps Script ran out of time or quota. Try a smaller file or try again later. No data was written unless the result said so.' };
  }
  return { code: 'UNEXPECTED', message: 'An unexpected error occurred. Technical details were written to the execution log (Apps Script editor → Executions). Message: ' + msg.substr(0, 200) };
}

/** Wraps a google.script.run entry point: always returns {ok, data} or {ok:false, error}. */
function apiCall_(name, fn) {
  try {
    return { ok: true, data: toClient_(fn()) };
  } catch (e) {
    logError_(name, e);
    return { ok: false, error: toUserError_(e) };
  }
}

/** Embeds JSON safely in an HTML template (prevents </script> injection). */
function jsonForHtml_(obj) {
  return JSON.stringify(toClient_(obj) || {})
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/**
 * HTML include helper for templates: <?!= include('Styles') ?>
 * Styles is followed by the active theme (Display Settings → Theme), so every page is themed.
 */
function include(name) {
  var html = HtmlService.createHtmlOutputFromFile(name).getContent();
  return name === 'Styles' ? html + themeHtml_() : html;
}

/** The active theme's HTML, or '' for the default look (also when its file is missing). */
function themeHtml_() {
  try {
    var theme = THEMES[getConfig_().UI_THEME];
    return theme && theme.file ? HtmlService.createHtmlOutputFromFile(theme.file).getContent() : '';
  } catch (e) {
    return ''; // not initialized yet, or the theme file was not added to the project
  }
}
