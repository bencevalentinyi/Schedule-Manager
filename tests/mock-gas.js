/**
 * Minimal in-memory stand-in for the Google Apps Script services used by
 * Schedule Manager, so runIntegrationTests() can run under Node.js.
 *
 * It is NOT a full emulator. It models the behaviours that matter for data
 * integrity and is strict where Sheets is strict:
 *  - ranges outside the grid throw (like "coordinates outside the dimensions");
 *  - strings that look like numbers become numbers unless the cell is plain text
 *    ("@"), so lost leading zeros are detected;
 *  - a leading apostrophe forces text and is not stored;
 *  - numbers in date-formatted cells are read back as Date objects.
 * Formatting calls (colors, borders, validation, filters…) are accepted and ignored.
 */
'use strict';

function tzParts(date, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'long'
  });
  const o = {};
  f.formatToParts(date).forEach((p) => { o[p.type] = p.value; });
  return o;
}

/** UTC instant of a wall-clock time in a time zone. */
function zonedToUtc(y, m, d, h, mi, tz) {
  let guess = Date.UTC(y, m - 1, d, h, mi);
  for (let i = 0; i < 3; i++) {
    const p = tzParts(new Date(guess), tz);
    const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
    guess += Date.UTC(y, m - 1, d, h, mi) - asUtc;
  }
  return new Date(guess);
}

function makeUtilities() {
  return {
    formatDate(date, tz, fmt) {
      const p = tzParts(date, tz === 'UTC' ? 'UTC' : tz);
      let out = '';
      const re = /'([^']*)'|yyyy|MM|dd|HH|mm|ss|EEEE|Z|./g;
      let m;
      while ((m = re.exec(fmt))) {
        const t = m[0];
        if (m[1] !== undefined) out += m[1];
        else if (t === 'yyyy') out += p.year;
        else if (t === 'MM') out += p.month;
        else if (t === 'dd') out += p.day;
        else if (t === 'HH') out += p.hour;
        else if (t === 'mm') out += p.minute;
        else if (t === 'ss') out += p.second;
        else if (t === 'EEEE') out += p.weekday;
        else if (t === 'Z') out += '+0000';
        else out += t;
      }
      return out;
    },
    getUuid() { return 'xxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16)); },
    base64Decode(s) { return Array.from(Buffer.from(s, 'base64')).map((b) => (b > 127 ? b - 256 : b)); },
    newBlob(bytes) {
      return { getDataAsString(enc) { return Buffer.from(bytes.map((b) => b & 0xff)).toString(enc && /16/.test(enc) ? 'utf16le' : 'utf8'); } };
    }
  };
}

/** Conditional-format rule builder that records its formula and background (enough to assert on). */
function ruleBuilder() {
  const rule = {};
  const p = new Proxy(function () {}, {
    get(t, k) {
      if (k === 'build') return () => rule;
      if (k === 'whenFormulaSatisfied') return (f) => { rule.formula = f; return p; };
      if (k === 'setBackground') return (b) => { rule.background = b; return p; };
      return () => p;
    },
    apply() { return p; }
  });
  return p;
}

function chain() {
  const p = new Proxy(function () {}, {
    get(t, k) { return k === 'build' ? () => ({}) : () => p; },
    apply() { return p; }
  });
  return p;
}

function letterToCol(s) { let n = 0; for (const ch of s.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64); return n; }

