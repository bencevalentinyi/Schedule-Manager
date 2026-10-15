/**
 * AuditService.gs
 * Import history (_IMPORT_LOG) and the undo journal (_IMPORT_CHANGES).
 *
 * Dependencies: Schema.gs, Utils.gs, SheetStore.gs
 */

function appendImportLog_(entry) {
  appendObjects_(T_IMPORT_LOG, [entry]);
}

/** Updates fields of a log row identified by importId. */
function updateImportLog_(importId, patch) {
  var t = readTable_(T_IMPORT_LOG);
  for (var i = t.rows.length - 1; i >= 0; i--) {
    if (str_(t.rows[i].importId) === importId) {
      var row = t.rows[i];
      Object.keys(patch).forEach(function (k) { row[k] = patch[k]; });
      updateObject_(T_IMPORT_LOG, row);
      return row;
    }
  }
  fail_('NOT_FOUND', 'Import ' + importId + ' is not in the import log.');
}

/** Log entries, newest first. */
function readImportLog_() {
  return readTable_(T_IMPORT_LOG).rows.map(function (r) {
    return {
      importId: str_(r.importId), timestamp: r.timestamp, sourceFile: str_(r.sourceFile), format: str_(r.format),
      profileId: str_(r.profileId), teams: str_(r.teams), dateFrom: str_(r.dateFrom), dateTo: str_(r.dateTo),
      rowsProcessed: toNumber_(r.rowsProcessed, 0), rowsInserted: toNumber_(r.rowsInserted, 0),
      rowsUpdated: toNumber_(r.rowsUpdated, 0), rowsSkipped: toNumber_(r.rowsSkipped, 0),
      rowsRemoved: toNumber_(r.rowsRemoved, 0), rowsRejected: toNumber_(r.rowsRejected, 0),
      strategy: str_(r.strategy), status: str_(r.status), errorSummary: str_(r.errorSummary),
      user: str_(r.user), fileHash: str_(r.fileHash), _row: r._row
    };
  }).reverse();
}

/** Most recent COMMITTED or interrupted (COMMITTING) import, or null. */
function findUndoCandidate_() {
  var log = readImportLog_();
  for (var i = 0; i < log.length; i++) {
    if (log[i].status === IMPORT_STATUS.COMMITTED || log[i].status === IMPORT_STATUS.COMMITTING) return log[i];
  }
  return null;
}

function findCommittedByHash_(hash) {
  if (!hash) return null;
  var log = readImportLog_();
  for (var i = 0; i < log.length; i++) {
    if (log[i].fileHash === hash && log[i].status === IMPORT_STATUS.COMMITTED) {
      return { importId: log[i].importId, timestamp: formatTimestamp_(log[i].timestamp), sourceFile: log[i].sourceFile };
    }
  }
  return null;
}

/** Latest logged import that targeted a team (any status, shown in the view header). */
function lastImportForTeam_(teamId) {
  var sh = getSheet_(T_IMPORT_LOG.sheet);
  if (!sh || sh.getLastRow() < 2) return null;
  var log = readImportLog_();
  for (var i = 0; i < log.length; i++) {
    if (log[i].teams.indexOf('[' + teamId + ']') >= 0) return log[i];
  }
  return null;
}

function readJournal_(importId) {
  return readTable_(T_CHANGES).rows
    .filter(function (r) { return str_(r.importId) === importId; })
    .map(function (r) { return { seq: toNumber_(r.seq, 0), recordKey: str_(r.recordKey), action: str_(r.action), before: str_(r.before) }; })
    .sort(function (a, b) { return a.seq - b.seq; });
}

/* ------------------------------------------------------------------------ */
/* Client API (HistoryDialog.html)                                           */
/* ------------------------------------------------------------------------ */

function apiImportHistory(limit) {
  return apiCall_('apiImportHistory', function () {
    requireInitialized_();
    var tz = getTz_();
    var log = readImportLog_().slice(0, limit || 50).map(function (e) {
      e.timestamp = formatTimestamp_(e.timestamp, tz);
      return e;
    });
    var cand = findUndoCandidate_();
    var all = readImportLog_();
    var stats = { total: all.length, committed: 0, undone: 0, failed: 0, inserted: 0, updated: 0, removed: 0, rejected: 0 };
    all.forEach(function (e) {
      if (e.status === IMPORT_STATUS.COMMITTED) {
        stats.committed++;
        stats.inserted += e.rowsInserted; stats.updated += e.rowsUpdated; stats.removed += e.rowsRemoved; stats.rejected += e.rowsRejected;
      }
      if (e.status === IMPORT_STATUS.UNDONE) stats.undone++;
      if (e.status === IMPORT_STATUS.FAILED) stats.failed++;
    });
    return {
      entries: log,
      stats: stats,
      undoCandidate: cand ? { importId: cand.importId, sourceFile: cand.sourceFile, timestamp: formatTimestamp_(cand.timestamp, tz),
        status: cand.status, teams: cand.teams, inserted: cand.rowsInserted, updated: cand.rowsUpdated, removed: cand.rowsRemoved } : null
    };
  });
}
