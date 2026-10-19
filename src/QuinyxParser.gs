/**
 * QuinyxParser.gs
 * Source file parsing and value normalization.
 *
 *  - CSV / TSV / TXT: decoded (UTF-8, UTF-16 with BOM, Windows-1252 fallback),
 *    delimiter auto-detected (, ; tab |), parsed with an RFC 4180 parser.
 *  - XLSX / XLS / ODS: converted to a temporary Google Sheet with the Drive
 *    advanced service (v3), read, then permanently deleted.
 *  - A tab inside this spreadsheet (paste the export) — no extra permissions.
 *
 * No assumption is made about Quinyx column names or order: this file produces a
 * plain table of strings; mapping happens in ImportMappingService/ImportService.
 * Source cells are never evaluated as formulas (all values are read as text).
 *
 * Everything below "Pure parsing" is service-free and unit-tested in Tests.gs.
 *
 * Dependencies: Schema.gs, Utils.gs, ImportMappingService.gs
 */

var SPREADSHEET_EXTENSIONS_ = ['xlsx', 'xls', 'ods'];
var TEXT_EXTENSIONS_ = ['csv', 'tsv', 'txt'];
var GOOGLE_SHEETS_MIME_ = 'application/vnd.google-apps.spreadsheet';

/**
 * Parses an uploaded file payload into a string table.
 * @param {{fileName, mimeType, base64, encoding}} payload
 * @return {{format, table: string[][], sheetName, sheetNames, encoding, warnings: string[], fileHash}}
 */
function parseUploadedFile_(payload, maxBytes) {
  if (!payload || !payload.base64) fail_('VALIDATION', 'No file was received. Choose a file and try again.');
  var name = str_(payload.fileName) || 'upload';
  var ext = (name.match(/\.([A-Za-z0-9]+)$/) || [])[1];
  ext = ext ? ext.toLowerCase() : '';
  var bytes = Utilities.base64Decode(payload.base64);
  if (maxBytes && bytes.length > maxBytes) {
    fail_('FILE_TOO_LARGE', 'The file is ' + Math.round(bytes.length / 1048576) + ' MB; the limit is ' + Math.round(maxBytes / 1048576) + ' MB (MAX_FILE_MB). Export a shorter date range.');
  }
  if (!bytes.length) fail_('VALIDATION', 'The file is empty.');
  var warnings = [];
  if (TEXT_EXTENSIONS_.indexOf(ext) >= 0 || /text\/(csv|plain|tab)/.test(str_(payload.mimeType))) {
    var dec = decodeText_(bytes, payload.encoding || 'AUTO');
    if (dec.warning) warnings.push(dec.warning);
    var delim = ext === 'tsv' ? '\t' : detectDelimiter_(dec.text);
    var table = trimTable_(parseCsv_(dec.text, delim));
    return { format: 'CSV', table: table, sheetName: '', sheetNames: [], encoding: dec.encoding,
      delimiter: delim === '\t' ? 'TAB' : delim, warnings: warnings, fileHash: hash64_(JSON.stringify(table)) };
  }
  if (SPREADSHEET_EXTENSIONS_.indexOf(ext) >= 0) {
    var blob = Utilities.newBlob(bytes, payload.mimeType || 'application/octet-stream', name);
    var conv = convertSpreadsheetBlob_(blob, payload.sheetName);
    conv.table = trimTable_(conv.table);
    return { format: ext.toUpperCase(), table: conv.table, sheetName: conv.sheetName, sheetNames: conv.sheetNames,
      encoding: '', delimiter: '', warnings: warnings, fileHash: hash64_(JSON.stringify(conv.table)) };
  }
  fail_('UNSUPPORTED_FILE', 'Unsupported file type ".' + (ext || '?') + '". Upload a CSV, TSV, TXT, XLSX, XLS or ODS export, or paste the export into a sheet tab and import from that tab.');
}

/** Reads a tab of this spreadsheet as a string table. */
function readSheetAsTable_(sheetName) {
  var sh = getSheet_(sheetName);
  if (!sh) fail_('NOT_FOUND', 'Sheet "' + sheetName + '" was not found.');
  if (sheetName.charAt(0) === '_') fail_('VALIDATION', 'System sheets cannot be used as an import source.');
  if (sh.getLastRow() < 1) fail_('VALIDATION', 'Sheet "' + sheetName + '" is empty.');
  var values = sh.getDataRange().getValues();
  var table = trimTable_(valuesToStrings_(values, getTz_()));
  return { format: 'SHEET', table: table, sheetName: sheetName, sheetNames: [], encoding: '', delimiter: '',
    warnings: [], fileHash: hash64_(JSON.stringify(table)) };
}

/**
 * Converts XLSX/XLS/ODS to a temporary Google Sheet (Drive API v3), reads one
 * tab and permanently deletes the temporary file.
 * Requires the "Drive" advanced service and the drive.file scope.
 */