class MockSheet {
  constructor(ss, name, id) {
    this.ss = ss; this.name = name; this.id = id; this.maxRows = 1000; this.maxCols = 26;
    this.cells = new Map(); this.hiddenCols = new Set(); this.hidden = false; this.filter = null; this.protections = [];
  }
  key(r, c) { return r + ',' + c; }
  cell(r, c) { return this.cells.get(this.key(r, c)) || { v: '', f: '', n: '' }; }
  put(r, c, patch) { const k = this.key(r, c); this.cells.set(k, Object.assign({}, this.cell(r, c), patch)); }
  getName() { return this.name; }
  setName(n) {
    if (this.ss.sheets.some((s) => s !== this && s.name.toLowerCase() === n.toLowerCase())) throw new Error('A sheet with the name "' + n + '" already exists.');
    this.name = n; return this;
  }
  getSheetId() { return this.id; }
  getMaxRows() { return this.maxRows; }
  getMaxColumns() { return this.maxCols; }
  getLastRow() { let m = 0; for (const [k, c] of this.cells) if (c.v !== '' && c.v !== null) m = Math.max(m, +k.split(',')[0]); return m; }
  getLastColumn() { let m = 0; for (const [k, c] of this.cells) if (c.v !== '' && c.v !== null) m = Math.max(m, +k.split(',')[1]); return m; }
  insertRowsAfter(after, n) { this.maxRows += n; return this; }
  insertColumnsAfter(after, n) { this.maxCols += n; return this; }
  deleteRows(start, n) {
    const moved = new Map();
    for (const [k, c] of this.cells) {
      const [r, col] = k.split(',').map(Number);
      if (r >= start && r < start + n) continue;
      moved.set((r >= start + n ? r - n : r) + ',' + col, c);
    }
    this.cells = moved; this.maxRows -= n;
  }
  getRange(a, b, c, d) {
    if (typeof a === 'string') {
      const m = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+)?)?$/.exec(a);
      if (!m) throw new Error('Bad A1 ' + a);
      const c1 = letterToCol(m[1]), r1 = +m[2];
      const c2 = m[3] ? letterToCol(m[3]) : c1, r2 = m[3] ? (m[4] ? +m[4] : this.maxRows) : r1;
      return new MockRange(this, r1, c1, r2 - r1 + 1, c2 - c1 + 1);
    }
    return new MockRange(this, a, b, c === undefined ? 1 : c, d === undefined ? 1 : d);
  }
  getRangeList(list) {
    const ranges = list.map((a) => this.getRange(a));
    return { setNumberFormat: (f) => { ranges.forEach((r) => r.setNumberFormat(f)); } };
  }
  getDataRange() { return this.getRange(1, 1, Math.max(this.getLastRow(), 1), Math.max(this.getLastColumn(), 1)); }
  clear() { this.cells = new Map(); return this; }
  clearContents() { for (const [k, c] of this.cells) this.cells.set(k, Object.assign({}, c, { v: '' })); return this; }
  getFilter() { return this.filter; }
  protect() { const p = chain(); this.protections.push(p); return p; }
  getProtections() { return this.protections; }
  setConditionalFormatRules(rules) { this.cfRules = rules || []; return this; }
  getConditionalFormatRules() { return this.cfRules || []; }
  setFrozenRows() { return this; }
  setColumnWidth() { return this; }
  setRowHeight() { return this; }
  setTabColor() { return this; }
  hideColumns(c) { this.hiddenCols.add(c); }
  showColumns(c) { this.hiddenCols.delete(c); }
  hideSheet() { this.hidden = true; }
  showSheet() { this.hidden = false; }
  isSheetHidden() { return this.hidden; }
  activate() { this.ss.active = this; return this; }
}

