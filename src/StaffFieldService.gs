/**
 * StaffFieldService.gs
 * Registry of configurable staff fields in _STAFF_FIELDS: external identifiers
 * (e.g. Converse ID, Aircall ID, AstraID) and custom text fields.
 *
 *  - Field Key is permanent (external_id_1, field_2, …). Teams reference fields
 *    as "field:<key>" in team.settings.staffFields.
 *  - Display Name can be renamed at any time: staff sheet columns are linked to
 *    the key through a header note, so renaming changes only the header text.
 *  - Visible = false hides the column in every staff sheet (values are kept).
 *  - IDENTIFIER fields are stored as text, must be unique within a team, and may
 *    be used as an import match key only when a team explicitly selects them.
 *
 * Dependencies: Schema.gs, Utils.gs, SheetStore.gs, TeamService.gs, StaffService.gs
 */

/**
 * No fields are created automatically. Administrators add identifier
 * fields (e.g. Converse ID, CRM ID) under Configure Staff Fields when needed.
 * Fields created by v1.1.0 installations are kept as ordinary user data.
 */
var SEED_STAFF_FIELDS_ = [];

function rowToStaffField_(r) {
  var type = str_(r.fieldType).toUpperCase();
  if (!STAFF_FIELD_TYPES[type]) type = 'TEXT';
  return {
    fieldKey: str_(r.fieldKey),
    displayName: str_(r.displayName),
    fieldType: type,
    required: toBool_(r.required),
    visible: r.visible === '' || r.visible === null || r.visible === undefined ? true : toBool_(r.visible),
    matchable: type === 'IDENTIFIER' && toBool_(r.matchable),
    description: str_(r.description),
    displayOrder: toNumber_(r.displayOrder, 100),
    _row: r._row
  };
}

/** All registry fields in display order; [] before the v1.1 upgrade created the sheet. */
function listStaffFields_() {
  if (!getSheet_(T_STAFF_FIELDS.sheet)) return [];
  return readTable_(T_STAFF_FIELDS).rows.map(rowToStaffField_).filter(function (f) { return f.fieldKey; })
    .sort(function (a, b) { return a.displayOrder - b.displayOrder || a.displayName.localeCompare(b.displayName); });
}

/** fieldKey -> field */
function getStaffFieldMap_() {
  var m = {};
  listStaffFields_().forEach(function (f) { m[f.fieldKey] = f; });
  return m;
}

function seedStaffFieldsIfEmpty_() {
  if (!SEED_STAFF_FIELDS_.length || listStaffFields_().length) return false;
  var now = new Date();
  appendObjects_(T_STAFF_FIELDS, SEED_STAFF_FIELDS_.map(function (s) {
    return { fieldKey: s.fieldKey, displayName: s.displayName, fieldType: 'IDENTIFIER', required: false, visible: true,
      matchable: true, description: 'External identifier (seeded default; rename or hide freely).', createdAt: now, updatedAt: now };
  }));
  return true;
}

/** Adds a fatal message for every field:<key> that is not in the registry. */
function validateRegistryRefs_(staffFields, rep) {
  var map = getStaffFieldMap_();
  (staffFields || []).forEach(function (f) {
    if (f.indexOf(STAFF_REGISTRY_PREFIX) !== 0) return;
    var k = f.substr(STAFF_REGISTRY_PREFIX.length);
    if (!map[k]) rep.fatal.push('Staff field "' + k + '" does not exist. Create it under Configure Staff Fields.');
  });
}

/** Next free key: external_id_N for identifiers, field_N for text fields. */
function makeFieldKey_(fieldType, existingKeys) {
  var prefix = fieldType === 'IDENTIFIER' ? 'external_id_' : 'field_';
  var n = 1;
  while (existingKeys.indexOf(prefix + n) >= 0) n++;
  return prefix + n;
}

/**
 * Creates or updates a registry field. Internal (no lock).
 * @param {Object} input {fieldKey?, displayName, fieldType, required, visible, matchable, description}
 * @return {{field: Object, renamed: boolean, created: boolean}}
 */