function convertSpreadsheetBlob_(blob, wantedSheet) {
  if (typeof Drive === 'undefined' || !Drive.Files || typeof Drive.Files.create !== 'function') {
    fail_('DRIVE_SERVICE', 'Spreadsheet uploads need the Drive advanced service (v3). In the Apps Script editor open Services (+), add "Drive API" with identifier "Drive", save, and retry. Or save the export as CSV.');
  }
  var file = null;
  try {
    file = Drive.Files.create({ name: '[' + APP.NAME + ' temp] ' + blob.getName(), mimeType: GOOGLE_SHEETS_MIME_ }, blob);
    var tmp = SpreadsheetApp.openById(file.id);
    var sheets = tmp.getSheets();
    var names = sheets.map(function (s) { return s.getName(); });
    var sh = null;
    if (wantedSheet) {
      sh = tmp.getSheetByName(wantedSheet);
      if (!sh) fail_('NOT_FOUND', 'The workbook has no sheet named "' + wantedSheet + '". Sheets: ' + names.join(', '));
    } else {
      for (var i = 0; i < sheets.length; i++) if (sheets[i].getLastRow() > 0) { sh = sheets[i]; break; }
    }
    if (!sh) fail_('VALIDATION', 'The workbook contains no data.');
    var values = sh.getDataRange().getValues();
    return { table: valuesToStrings_(values, tmp.getSpreadsheetTimeZone()), sheetName: sh.getName(), sheetNames: names };
  } finally {
    if (file && file.id) {
      try { Drive.Files.remove(file.id); }
      catch (e) { logError_('convertSpreadsheetBlob_.cleanup tempFileId=' + file.id, e); }
    }
  }
}

/**
 * Converts getValues() output to strings without evaluating anything.
 * Dates become "yyyy-MM-dd HH:mm:ss" (or "HH:mm:ss" for time-only / duration
 * cells, which Sheets stores relative to 1899-12-30).
 */
function valuesToStrings_(values, tz) {
  return values.map(function (row) {
    return row.map(function (v) {
      if (isDate_(v)) {
        var y = +Utilities.formatDate(v, tz, 'yyyy');
        return y <= 1900 ? Utilities.formatDate(v, tz, 'HH:mm:ss') : Utilities.formatDate(v, tz, 'yyyy-MM-dd HH:mm:ss');
      }
      if (typeof v === 'number') return String(v);
      if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
      return str_(v);
    });
  });
}

/**
 * Decodes bytes. AUTO honours a BOM, otherwise tries UTF-8 and falls back to
 * Windows-1252 if the result contains replacement characters.
 */