class MockRange {
  constructor(sheet, r, c, nr, nc) {
    if (r < 1 || c < 1 || nr < 1 || nc < 1 || r + nr - 1 > sheet.maxRows || c + nc - 1 > sheet.maxCols) {
      throw new Error('The coordinates of the range are outside the dimensions of the sheet. (' + sheet.name + ' r' + r + ' c' + c + ' ' + nr + 'x' + nc +
        ', grid ' + sheet.maxRows + 'x' + sheet.maxCols + ')');
    }
    Object.assign(this, { sheet, r, c, nr, nc });
  }
  each(fn) { for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) fn(this.r + i, this.c + j, i, j); }
  read(r, c) {
    const cell = this.sheet.cell(r, c);
    let v = cell.v;
    if (typeof v === 'number' && /y/.test(cell.f || '')) {
      const ms = Math.round((v - 25569) * 86400000);
      const d = new Date(ms);
      v = zonedToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), this.sheet.ss.tz);
    }
    return v;
  }
  getValues() { const out = []; for (let i = 0; i < this.nr; i++) { out.push([]); for (let j = 0; j < this.nc; j++) out[i].push(this.read(this.r + i, this.c + j)); } return out; }
  getValue() { return this.read(this.r, this.c); }
  convert(v, fmt) {
    if (typeof v !== 'string') return v === undefined || v === null ? '' : v;
    if (v.charAt(0) === "'") return v.slice(1);
    if (fmt !== '@' && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
    return v;
  }
  setValues(vals) {
    if (vals.length !== this.nr || vals.some((row) => row.length !== this.nc)) {
      throw new Error('The number of rows/columns in the data does not match the range (' + vals.length + 'x' + (vals[0] || []).length + ' vs ' + this.nr + 'x' + this.nc + ')');
    }
    this.each((r, c, i, j) => this.sheet.put(r, c, { v: this.convert(vals[i][j], this.sheet.cell(r, c).f) }));
    return this;
  }
  setValue(v) { return new MockRange(this.sheet, this.r, this.c, 1, 1).setValues([[v]]); }
  getNotes() { const out = []; for (let i = 0; i < this.nr; i++) { out.push([]); for (let j = 0; j < this.nc; j++) out[i].push(this.sheet.cell(this.r + i, this.c + j).n || ''); } return out; }
  setNotes(n) { this.each((r, c, i, j) => this.sheet.put(r, c, { n: n[i][j] })); return this; }
  setNote(n) { this.sheet.put(this.r, this.c, { n: n }); return this; }
  setNumberFormat(f) { this.each((r, c) => this.sheet.put(r, c, { f: f })); return this; }
  setNumberFormats(fs) { this.each((r, c, i, j) => this.sheet.put(r, c, { f: fs[i][j] })); return this; }
  getNumberFormats() { const out = []; for (let i = 0; i < this.nr; i++) { out.push([]); for (let j = 0; j < this.nc; j++) out[i].push(this.sheet.cell(this.r + i, this.c + j).f || ''); } return out; }
  clearContent() { this.each((r, c) => this.sheet.put(r, c, { v: '' })); return this; }
  clearFormat() { this.each((r, c) => this.sheet.put(r, c, { f: '' })); return this; }
  clear() { this.each((r, c) => this.sheet.put(r, c, { v: '', f: '' })); return this; }
  createFilter() {
    const range = this;
    this.sheet.filter = { getRange: () => range, remove: () => { range.sheet.filter = null; } };
    return this.sheet.filter;
  }
  getRow() { return this.r; }
  getColumn() { return this.c; }
  getNumRows() { return this.nr; }
  getNumColumns() { return this.nc; }
  getLastRow() { return this.r + this.nr - 1; }
  getLastColumn() { return this.c + this.nc - 1; }
  getSheet() { return this.sheet; }
}
['setFontWeight', 'setFontFamily', 'setBackground', 'setFontColor', 'setFontSize', 'setFontStyle', 'setHorizontalAlignment',
  'setVerticalAlignment', 'setWrap', 'setBorder', 'setDataValidation', 'activate'].forEach((m) => {
  MockRange.prototype[m] = function () { return this; };
});

class MockSpreadsheet {
  constructor(tz) { this.tz = tz; this.sheets = []; this.nextId = 1000; this.active = null; this.insertSheet('Sheet1'); }
  getSpreadsheetTimeZone() { return this.tz; }
  getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; }
  getSheets() { return this.sheets.slice(); }
  getNumSheets() { return this.sheets.length; }
  insertSheet(name, index) {
    if (this.sheets.some((s) => s.name.toLowerCase() === String(name).toLowerCase())) throw new Error('A sheet with the name "' + name + '" already exists.');
    const s = new MockSheet(this, name, this.nextId++);
    if (index === undefined) this.sheets.push(s); else this.sheets.splice(index, 0, s);
    this.active = s;
    return s;
  }
  deleteSheet(s) {
    if (this.sheets.length === 1) throw new Error('Cannot delete the only sheet.');
    this.sheets = this.sheets.filter((x) => x !== s);
  }
  getActiveSheet() { return this.active || this.sheets[0]; }
  setActiveSheet(s) { this.active = s; return s; }
  toast() {}
}

function makeGlobals(tz) {
  const ss = new MockSpreadsheet(tz || 'Europe/Stockholm');
  const props = {};
  return {
    spreadsheet: ss,
    globals: {
      console,
      Utilities: makeUtilities(),
      SpreadsheetApp: {
        getActiveSpreadsheet: () => ss,
        newDataValidation: chain,
        newConditionalFormatRule: ruleBuilder,
        ProtectionType: { SHEET: 'SHEET', RANGE: 'RANGE' },
        BorderStyle: { SOLID: 'SOLID' },
        flush() {},
        getUi() { throw new Error('No UI in tests'); }
      },
      PropertiesService: {
        getDocumentProperties: () => ({
          getProperty: (k) => (k in props ? props[k] : null),
          setProperty: (k, v) => { props[k] = String(v); }
        }),
        getScriptProperties: () => ({
          getProperty: (k) => (k in props ? props[k] : null),
          setProperty: (k, v) => { props[k] = String(v); }
        })
      },
      LockService: { getDocumentLock: () => ({ tryLock: () => true, releaseLock() {} }), getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
      Session: { getActiveUser: () => ({ getEmail: () => 'tester@example.com' }) }
    }
  };
}

module.exports = { makeGlobals };