function saveStaffField_(input) {
  var rep = newReport_();
  var all = listStaffFields_();
  var existing = null;
  if (input.fieldKey) {
    all.forEach(function (f) { if (f.fieldKey === input.fieldKey) existing = f; });
    if (!existing) rep.fatal.push('Staff field ' + input.fieldKey + ' no longer exists.');
  }
  var name = sanitizeSheetName_(input.displayName).substr(0, 50).trim();
  if (!name) rep.fatal.push('Enter a display name.');
  var lower = name.toLowerCase();
  Object.keys(STAFF_FIELD_DEFS).forEach(function (k) {
    if (STAFF_FIELD_DEFS[k].label.toLowerCase() === lower) rep.fatal.push('"' + name + '" is a built-in staff column name. Choose another name.');
  });
  all.forEach(function (f) {
    if (f.displayName.toLowerCase() === lower && (!existing || f.fieldKey !== existing.fieldKey)) rep.fatal.push('A staff field named "' + f.displayName + '" already exists.');
  });
  var type = str_(input.fieldType || (existing ? existing.fieldType : 'IDENTIFIER')).toUpperCase();
  if (!STAFF_FIELD_TYPES[type]) rep.fatal.push('Field type must be IDENTIFIER or TEXT.');
  if (rep.fatal.length) fail_('VALIDATION', rep.fatal.join(' '), rep);

  var now = new Date();
  var obj = {
    fieldKey: existing ? existing.fieldKey : makeFieldKey_(type, all.map(function (f) { return f.fieldKey; })),
    displayName: name,
    fieldType: type,
    required: !!input.required,
    visible: input.visible === undefined ? true : !!input.visible,
    matchable: type === 'IDENTIFIER' && (input.matchable === undefined ? true : !!input.matchable),
    description: str_(input.description).substr(0, 300),
    displayOrder: Math.max(0, Math.min(9999, Math.round(toNumber_(input.displayOrder, existing ? existing.displayOrder : (all.length + 1) * 10)))),
    updatedAt: now
  };
  if (existing) { obj._row = existing._row; updateObject_(T_STAFF_FIELDS, obj); }
  else { obj.createdAt = now; appendObjects_(T_STAFF_FIELDS, [obj]); }
  return { field: obj, renamed: !!existing && existing.displayName !== name, created: !existing };
}

function teamsUsingStaffField_(fieldKey) {
  var ref = STAFF_REGISTRY_PREFIX + fieldKey;
  return listTeams_().filter(function (t) { return t.settings.staffFields.indexOf(ref) >= 0; });
}

/**
 * Sets which teams use a field. Removing a field from a team hides its column
 * (values are kept). Returns the names of teams that changed.
 */
function setStaffFieldTeams_(fieldKey, teamIds) {
  var map = getStaffFieldMap_();
  if (!map[fieldKey]) fail_('NOT_FOUND', 'Staff field ' + fieldKey + ' no longer exists.');
  var ref = STAFF_REGISTRY_PREFIX + fieldKey;
  var changed = [];
  listTeams_().forEach(function (team) {
    var want = (teamIds || []).indexOf(team.teamId) >= 0;
    var has = team.settings.staffFields.indexOf(ref) >= 0;
    if (want === has) return;
    if (want) team.settings.staffFields = normalizeStaffFields_(team.settings.staffFields.concat([ref]));
    else {
      team.settings.staffFields = team.settings.staffFields.filter(function (f) { return f !== ref; });
      if (team.settings.import.matchField === ref) team.settings.import.matchField = 'employeeId';
    }
    saveTeamRow_(team);
    changed.push(team.teamName);
  });
  relayoutAllStaffSheets_();
  return changed;
}

/**
 * Deletes a registry field. The field is removed from every team. Its staff
 * sheet columns are KEPT as plain, unmanaged columns (values preserved) unless
 * deleteValues is true AND confirmText equals the field's display name — then
 * the column values are permanently cleared (header kept, marked "(deleted)").
 */