function decodeText_(bytes, encoding) {
  var b0 = bytes[0] & 0xff, b1 = bytes[1] & 0xff, b2 = bytes[2] & 0xff;
  var enc = encoding && encoding !== 'AUTO' ? encoding : 'UTF-8';
  var warning = '';
  if (!encoding || encoding === 'AUTO') {
    if (b0 === 0xef && b1 === 0xbb && b2 === 0xbf) enc = 'UTF-8';
    else if (b0 === 0xff && b1 === 0xfe) enc = 'UTF-16LE';
    else if (b0 === 0xfe && b1 === 0xff) enc = 'UTF-16BE';
  }
  var text = Utilities.newBlob(bytes).getDataAsString(enc);
  if ((!encoding || encoding === 'AUTO') && enc === 'UTF-8' && text.indexOf('�') >= 0) {
    enc = 'windows-1252';
    text = Utilities.newBlob(bytes).getDataAsString(enc);
    warning = 'The file is not valid UTF-8; it was read as Windows-1252. If letters look wrong, choose the encoding explicitly.';
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return { text: text, encoding: enc, warning: warning };
}

/* ======================================================================== */
/* Pure parsing                                                              */
/* ======================================================================== */

/** Counts delimiter occurrences outside quotes per line and picks the most consistent one. */
function detectDelimiter_(text) {
  var lines = String(text).split(/\r\n|\n|\r/).filter(function (l) { return l.trim() !== ''; }).slice(0, 15);
  var candidates = [';', ',', '\t', '|'];
  var best = ',', bestScore = -1;
  candidates.forEach(function (d) {
    var counts = lines.map(function (l) {
      var n = 0, q = false;
      for (var i = 0; i < l.length; i++) {
        var c = l.charAt(i);
        if (c === '"') q = !q;
        else if (c === d && !q) n++;
      }
      return n;
    });
    var nonZero = counts.filter(function (n) { return n > 0; });
    if (!nonZero.length) return;
    // Modal count, and how many lines share it.
    var freq = {};
    nonZero.forEach(function (n) { freq[n] = (freq[n] || 0) + 1; });
    var mode = Object.keys(freq).sort(function (a, b) { return freq[b] - freq[a] || b - a; })[0];
    var score = freq[mode] * 1000 + Number(mode);
    if (score > bestScore) { bestScore = score; best = d; }
  });
  return best;
}

/** RFC 4180 CSV parser (quoted fields, escaped quotes, embedded newlines). */
function parseCsv_(text, delimiter) {
  var rows = [], row = [], field = '', inQuotes = false, fieldStarted = false;
  var s = String(text), n = s.length, i = 0;
  while (i < n) {
    var c = s.charAt(i);
    if (inQuotes) {
      if (c === '"') {
        if (s.charAt(i + 1) === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      var next = s.indexOf('"', i);
      if (next < 0) { field += s.substring(i); i = n; break; }
      field += s.substring(i, next); i = next; continue;
    }
    if (c === '"' && !fieldStarted) { inQuotes = true; fieldStarted = true; i++; continue; }
    if (c === delimiter) { row.push(field); field = ''; fieldStarted = false; i++; continue; }
    if (c === '\r' || c === '\n') {
      row.push(field); rows.push(row); row = []; field = ''; fieldStarted = false;
      i += (c === '\r' && s.charAt(i + 1) === '\n') ? 2 : 1;
      continue;
    }
    field += c; fieldStarted = true; i++;
  }
  if (inQuotes) fail_('PARSE', 'The file has an unterminated quoted field. Check that the export is complete and is a valid CSV file.');
  if (field !== '' || fieldStarted || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** Trims cells, removes trailing empty rows/columns and pads rows to equal width. */
function trimTable_(table) {
  var t = (table || []).map(function (r) { return (r || []).map(function (c) { return str_(c); }); });
  while (t.length && t[t.length - 1].every(function (c) { return c === ''; })) t.pop();
  var width = 0;
  t.forEach(function (r) {
    for (var i = r.length - 1; i >= 0; i--) if (r[i] !== '') { width = Math.max(width, i + 1); break; }
  });
  return t.map(function (r) {
    var x = r.slice(0, width);
    while (x.length < width) x.push('');
    return x;
  });
}

/**
 * Finds the header row: the row (among the first 25) with the most cells that
 * match known header synonyms; falls back to the first row with 2+ values.
 * @return {number} 0-based row index
 */
function detectHeaderRow_(table, synIndex) {
  var best = -1, bestScore = 0, limit = Math.min(table.length, 25);
  for (var r = 0; r < limit; r++) {
    var score = 0;
    table[r].forEach(function (c) { if (c !== '' && synIndex[normKey_(c)]) score++; });
    if (score > bestScore) { bestScore = score; best = r; }
  }
  if (bestScore >= 2) return best;
  for (var k = 0; k < limit; k++) {
    if (table[k].filter(function (c) { return c !== ''; }).length >= 2) return k;
  }
  return 0;
}

/** Unique, non-empty header labels ("Column 3", "Name (2)"). */
function buildHeaders_(row) {
  var seen = {};
  return (row || []).map(function (h, i) {
    var label = str_(h) || 'Column ' + (i + 1);
    var base = label, n = 2;
    while (seen[label.toLowerCase()]) label = base + ' (' + (n++) + ')';
    seen[label.toLowerCase()] = true;
    return label;
  });
}

/* ---------------------------- dates and times --------------------------- */

var MONTHS_ = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
var WEEKDAY_PREFIX_ = /^(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(day|nesday|sday|urday)?\.?,?\s+/i;
var TZ_SUFFIX_ = /(?:\s*(?:Z|UTC|GMT|[+\-]\d{2}:?\d{2}))$/i;

function monthNumber_(name) {
  var k = String(name).toLowerCase().replace(/\.$/, '');
  if (MONTHS_[k]) return MONTHS_[k];
  var k3 = k.substr(0, 3);
  return (k.length >= 3 && MONTHS_[k3] && 'january february march april may june july august september october november december'.indexOf(k) >= 0) ? MONTHS_[k3] : 0;
}

/**
 * Splits a value into date parts and an optional time part. Returns null when
 * the value has no date component.
 * Result: {y, m, d, time} or {p1, p2, y, ambiguous: true, time}
 */
function splitDateTime_(raw) {
  var s = str_(raw).replace(WEEKDAY_PREFIX_, '');
  var m, time;
  var cleanTime = function (t) {
    t = str_(t);
    if (!t) return '';
    var stripped = t.replace(TZ_SUFFIX_, '');
    return stripped;
  };
  if ((m = /^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})(?:(?:T|\s+)(.+))?$/.exec(s))) {
    return { y: +m[1], m: +m[2], d: +m[3], time: cleanTime(m[4]), tz: TZ_SUFFIX_.test(str_(m[4])) };
  }
  if ((m = /^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4}|\d{2})(?:(?:T|,?\s+)(.+))?$/.exec(s))) {
    var y = +m[3]; if (m[3].length === 2) y += 2000;
    return { p1: +m[1], p2: +m[2], y: y, ambiguous: true, time: cleanTime(m[4]) };
  }
  if ((m = /^(\d{1,2})(?:st|nd|rd|th)?[\s\-]+([A-Za-z]{3,9})\.?[\s\-,]+(\d{4})(?:(?:T|,?\s+)(.+))?$/.exec(s))) {
    var mon = monthNumber_(m[2]);
    if (mon) return { y: +m[3], m: mon, d: +m[1], time: cleanTime(m[4]) };
  }
  if ((m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(?:(?:T|,?\s+)(.+))?$/.exec(s))) {
    var mon2 = monthNumber_(m[1]);
    if (mon2) return { y: +m[3], m: mon2, d: +m[2], time: cleanTime(m[4]) };
  }
  if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) return { y: +m[1], m: +m[2], d: +m[3], time: '' };
  return null;
}

/**
 * Determines the day/month order used by a batch of values.
 * @return {{order: 'DMY'|'MDY'|'NONE'|'AMBIGUOUS'|'CONFLICT', example: string}}
 */
function detectDateOrder_(values) {
  var dmy = '', mdy = '', amb = '';
  values.forEach(function (v) {
    var p = splitDateTime_(v);
    if (!p || !p.ambiguous) return;
    if (p.p1 > 12 && p.p2 <= 12) { if (!dmy) dmy = v; }
    else if (p.p2 > 12 && p.p1 <= 12) { if (!mdy) mdy = v; }
    else if (p.p1 !== p.p2 && !amb) amb = v;
  });
  if (dmy && mdy) return { order: 'CONFLICT', example: dmy + '" and "' + mdy };
  if (dmy) return { order: 'DMY', example: dmy };
  if (mdy) return { order: 'MDY', example: mdy };
  if (amb) return { order: 'AMBIGUOUS', example: amb };
  return { order: 'NONE', example: '' };
}

/** Resolves split date parts to "yyyy-MM-dd". Returns {date} or {error}. */
function resolveDateParts_(p, order) {
  var y = p.y, mo, d;
  if (p.ambiguous) {
    if (order === 'DMY') { d = p.p1; mo = p.p2; }
    else if (order === 'MDY') { mo = p.p1; d = p.p2; }
    else if (p.p1 === p.p2) { d = p.p1; mo = p.p2; }
    else if (order === 'YMD') return { error: 'is not in year-month-day order (configured YMD)' };
    else return { error: 'is ambiguous (day/month order unknown)' };
  } else { mo = p.m; d = p.d; }
  if (!isValidYmd_(y, mo, d)) return { error: 'is not a valid calendar date' };
  return { date: ymd_(y, mo, d) };
}

function hm_(h, mi, ap) {
  if (ap) {
    var a = ap.charAt(0).toLowerCase();
    if (h < 1 || h > 12) return null;
    if (a === 'a') h = h === 12 ? 0 : h; else h = h === 12 ? 12 : h + 12;
  }
  if (mi > 59 || h > 24 || (h === 24 && mi > 0)) return null;
  return h * 60 + mi;
}

/** Parses a time of day to minutes (0..1440) or null. Supports 24:00. */
function parseTime_(raw) {
  var s = str_(raw).toLowerCase().replace(/\s+/g, ' ');
  if (!s) return null;
  var m;
  if ((m = /^(\d{1,2})[:.](\d{2})(?:[:.](\d{2})(?:\.\d+)?)?\s*([ap]\.?m\.?)?$/.exec(s))) return hm_(+m[1], +m[2], m[4]);
  if ((m = /^(\d{1,2})\s*([ap]\.?m\.?)$/.exec(s))) return hm_(+m[1], 0, m[2]);
  if ((m = /^(\d{2})(\d{2})$/.exec(s))) return hm_(+m[1], +m[2], null);
  if (/^0?\.\d+$/.test(s)) return Math.round(parseFloat(s) * 1440); // spreadsheet time fraction
  return null;
}

/** Parses a duration to minutes. Plain numbers use unit (MINUTES|HOURS). */
function parseDuration_(raw, unit) {
  var s = str_(raw).toLowerCase().replace(',', '.');
  if (!s) return { empty: true, minutes: 0 };
  var m;
  if ((m = /^(\d{1,3}):(\d{2})(?::\d{2})?$/.exec(s))) return { minutes: +m[1] * 60 + +m[2] };
  if ((m = /^(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)$/.exec(s))) return { minutes: Math.round(+m[1] * 60) };
  if ((m = /^(\d+)\s*(?:m|min|mins|minute|minutes)$/.exec(s))) return { minutes: +m[1] };
  if ((m = /^(\d+)\s*h(?:rs?|ours?)?\s*(\d+)\s*m(?:in(?:s|utes?)?)?$/.exec(s))) return { minutes: +m[1] * 60 + +m[2] };
  if ((m = /^\d+(?:\.\d+)?$/.exec(s))) {
    var n = parseFloat(s);
    return { minutes: unit === 'HOURS' ? Math.round(n * 60) : Math.round(n) };
  }
  return { error: 'is not a recognizable duration' };
}

/**
 * Parses a value that may be a date, a time, or a date-time.
 * @return {{empty?: bool, date: string|null, minutes: number|null, error?: string, tz?: bool}}
 */
function parseDateTimeValue_(raw, order) {
  var s = str_(raw);
  if (!s) return { empty: true, date: null, minutes: null };
  var p = splitDateTime_(s);
  if (p) {
    var r = resolveDateParts_(p, order);
    if (r.error) return { date: null, minutes: null, error: '"' + s + '" ' + r.error };
    if (!p.time) return { date: r.date, minutes: null };
    var t = parseTime_(p.time);
    if (t === null) return { date: r.date, minutes: null, error: '"' + s + '" has an unrecognizable time part' };
    return { date: r.date, minutes: t, tz: !!p.tz };
  }
  var tm = parseTime_(s);
  if (tm === null) return { date: null, minutes: null, error: '"' + s + '" is not a recognizable time or date' };
  return { date: null, minutes: tm };
}

/** Parses a date-only value (accepts date-times and spreadsheet serial numbers). */
function parseDateValue_(raw, order) {
  var s = str_(raw);
  if (!s) return { empty: true, date: null };
  var p = splitDateTime_(s);
  if (p) {
    var r = resolveDateParts_(p, order);
    return r.error ? { date: null, error: '"' + s + '" ' + r.error } : { date: r.date };
  }
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    var serial = Math.floor(parseFloat(s));
    if (serial > 20000 && serial < 80000) return { date: isoFromDayNumber_(serial - SHEETS_EPOCH_DAY_) };
  }
  return { date: null, error: '"' + s + '" is not a recognizable date' };
}

