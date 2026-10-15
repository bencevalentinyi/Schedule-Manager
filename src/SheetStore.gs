/**
 * SheetStore.gs
 * Generic, header-driven access to the internal tables defined in Schema.gs.
 * Columns are located by header label (never by position), so administrators may
 * reorder columns or add their own columns without breaking the system; unknown
 * columns are preserved on every write.
 *
 * Dependencies: Schema.gs, Utils.gs
 */

function getSheet_(name) {
  return getSs_().getSheetByName(name);
}

function requireSheet_(name, hint) {
  var sh = getSheet_(name);
  if (!sh) {
    fail_('MISSING_SHEET', 'Required sheet "' + name + '" is missing. ' +
      (hint || 'Run Schedule Manager → Maintenance → Rebuild Missing Sheets.'));
  }
  return sh;
}

function readHeader_(sh) {
  var lc = sh.getLastColumn();
  if (lc < 1) return [];
  return sh.getRange(1, 1, 1, lc).getValues()[0].map(function (v) { return str_(v); });
}

/** Maps column keys to 0-based header positions; reports missing labels. */
function headerIndex_(def, header) {
  var idx = {}, missing = [];
  def.columns.forEach(function (c) {
    var i = header.indexOf(c.label);
    if (i < 0) missing.push(c.label);
    idx[c.key] = i;
  });
  return { idx: idx, missing: missing };
}

/**
 * Reads a whole internal table.
 * @return {{sheet, header, idx, rows: Object[], values: Array[], lastRow: number}}
 *   rows are objects keyed by column key with a 1-based _row; values is the raw
 *   grid including the header (values[0]).
 */
function readTable_(def) {
  var sh = requireSheet_(def.sheet);
  var lr = sh.getLastRow(), lc = sh.getLastColumn();
  if (lr < 1 || lc < 1) {
    fail_('SCHEMA', 'Sheet "' + def.sheet + '" has no header row. Run Setup / Configure Spreadsheet → Repair.');
  }
  var values = sh.getRange(1, 1, lr, lc).getValues();
  var header = values[0].map(function (v) { return str_(v); });
  var hi = headerIndex_(def, header);
  if (hi.missing.length) {
    fail_('SCHEMA', 'Sheet "' + def.sheet + '" is missing column(s): ' + hi.missing.join(', ') +
      '. Run Setup / Configure Spreadsheet → Repair to restore them.');
  }
  var rows = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    if (row.every(isBlank_)) continue;
    rows.push(rowToObject_(def, hi.idx, row, r + 1));
  }
  return { sheet: sh, header: header, idx: hi.idx, rows: rows, values: values, lastRow: lr };
}

function rowToObject_(def, idx, row, rowNumber) {
  var o = { _row: rowNumber };
  def.columns.forEach(function (c) {
    var v = row[idx[c.key]];
    if (c.json) v = parseJson_(v, null);
    o[c.key] = v;
  });
  return o;
}

function toCellValue_(v, c) {
  if (v === null || v === undefined) return '';
  if (c && c.json) return typeof v === 'string' ? v : JSON.stringify(v);
  if (typeof v === 'string') return safeCell_(v);
  return v;
}

/** Builds a row array in the sheet's header order; unknown columns keep existing values. */
function objectToRow_(def, header, obj, existingRow) {
  var out = existingRow ? existingRow.slice() : header.map(function () { return ''; });
  while (out.length < header.length) out.push('');
  def.columns.forEach(function (c) {
    var i = header.indexOf(c.label);
    if (i >= 0 && Object.prototype.hasOwnProperty.call(obj, c.key)) out[i] = toCellValue_(obj[c.key], c);
  });
  return out;
}

/** Applies text / datetime number formats for the def's typed columns on a block. */
function applyColumnFormats_(sh, def, header, startRow, numRows) {
  if (numRows < 1) return;
  var text = [], dt = [];
  def.columns.forEach(function (c) {
    var i = header.indexOf(c.label);
    if (i < 0) return;
    var a1 = columnLetter_(i + 1) + startRow + ':' + columnLetter_(i + 1) + (startRow + numRows - 1);
    if (c.text) text.push(a1);
    else if (c.datetime) dt.push(a1);
  });
  if (text.length) sh.getRangeList(text).setNumberFormat('@');
  if (dt.length) sh.getRangeList(dt).setNumberFormat('yyyy-mm-dd hh:mm:ss');
}

/** Writes a block of raw rows starting at startRow (one setValues call). */
function writeRows_(sh, def, header, startRow, rows) {
  if (!rows.length) return;
  var width = header.length;
  // safeCell_ is idempotent; applying it to every string also protects values
  // that were read back from the sheet and are being rewritten unchanged.
  var norm = rows.map(function (r) {
    var x = r.slice(0, width).map(safeCell_);
    while (x.length < width) x.push('');
    return x;
  });
  ensureRows_(sh, startRow + norm.length - 1);
  applyColumnFormats_(sh, def, header, startRow, norm.length);
  sh.getRange(startRow, 1, norm.length, width).setValues(norm);
}

function ensureRows_(sh, lastNeededRow) {
  var max = sh.getMaxRows();
  if (max < lastNeededRow) sh.insertRowsAfter(max, lastNeededRow - max);
}

/** Appends objects as new rows. */
function appendObjects_(def, objs) {
  if (!objs.length) return;
  var sh = requireSheet_(def.sheet);
  var header = readHeader_(sh);
  var rows = objs.map(function (o) { return objectToRow_(def, header, o, null); });
  writeRows_(sh, def, header, sh.getLastRow() + 1, rows);
}

/** Updates one object in place (it must carry _row). Preserves unknown columns. */
function updateObject_(def, obj) {
  if (!obj._row) fail_('INTERNAL', 'Cannot update a ' + def.sheet + ' row without a row number.');
  var sh = requireSheet_(def.sheet);
  var header = readHeader_(sh);
  var existing = sh.getRange(obj._row, 1, 1, header.length).getValues()[0];
  writeRows_(sh, def, header, obj._row, [objectToRow_(def, header, obj, existing)]);
}

/**
 * Replaces all data rows of a table with the given raw rows, then clears any
 * surplus rows. Writes first and clears second, so an interruption never leaves
 * the table empty.
 */
function replaceAllRows_(sh, def, header, rows, previousLastRow) {
  if (rows.length) writeRows_(sh, def, header, 2, rows);
  var newLast = rows.length + 1;
  if (previousLastRow > newLast) {
    sh.getRange(newLast + 1, 1, previousLastRow - newLast, Math.max(header.length, 1)).clearContent();
  }
}

/** Deletes specific sheet rows (1-based), bottom-up, grouping contiguous runs. */
function deleteSheetRows_(sh, rowNumbers) {
  var rows = uniq_(rowNumbers).sort(function (a, b) { return b - a; });
  var i = 0;
  while (i < rows.length) {
    var end = rows[i], start = end;
    while (i + 1 < rows.length && rows[i + 1] === start - 1) { i++; start = rows[i]; }
    sh.deleteRows(start, end - start + 1);
    i++;
  }
}