function deleteStaffField_(fieldKey, deleteValues, confirmText) {
  var map = getStaffFieldMap_();
  var f = map[fieldKey];
  if (!f) fail_('NOT_FOUND', 'Staff field ' + fieldKey + ' no longer exists.');
  if (deleteValues && str_(confirmText) !== f.displayName) {
    fail_('CONFIRMATION', 'To permanently delete the stored values, type the field name exactly: "' + f.displayName + '".');
  }
  var ref = STAFF_REGISTRY_PREFIX + fieldKey;
  var cleared = 0, sheetsDone = {};
  listTeams_().forEach(function (team) {
    var sh = team.status === TEAM_STATUS.READY ? resolveTeamSheet_(team, 'staff') : null;
    if (sh && !sheetsDone[sh.getSheetId()]) {
      sheetsDone[sh.getSheetId()] = true;
      var H = STAFF_LAYOUT.HEADER_ROW, lc = sh.getLastColumn();
      if (lc >= 1) {
        var hdr = sh.getRange(H, 1, 1, lc);
        var keys = resolveStaffColumns_(hdr.getValues()[0].map(str_), hdr.getNotes()[0], map);
        var i = keys.indexOf(ref);
        if (i >= 0) {
          // Unlink the column (remove the key note) so it becomes an ordinary user column.
          sh.getRange(H, i + 1).setNote('').setValue(f.displayName + (deleteValues ? ' (deleted)' : ''));
          sh.showColumns(i + 1);
          if (deleteValues && sh.getLastRow() > H) {
            sh.getRange(H + 1, i + 1, sh.getLastRow() - H, 1).clearContent();
            cleared++;
          }
        }
      }
    }
    if (team.settings.staffFields.indexOf(ref) >= 0 || team.settings.import.matchField === ref) {
      team.settings.staffFields = team.settings.staffFields.filter(function (x) { return x !== ref; });
      if (team.settings.import.matchField === ref) team.settings.import.matchField = 'employeeId';
      saveTeamRow_(team);
    }
  });
  listTeamTypes_(true).forEach(function (t) {
    if (t.staffFields.indexOf(ref) < 0) return;
    t.staffFields = t.staffFields.filter(function (x) { return x !== ref; });
    t.updatedAt = new Date();
    updateObject_(T_TEAM_TYPES, t);
  });
  deleteSheetRows_(requireSheet_(T_STAFF_FIELDS.sheet), [f._row]);
  return { deleted: f.displayName, valuesDeleted: !!deleteValues, columnsCleared: cleared };
}

/** Re-applies the staff sheet layout of every READY team (renames, visibility). */
function relayoutAllStaffSheets_() {
  var problems = [];
  listTeams_().forEach(function (team) {
    if (team.status !== TEAM_STATUS.READY) return;
    try {
      var sh = resolveTeamSheet_(team, 'staff');
      if (sh) layoutStaffSheet_(sh, team);
    } catch (e) {
      logError_('relayoutAllStaffSheets_', e);
      problems.push(team.teamName + ': ' + toUserError_(e).message);
    }
  });
  return problems;
}

/* ------------------------------------------------------------------------ */
/* Client API (StaffFieldsDialog.html)                                       */
/* ------------------------------------------------------------------------ */

function apiStaffFieldsBootstrap() {
  return apiCall_('apiStaffFieldsBootstrap', function () {
    requireInitialized_();
    return {
      fields: listStaffFields_(),
      teams: listTeams_().map(function (t) { return { teamId: t.teamId, teamName: t.teamName, staffFields: t.settings.staffFields }; }),
      builtIn: STAFF_FIELD_DEFS,
      types: STAFF_FIELD_TYPES
    };
  });
}

function apiSaveStaffField(input) {
  return apiCall_('apiSaveStaffField', function () {
    requireInitialized_();
    return withLock_(function () {
      var r = saveStaffField_(input || {});
      var problems = relayoutAllStaffSheets_();
      return { field: r.field, renamed: r.renamed, created: r.created, problems: problems };
    }, 60000);
  });
}

function apiDeleteStaffField(fieldKey, deleteValues, confirmText) {
  return apiCall_('apiDeleteStaffField', function () {
    requireInitialized_();
    return withLock_(function () { return deleteStaffField_(fieldKey, !!deleteValues, confirmText); }, 60000);
  });
}

function apiSetStaffFieldTeams(fieldKey, teamIds) {
  return apiCall_('apiSetStaffFieldTeams', function () {
    requireInitialized_();
    return withLock_(function () { return { changedTeams: setStaffFieldTeams_(fieldKey, teamIds) }; }, 60000);
  });
}