/* ------------------------ Quinyx "Daily Schedule" ------------------------ */
/*
 * The Daily Schedule layout implemented here follows the DESCRIPTION provided
 * (title + date in A1, labels in row 2, data below; A shift type, B name,
 * C shift information, F hours). It has NOT been verified against a real
 * export: every row/column position is configurable in the mapping profile, and
 * unparseable values are rejected for review instead of guessed.
 */

/**
 * Extracts exactly one date from a title such as "Daily schedule 2026-10-15".
 * Accepts ISO, d/m/y or m/d/y (needs an unambiguous value or a configured
 * order), and month names. Never falls back to today.
 * @return {{date?: string, error?: string}}
 */
function extractScheduleDate_(title, order) {
  var s = str_(title).replace(/\s+/g, ' ');
  if (!s) return { error: 'the title cell is empty.' };
  var patterns = [
    /(?<![\d\/.\-])(\d{4}[-\/.]\d{1,2}[-\/.]\d{1,2})(?!\d)/g,
    /(?<![\d\/.\-])(\d{1,2}[-\/.]\d{1,2}[-\/.](?:\d{4}|\d{2}))(?![\d\/.\-])/g,
    /(?<![A-Za-z\d])(\d{1,2}(?:st|nd|rd|th)?[\s\-]+[A-Za-z]{3,9}\.?,?[\s\-]+\d{4})(?!\d)/g,
    /(?<![A-Za-z])([A-Za-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4})(?!\d)/g
  ];
  var found = [], errors = [];
  patterns.forEach(function (re) {
    var m;
    while ((m = re.exec(s))) {
      var p = splitDateTime_(m[1]);
      if (!p) continue;
      var o = order;
      if (p.ambiguous && o !== 'DMY' && o !== 'MDY') {
        if (p.p1 > 12) o = 'DMY';
        else if (p.p2 > 12) o = 'MDY';
        else if (p.p1 === p.p2) o = 'DMY';
        else { errors.push('"' + m[1] + '" is ambiguous (day/month order unknown)'); continue; }
      }
      var r = resolveDateParts_(p, o);
      if (r.date) found.push(r.date); else errors.push('"' + m[1] + '" ' + r.error);
    }
  });
  found = uniq_(found);
  if (found.length > 1) return { error: 'several different dates were found (' + found.join(', ') + ').' };
  if (errors.length) return { error: errors[0] + '.' };
  if (found.length === 1) return { date: found[0] };
  return { error: 'no date was found in "' + s + '".' };
}

/**
 * Parses a shift-information cell into start/end strings, accepting
 * "08:00 - 16:00", "08:00-16:00", "8:00 AM – 4:30 PM", "08.00 to 16.00",
 * "2026-10-15 22:00 - 2026-10-16 06:00" and "2026-10-15 22:00 - 06:00".
 * Text around the range is returned as `rest`. More than one range, or none,
 * is an error (the row is flagged for review; nothing is guessed).
 * @return {{start: string, end: string, rest: string}|{error: string}}
 */
function parseShiftInfo_(raw) {
  var s = str_(raw).replace(/[‐-―−]/g, '-').replace(/\s+/g, ' ');
  if (!s) return { error: 'Shift information is empty.' };
  var T = '\\d{1,2}[:.]\\d{2}(?:[:.]\\d{2})?(?:\\s*[ap]\\.?m\\.?)?';
  var D = '(?:\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}[\\/.]\\d{1,2}[\\/.]\\d{2,4})';
  var SEP = '\\s*(?:-|to)\\s*';
  var tries = [
    new RegExp('(' + D + '[ T]' + T + ')' + SEP + '(' + D + '[ T]' + T + ')(?!\\d)', 'gi'),
    new RegExp('(' + D + '[ T]' + T + ')' + SEP + '(' + T + ')(?![\\d\\/.\\-])', 'gi'),
    new RegExp('(?<![\\d:.\\/\\-])(' + T + ')' + SEP + '(' + T + ')(?![\\d])', 'gi')
  ];
  for (var i = 0; i < tries.length; i++) {
    var matches = [], m;
    while ((m = tries[i].exec(s))) matches.push(m);
    if (!matches.length) continue;
    if (matches.length > 1) return { error: 'Shift information "' + s + '" contains several time ranges; review it manually.' };
    var rest = (s.substr(0, matches[0].index) + ' ' + s.substr(matches[0].index + matches[0][0].length)).replace(/\s+/g, ' ').trim();
    return { start: matches[0][1].trim(), end: matches[0][2].trim(), rest: rest };
  }
  return { error: 'Shift information "' + s + '" contains no recognizable time range (expected e.g. "08:00 - 16:00").' };
}

/**
 * Converts a raw Daily Schedule sheet into a regular table the import planner
 * understands: one header row + one row per shift, with fixed internal headers.
 * Rows where employee, employee ID and shift information are all blank (group or
 * spacer rows) are skipped and counted.
 * @param {string[][]} table raw cells (strings)
 * @param {Object} layoutIn DEFAULT_DAILY_LAYOUT-shaped
 * @param {{dateOrder?: string, dateOverride?: string}} opts
 */
function adaptDailySchedule_(table, layoutIn, opts) {
  var layout = normalizeDailyLayout_(layoutIn);
  opts = opts || {};
  var res = {
    fatal: [], warnings: [], info: [], layout: layout, title: '', parsedDate: '', dateError: '',
    scheduleDate: '', dateSource: '', headerLabels: {}, table: [], sourceRows: [], fieldMap: {},
    nonShiftRows: 0, filledDown: 0, blankShiftTypes: 0, dataRows: 0
  };
  var idx = function (letter) { var n = columnNumber_(letter); return n ? n - 1 : -1; };
  var cell = function (r, letter) { var c = idx(letter); return c >= 0 && table[r] ? str_(table[r][c]) : ''; };

  // Schedule date (title cell), optionally confirmed/overridden by the administrator.
  var parsed = layout.titleRow ? extractScheduleDate_(cell(layout.titleRow - 1, layout.titleColumn), opts.dateOrder)
    : { error: 'no title row is configured.' };
  res.title = layout.titleRow ? cell(layout.titleRow - 1, layout.titleColumn) : '';
  res.parsedDate = parsed.date || '';
  res.dateError = parsed.error || '';
  var override = str_(opts.dateOverride);
  var titleRef = layout.titleColumn + layout.titleRow;
  if (override) {
    if (!isIsoDate_(override)) res.fatal.push('The confirmed schedule date "' + override + '" is not a valid date (yyyy-MM-dd).');
    else {
      res.scheduleDate = override; res.dateSource = 'confirmed';
      if (parsed.date && parsed.date !== override) res.warnings.push('Schedule date set to ' + override + ' although ' + titleRef + ' says ' + parsed.date + '.');
    }
  } else if (parsed.date) {
    res.scheduleDate = parsed.date; res.dateSource = 'title';
  } else {
    res.fatal.push('The schedule date could not be read from ' + titleRef + ' ("' + res.title + '"): ' + parsed.error + ' Enter or confirm the schedule date.');
  }

  var cols = [
    ['shiftType', layout.shiftTypeColumn, 'Shift Type'],
    ['employeeName', layout.employeeNameColumn, 'Employee Name'],
    ['employeeId', layout.employeeIdColumn, 'Employee ID'],
    ['shiftInfo', layout.shiftInfoColumn, 'Shift Information'],
    ['scheduledHours', layout.hoursColumn, 'Scheduled Hours']
  ].filter(function (c) { return !!c[1] && idx(c[1]) >= 0; });
  if (layout.headerRow) cols.forEach(function (c) { res.headerLabels[c[1]] = cell(layout.headerRow - 1, c[1]); });

  // Plausibility hints about the (unverified) row structure.
  if (layout.headerRow && parseShiftInfo_(cell(layout.headerRow - 1, layout.shiftInfoColumn)).start) {
    res.warnings.push('Row ' + layout.headerRow + ' (configured as the header row) contains a time range in column ' + layout.shiftInfoColumn +
      '. It looks like data — check the header row / first data row settings.');
  }
  var usedIdx = cols.map(function (c) { return idx(c[1]); });
  var width = table.reduce(function (w, r) { return Math.max(w, r.length); }, 0);
  var extras = [];
  for (var c = 0; c < width; c++) {
    if (usedIdx.indexOf(c) >= 0) continue;
    var any = false;
    for (var r = layout.firstDataRow - 1; r < table.length && !any; r++) if (str_(table[r] && table[r][c])) any = true;
    if (!any) continue;
    var label = (layout.headerRow ? str_(table[layout.headerRow - 1] && table[layout.headerRow - 1][c]) : '') || 'Column ' + columnLetter_(c + 1);
    extras.push({ c: c, label: label });
  }
  var header = cols.map(function (x) { return x[2]; }).concat(['Schedule Date']).concat(extras.map(function (e) { return e.label; }));
  header = buildHeaders_(header);
  cols.forEach(function (x, i) { res.fieldMap[x[0]] = header[i]; });
  res.fieldMap.date = header[cols.length];

  var current = '';
  var rows = [];
  for (var rr = layout.firstDataRow - 1; rr < table.length; rr++) {
    var row = table[rr] || [];
    if (row.every(function (v) { return str_(v) === ''; })) continue;
    var vals = cols.map(function (x) { return cell(rr, x[1]); });
    var get = function (key) { for (var i = 0; i < cols.length; i++) if (cols[i][0] === key) return vals[i]; return ''; };
    var st = get('shiftType');
    if (layout.fillDownShiftType && layout.shiftTypeColumn) {
      if (st) current = st;
      else if (current) { st = current; res.filledDown++; vals[0] = st; }
    }
    if (!get('employeeName') && !get('employeeId') && !get('shiftInfo')) { res.nonShiftRows++; continue; }
    if (layout.shiftTypeColumn && !st) res.blankShiftTypes++;
    rows.push(vals.concat([res.scheduleDate]).concat(extras.map(function (e) { return str_(row[e.c]); })));
    res.sourceRows.push(rr + 1);
  }
  res.dataRows = rows.length;
  res.table = [header].concat(rows);
  if (!rows.length) res.warnings.push('No shift rows were found from row ' + layout.firstDataRow + ' onwards. Check the first data row setting.');
  if (res.blankShiftTypes && !layout.fillDownShiftType) {
    res.warnings.push(res.blankShiftTypes + ' row(s) have an empty shift type. If the export lists the shift type only once per group, enable "Fill empty shift types from the row above".');
  }
  if (res.nonShiftRows) res.info.push(res.nonShiftRows + ' row(s) without employee and shift information were skipped (group or spacer rows).');
  return res;
}

/** Distinct shift types with row counts from an adapted Daily Schedule (or any table with a shift type column). */
function discoverShiftTypes_(adaptedTable, shiftTypeHeader) {
  var header = adaptedTable[0] || [];
  var i = header.indexOf(shiftTypeHeader);
  if (i < 0) return [];
  var counts = {};
  adaptedTable.slice(1).forEach(function (r) { var t = normShiftType_(r[i]); counts[t] = (counts[t] || 0) + 1; });
  return Object.keys(counts).sort().map(function (t) { return { type: t, rows: counts[t] }; });
}

/* --------------------------- row normalization --------------------------- */

/**
 * Normalizes one source row into an internal shift record.
 * @param {string[]} row       source cells
 * @param {string[]} headers   header labels
 * @param {Object}   cols      field -> column index
 * @param {Object}   opts      {dateOrder, hoursUnit, stripZeros, maxShiftMinutes,
 *                              minShiftMinutes, hoursToleranceMinutes}
 * @return {Object} record with errors[] / errorCodes[] (row rejected if non-empty) and warnings[]
 */
function normalizeRow_(row, headers, cols, opts) {
  var get = function (f) {
    var i = cols[f];
    return i === undefined || i < 0 ? '' : str_(row[i]);
  };
  var rec = { errors: [], errorCodes: [], warnings: [], overnight: false, tzIgnored: false, hoursMissing: false, hoursInvalid: false, hoursDiscrepancy: false };
  var err = function (code, msg) { rec.errors.push(msg); if (rec.errorCodes.indexOf(code) < 0) rec.errorCodes.push(code); };
  rec.shiftId = get('shiftId');
  rec.employeeId = normalizeEmployeeId_(get('employeeId'), opts.stripZeros);
  var name = get('employeeName');
  if (!name) name = (get('firstName') + ' ' + get('lastName')).replace(/\s+/g, ' ').trim();
  rec.employeeName = name.replace(/\s+/g, ' ');
  rec.teamValue = get('team');
  rec.shiftType = normShiftType_(get('shiftType'));
  rec.activity = get('activity');
  rec.role = get('role');
  rec.shiftStatus = get('shiftStatus');
  rec.comment = get('comment');
  rec.sourceShiftInfo = get('shiftInfo');
  rec.sourceHours = get('scheduledHours');
  rec.scheduledMinutes = null;
  if (!rec.employeeId && !rec.employeeName) err('EMPLOYEE', 'No Employee ID or employee name.');

  var baseDate = null;
  var dRaw = get('date');
  if (dRaw) {
    var pd = parseDateValue_(dRaw, opts.dateOrder);
    if (pd.error) err('DATE', 'Shift date ' + pd.error + '.');
    else baseDate = pd.date;
  }

  // Start/end come from separate columns or from one "shift information" cell.
  var startRaw = get('start'), endRaw = get('end');
  var usesShiftInfo = cols.shiftInfo !== undefined && cols.shiftInfo >= 0 && cols.start === undefined && cols.end === undefined;
  if (usesShiftInfo) {
    var si = parseShiftInfo_(rec.sourceShiftInfo);
    if (si.error) { err('SHIFT_INFO', rec.sourceShiftInfo ? si.error : 'Missing shift information.'); return rec; }
    startRaw = si.start; endRaw = si.end;
    if (si.rest) rec.shiftInfoRest = si.rest;
  }
  var s = parseDateTimeValue_(startRaw, opts.dateOrder);
  var e = parseDateTimeValue_(endRaw, opts.dateOrder);
  var edRaw = get('endDate');
  var endDateField = null;
  if (edRaw) {
    var ped = parseDateValue_(edRaw, opts.dateOrder);
    if (ped.error) err('DATE', 'End date ' + ped.error + '.');
    else endDateField = ped.date;
  }
  if (s.tz || e.tz) rec.tzIgnored = true;
  var tcode = usesShiftInfo ? 'SHIFT_INFO' : 'TIME';
  if (s.empty) err(tcode, 'Missing shift start.');
  else if (s.error) err(tcode, 'Shift start ' + s.error + '.');
  else if (s.minutes === null) err(tcode, 'Shift start has a date but no time.');
  if (e.empty) err(tcode, 'Missing shift end.');
  else if (e.error) err(tcode, 'Shift end ' + e.error + '.');
  else if (e.minutes === null) err(tcode, 'Shift end has a date but no time.');

  var startDate = s.date || baseDate;
  if (!s.error && !s.empty && !startDate) err('DATE', 'Missing shift date (no date column and the start has no date).');
  if (s.date && baseDate && s.date !== baseDate) rec.warnings.push('Start date differs from the shift date column; the start value was used.');
  if (s.minutes === 1440) err(tcode, 'Shift start cannot be 24:00.');
  if (rec.errors.length) return rec;

  var startAbs = dayNumber_(startDate) * 1440 + s.minutes;
  var explicitEndDate = e.date || endDateField;
  var endAbs = dayNumber_(explicitEndDate || startDate) * 1440 + e.minutes;
  if (endAbs === startAbs) { err(tcode, 'Start and end are identical.'); return rec; }
  if (endAbs < startAbs) {
    if (explicitEndDate) { err(tcode, 'Shift ends before it starts.'); return rec; }
    endAbs += 1440;
  }
  if (Math.floor(endAbs / 1440) > Math.floor(startAbs / 1440) && endAbs % 1440 !== 0) rec.overnight = true;
  var gross = endAbs - startAbs;
  if (gross > 24 * 60) { err(tcode, 'Shift is longer than 24 hours.'); return rec; }
  if (gross > opts.maxShiftMinutes) rec.warnings.push('Unusually long shift (' + formatMinutesAsDuration_(gross) + ').');
  if (gross < opts.minShiftMinutes) rec.warnings.push('Unusually short shift (' + formatMinutesAsDuration_(gross) + ').');

  rec.shiftDate = startDate;
  rec.shiftStart = isoDateTimeFromMinutes_(startAbs);
  rec.shiftEnd = isoDateTimeFromMinutes_(endAbs);
  rec.grossMinutes = gross;
  rec.startAbs = startAbs;
  rec.endAbs = endAbs;

  // Scheduled hours (e.g. Daily Schedule column F): validated and compared, never used to overwrite times.
  if (cols.scheduledHours !== undefined && cols.scheduledHours >= 0) {
    if (!rec.sourceHours) {
      rec.hoursMissing = true;
      rec.warnings.push('Scheduled hours are missing.');
    } else {
      var hd = parseDuration_(rec.sourceHours, opts.hoursUnit || 'HOURS');
      if (hd.error || hd.minutes > 24 * 60) {
        rec.hoursInvalid = true;
        rec.warnings.push('Scheduled hours "' + rec.sourceHours + '" are not a valid duration.');
      } else {
        rec.scheduledMinutes = hd.minutes;
        var tol = opts.hoursToleranceMinutes === undefined ? 15 : opts.hoursToleranceMinutes;
        if (Math.abs(hd.minutes - gross) > tol) {
          rec.hoursDiscrepancy = true;
          rec.warnings.push('Scheduled hours ' + formatMinutesAsDuration_(hd.minutes) + ' differ from the shift (' +
            formatMinutesAsDuration_(gross) + ').');
        }
      }
    }
  }

  // Preserve every unmapped, non-empty source value.
  var mapped = {};
  Object.keys(cols).forEach(function (f) { mapped[cols[f]] = true; });
  rec.extra = {};
  headers.forEach(function (h, i) {
    if (mapped[i]) return;
    var v = str_(row[i]);
    if (v !== '') rec.extra[h] = v;
  });
  return rec;
}
