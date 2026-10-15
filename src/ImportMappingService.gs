/**
 * ImportMappingService.gs
 * Mapping profiles (_IMPORT_MAPPINGS) and automatic source-column detection.
 *
 * IMPORTANT: DEFAULT_SYNONYMS are heuristic guesses for common header wording.
 * They are NOT verified Quinyx column names. Auto-mapping is only a suggestion;
 * the administrator always confirms or corrects the mapping, and saved profiles
 * pin the exact headers of a real export.
 *
 * Dependencies: Schema.gs, Utils.gs, SheetStore.gs, ConfigService.gs
 */

var DEFAULT_SYNONYMS = {
  shiftId: ['shift id', 'shiftid', 'shift key', 'shift number', 'schedule id', 'assignment id'],
  employeeId: ['employee id', 'employee number', 'employee no', 'employee nr', 'emp id', 'emp no',
    'personnel number', 'personnel no', 'staff id', 'staff number', 'badge number', 'employee code', 'person id'],
  employeeName: ['employee', 'employee name', 'name', 'full name', 'staff name', 'person', 'employee full name'],
  firstName: ['first name', 'firstname', 'given name'],
  lastName: ['last name', 'lastname', 'surname', 'family name'],
  team: ['team', 'section', 'unit', 'department', 'group', 'team name', 'section name', 'unit name'],
  date: ['date', 'shift date', 'start date', 'day', 'work date', 'schedule date'],
  endDate: ['end date', 'stop date', 'finish date'],
  start: ['start', 'start time', 'shift start', 'from', 'begin', 'begin time', 'starts', 'time from'],
  end: ['end', 'end time', 'shift end', 'to', 'stop', 'stop time', 'finish', 'finish time', 'ends', 'time to'],
  breakStart: ['break start', 'break from', 'pause start'],
  breakEnd: ['break end', 'break to', 'pause end'],
  breakMinutes: ['break', 'breaks', 'break duration', 'break length', 'break minutes', 'break time', 'unpaid break', 'pause'],
  shiftType: ['shift type', 'shifttype', 'shift type name', 'type of shift'],
  shiftInfo: ['shift', 'shift information', 'shift info', 'shift time', 'shift times', 'working time', 'time range'],
  scheduledHours: ['hours', 'scheduled hours', 'hours worked', 'worked hours', 'total hours', 'planned hours'],
  activity: ['activity', 'task', 'activity type', 'shift name'],
  role: ['role', 'position', 'job title', 'job role'],
  shiftStatus: ['status', 'shift status', 'state'],
  comment: ['comment', 'comments', 'note', 'notes', 'remark', 'remarks']
};

var DEFAULT_PROFILE_OPTIONS = {
  format: 'TABLE', dateOrder: 'AUTO', breakUnit: 'MINUTES', hoursUnit: 'HOURS', headerRow: 0,
  defaultTeamId: '', teamValueMap: {}, dailyLayout: null
};
var QUINYX_DAILY_PROFILE_ID = 'MAP_QUINYX_DAILY_SCHEDULE';

/** Built-in synonyms merged with AUTO_MAP_SYNONYMS from _CONFIG. */
function getSynonyms_(cfg) {
  var out = JSON.parse(JSON.stringify(DEFAULT_SYNONYMS));
  var extra = parseJson_(cfg && cfg.AUTO_MAP_SYNONYMS, {}) || {};
  Object.keys(extra).forEach(function (f) {
    if (!out[f] || !Array.isArray(extra[f])) return;
    extra[f].forEach(function (h) { out[f].push(String(h)); });
  });
  return out;
}

/** normalized header -> [fields] */
function buildSynonymIndex_(synonyms) {
  var idx = {};
  Object.keys(synonyms).forEach(function (f) {
    synonyms[f].forEach(function (h) {
      var k = normKey_(h);
      if (!k) return;
      idx[k] = idx[k] || [];
      if (idx[k].indexOf(f) < 0) idx[k].push(f);
    });
  });
  return idx;
}

/**
 * Suggests a mapping from header names.
 * @return {{fieldMap: Object, ambiguous: Array, unmatched: string[]}}
 *   fieldMap: field -> header label. A field with several matching headers is
 *   reported as ambiguous and left unmapped.
 */
function autoMapHeaders_(headers, synIndex) {
  var candidates = {};
  var unmatched = [];
  headers.forEach(function (h) {
    var fields = synIndex[normKey_(h)] || [];
    if (!fields.length) { unmatched.push(h); return; }
    fields.forEach(function (f) {
      candidates[f] = candidates[f] || [];
      candidates[f].push(h);
    });
  });
  var fieldMap = {}, ambiguous = [];
  Object.keys(candidates).forEach(function (f) {
    if (candidates[f].length === 1) fieldMap[f] = candidates[f][0];
    else ambiguous.push({ field: f, candidates: candidates[f] });
  });
  return { fieldMap: fieldMap, ambiguous: ambiguous, unmatched: unmatched };
}

/** Order-independent signature of a header row (used to recognize a known export format). */
function headerSignature_(headers) {
  return hash64_(headers.map(normKey_).filter(Boolean).sort().join('|'));
}

/**
 * Resolves a fieldMap (field -> header label) against actual headers.
 * Exact label match first, then normalized match.
 * @return {{columns: Object, missing: Array}} columns: field -> 0-based index
 */
function resolveFieldMap_(fieldMap, headers) {
  var columns = {}, missing = [];
  var norm = headers.map(normKey_);
  Object.keys(fieldMap || {}).forEach(function (f) {
    var h = str_(fieldMap[f]);
    if (!h) return;
    var i = headers.indexOf(h);
    if (i < 0) i = norm.indexOf(normKey_(h));
    if (i < 0) missing.push({ field: f, header: h });
    else columns[f] = i;
  });
  return { columns: columns, missing: missing };
}

function importFieldLabel_(f) {
  for (var i = 0; i < IMPORT_FIELDS.length; i++) if (IMPORT_FIELDS[i].key === f) return IMPORT_FIELDS[i].label;
  return f;
}

/**
 * Checks that a resolved mapping can produce valid records.
 * @param {Object} columns field -> index
 * @return {Object} report
 */
function validateMapping_(columns) {
  var rep = newReport_();
  var has = function (f) { return columns[f] !== undefined && columns[f] >= 0; };
  if (!has('employeeId') && !has('employeeName') && !has('firstName') && !has('lastName')) {
    rep.fatal.push('No employee column is mapped. Map "Employee ID" (preferred) or "Employee Name".');
  }
  if (has('shiftInfo') && (has('start') || has('end'))) {
    rep.fatal.push('Map either "Shift Information" (one time-range column) or "Shift Start" + "Shift End", not both.');
  } else if (!has('shiftInfo')) {
    if (!has('start')) rep.fatal.push('No column is mapped to "Shift Start" (or "Shift Information").');
    if (!has('end')) rep.fatal.push('No column is mapped to "Shift End" (or "Shift Information").');
  }
  if (!has('date')) rep.info.push('No "Shift Date" column is mapped: every start (or shift information) value must then contain a full date and time.');
  if (!has('employeeId')) rep.warnings.push('No Employee ID column is mapped. Employees will be matched by name only, and those matches are flagged as uncertain.');
  if (!has('shiftId')) rep.info.push('No source Shift ID is mapped. Duplicates are detected with a composite key (team + employee + start + end + activity).');
  if (!has('team')) rep.info.push('No team column is mapped. You must choose the target team explicitly.');
  if (has('firstName') !== has('lastName') && !has('employeeName')) rep.warnings.push('Only one of First Name / Last Name is mapped; names will be incomplete.');
  // Same header used for different fields is allowed only for date + start/end combos.
  var byIndex = {};
  Object.keys(columns).forEach(function (f) { (byIndex[columns[f]] = byIndex[columns[f]] || []).push(f); });
  Object.keys(byIndex).forEach(function (i) {
    var fs = byIndex[i];
    if (fs.length < 2) return;
    var okCombo = fs.every(function (f) { return ['date', 'start', 'endDate', 'end'].indexOf(f) >= 0; }) &&
      !(fs.indexOf('start') >= 0 && fs.indexOf('end') >= 0);
    if (!okCombo) rep.fatal.push('One source column is mapped to several fields (' + fs.map(importFieldLabel_).join(', ') + '). Map each field to its own column.');
  });
  return rep;
}

/* ------------------------------------------------------------------------ */
/* Profile persistence                                                       */
/* ------------------------------------------------------------------------ */

/** Daily Schedule layout merged over the default (pure, tolerant). Column letters upper-cased. */
function normalizeDailyLayout_(l) {
  var out = JSON.parse(JSON.stringify(DEFAULT_DAILY_LAYOUT));
  l = l && typeof l === 'object' ? l : {};
  Object.keys(out).forEach(function (k) {
    if (!Object.prototype.hasOwnProperty.call(l, k) || l[k] === null || l[k] === undefined) return;
    var d = DEFAULT_DAILY_LAYOUT[k];
    if (typeof d === 'boolean') out[k] = toBool_(l[k]);
    else if (typeof d === 'number') out[k] = toNumber_(l[k], d);
    else out[k] = str_(l[k]).toUpperCase();
  });
  return out;
}

/** Validates a Daily Schedule layout; returns the normalized layout. */
function validateDailyLayout_(l, rep) {
  var out = normalizeDailyLayout_(l);
  var intIn = function (v, lo, hi) { return Math.floor(v) === v && v >= lo && v <= hi; };
  if (!intIn(out.titleRow, 0, 20)) rep.fatal.push('Title row must be 0 (no title) to 20.');
  if (!intIn(out.headerRow, 0, 50)) rep.fatal.push('Header row must be 0 (none) to 50.');
  if (!intIn(out.firstDataRow, 1, 60)) rep.fatal.push('First data row must be 1 to 60.');
  if (out.firstDataRow <= out.headerRow || out.firstDataRow <= out.titleRow) rep.fatal.push('The first data row must come after the title and header rows.');
  ['titleColumn', 'shiftTypeColumn', 'employeeNameColumn', 'shiftInfoColumn', 'hoursColumn', 'employeeIdColumn'].forEach(function (k) {
    if (out[k] && !columnNumber_(out[k])) rep.fatal.push('"' + out[k] + '" is not a column letter.');
  });
  if (!out.shiftInfoColumn) rep.fatal.push('The shift information column is required.');
  if (!out.employeeNameColumn && !out.employeeIdColumn) rep.fatal.push('An employee name (or employee ID) column is required.');
  if (out.titleRow && !out.titleColumn) rep.fatal.push('Set the title column (the cell containing "Daily schedule <date>").');
  var cols = ['shiftTypeColumn', 'employeeNameColumn', 'shiftInfoColumn', 'hoursColumn', 'employeeIdColumn']
    .map(function (k) { return out[k]; }).filter(Boolean);
  if (uniq_(cols).length !== cols.length) rep.fatal.push('Each data column letter may be used only once.');
  return out;
}

function rowToProfile_(r) {
  var options = r.options && typeof r.options === 'object' ? r.options : {};
  var merged = JSON.parse(JSON.stringify(DEFAULT_PROFILE_OPTIONS));
  Object.keys(options).forEach(function (k) { merged[k] = options[k]; });
  if (!IMPORT_FORMATS[merged.format]) merged.format = 'TABLE';
  merged.dailyLayout = merged.format === 'QUINYX_DAILY' ? normalizeDailyLayout_(merged.dailyLayout) : null;
  return {
    profileId: str_(r.profileId),
    profileName: str_(r.profileName),
    description: str_(r.description),
    fieldMap: r.fieldMap && typeof r.fieldMap === 'object' ? r.fieldMap : {},
    options: merged,
    headerSignature: str_(r.headerSignature),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    _row: r._row
  };
}

function listProfiles_() {
  return readTable_(T_MAPPINGS).rows.map(rowToProfile_).filter(function (p) { return p.profileId; });
}

function getProfile_(profileId) {
  var all = listProfiles_();
  for (var i = 0; i < all.length; i++) if (all[i].profileId === profileId) return all[i];
  return null;
}

function normalizeProfileOptions_(o, rep) {
  o = o || {};
  var out = JSON.parse(JSON.stringify(DEFAULT_PROFILE_OPTIONS));
  if (o.format) {
    if (!IMPORT_FORMATS[o.format]) rep.fatal.push('Unknown import format "' + o.format + '".');
    else out.format = o.format;
  }
  if (o.hoursUnit) {
    if (['MINUTES', 'HOURS'].indexOf(o.hoursUnit) < 0) rep.fatal.push('Hours unit must be HOURS or MINUTES.');
    else out.hoursUnit = o.hoursUnit;
  }
  out.dailyLayout = out.format === 'QUINYX_DAILY' ? validateDailyLayout_(o.dailyLayout, rep) : null;
  if (o.dateOrder) {
    if (['AUTO', 'DMY', 'MDY', 'YMD'].indexOf(o.dateOrder) < 0) rep.fatal.push('Date order must be AUTO, DMY, MDY or YMD.');
    else out.dateOrder = o.dateOrder;
  }
  if (o.breakUnit) {
    if (['MINUTES', 'HOURS'].indexOf(o.breakUnit) < 0) rep.fatal.push('Break unit must be MINUTES or HOURS.');
    else out.breakUnit = o.breakUnit;
  }
  var hr = toNumber_(o.headerRow, 0);
  if (!(hr >= 0 && hr <= 50 && Math.floor(hr) === hr)) rep.fatal.push('Header row must be 0 (auto-detect) or a row number up to 50.');
  else out.headerRow = hr;
  out.defaultTeamId = str_(o.defaultTeamId);
  var tvm = o.teamValueMap && typeof o.teamValueMap === 'object' ? o.teamValueMap : {};
  out.teamValueMap = {};
  Object.keys(tvm).forEach(function (k) { if (str_(k) && str_(tvm[k])) out.teamValueMap[str_(k)] = str_(tvm[k]); });
  return out;
}

/**
 * Creates or updates a profile. Internal (no lock).
 * @param {Object} input {profileId?, profileName, description, fieldMap, options}
 * @param {string[]=} headers headers of the file the profile was built from (for the signature)
 */
function saveProfile_(input, headers) {
  var rep = newReport_();
  var name = str_(input.profileName);
  if (!name) rep.fatal.push('Profile name is required.');
  var all = listProfiles_();
  var existing = input.profileId ? getProfile_(input.profileId) : null;
  if (input.profileId && !existing) rep.fatal.push('Profile ' + input.profileId + ' no longer exists.');
  all.forEach(function (p) {
    if (normKey_(p.profileName) === normKey_(name) && (!existing || p.profileId !== existing.profileId)) {
      rep.fatal.push('A profile named "' + p.profileName + '" already exists.');
    }
  });
  var known = IMPORT_FIELDS.map(function (f) { return f.key; });
  var fieldMap = {};
  Object.keys(input.fieldMap || {}).forEach(function (f) {
    var h = str_(input.fieldMap[f]);
    if (!h) return;
    if (known.indexOf(f) < 0) rep.fatal.push('Unknown internal field "' + f + '".');
    else fieldMap[f] = h;
  });
  var options = normalizeProfileOptions_(input.options, rep);
  if (rep.fatal.length) fail_('VALIDATION', rep.fatal.join(' '), rep);

  var now = new Date();
  var newId = input.newProfileId && !all.some(function (p) { return p.profileId === input.newProfileId; }) ? input.newProfileId
    : 'MAP_' + makeTypeId_(name, all.map(function (p) { return p.profileId.replace(/^MAP_/, ''); }));
  var obj = {
    profileId: existing ? existing.profileId : newId,
    profileName: name,
    description: str_(input.description).substr(0, 500),
    fieldMap: fieldMap,
    options: options,
    headerSignature: headers && headers.length ? headerSignature_(headers) : (existing ? existing.headerSignature : ''),
    updatedAt: now
  };
  if (existing) { obj._row = existing._row; updateObject_(T_MAPPINGS, obj); }
  else { obj.createdAt = now; appendObjects_(T_MAPPINGS, [obj]); }
  return obj;
}

/**
 * Picks the best saved profile for a header row.
 * 1) exact header signature, 2) profile whose mapped headers are all present
 *    (most mapped fields wins). Profiles with an empty field map never auto-match.
 */
function chooseProfileForHeaders_(profiles, headers) {
  profiles = profiles.filter(function (p) { return p.options.format !== 'QUINYX_DAILY'; });
  var sig = headerSignature_(headers);
  for (var i = 0; i < profiles.length; i++) {
    if (profiles[i].headerSignature === sig && Object.keys(profiles[i].fieldMap).length) {
      return { profile: profiles[i], reason: 'The file headers exactly match this saved profile.' };
    }
  }
  var best = null, bestCount = 0;
  profiles.forEach(function (p) {
    var n = Object.keys(p.fieldMap).length;
    if (!n) return;
    if (resolveFieldMap_(p.fieldMap, headers).missing.length) return;
    if (n > bestCount) { best = p; bestCount = n; }
  });
  if (best) return { profile: best, reason: 'All columns used by this saved profile are present in the file.' };
  return { profile: null, reason: 'No saved profile matches these headers; columns were mapped automatically from their names.' };
}

/** True when cell A1 looks like the title of a Quinyx "Daily schedule" export. */
function looksLikeDailySchedule_(table) {
  return !!(table && table[0] && /\bdaily\s+schedule\b/i.test(str_(table[0][0])));
}

/** The first Daily Schedule profile (seeded one preferred), or null. */
function findDailyProfile_(profiles) {
  var daily = profiles.filter(function (p) { return p.options.format === 'QUINYX_DAILY'; });
  var seeded = daily.filter(function (p) { return p.profileId === QUINYX_DAILY_PROFILE_ID; })[0];
  return seeded || daily[0] || null;
}

/** Creates the default "Quinyx Daily Schedule" profile if it does not exist. Idempotent. */
function seedDailyProfileIfMissing_() {
  if (getProfile_(QUINYX_DAILY_PROFILE_ID)) return false;
  var name = 'Quinyx Daily Schedule';
  if (listProfiles_().some(function (p) { return normKey_(p.profileName) === normKey_(name); })) name += ' (default layout)';
  saveProfile_({
    newProfileId: QUINYX_DAILY_PROFILE_ID,
    profileName: name,
    description: 'Default layout for the Quinyx "Daily Schedule" export AS DESCRIBED (not yet verified against a real file): ' +
      'A1 = "Daily schedule <date>", row 2 = column labels, data from row 3; A = shift type, B = employee name, ' +
      'C = shift information, F = hours. Adjust rows/columns here or in the import wizard once a real export is available.',
    fieldMap: {},
    options: { format: 'QUINYX_DAILY', dateOrder: 'AUTO', hoursUnit: 'HOURS', dailyLayout: DEFAULT_DAILY_LAYOUT }
  }, null);
  return true;
}

function profilesReferencing_(profileId) {
  var refs = [];
  listTeams_().forEach(function (t) { if (t.importProfileId === profileId) refs.push('team "' + t.teamName + '"'); });
  listTeamTypes_(true).forEach(function (t) { if (t.defaultImportProfileId === profileId) refs.push('team type "' + t.typeName + '"'); });
  return refs;
}

/* ------------------------------------------------------------------------ */
/* Client API                                                                */
/* ------------------------------------------------------------------------ */

function apiSaveMappingProfile(input, headers) {
  return apiCall_('apiSaveMappingProfile', function () {
    requireInitialized_();
    return withLock_(function () {
      var opts = (input && input.options) || {};
      if (opts.defaultTeamId && !getTeam_(opts.defaultTeamId)) fail_('VALIDATION', 'The default team of this profile does not exist.');
      var tvm = opts.teamValueMap || {};
      Object.keys(tvm).forEach(function (k) {
        if (!getTeam_(tvm[k])) fail_('VALIDATION', 'Team value "' + k + '" points to a team that does not exist (' + tvm[k] + ').');
      });
      return saveProfile_(input || {}, headers || null);
    });
  });
}

function apiDeleteMappingProfile(profileId) {
  return apiCall_('apiDeleteMappingProfile', function () {
    requireInitialized_();
    return withLock_(function () {
      var p = getProfile_(profileId);
      if (!p) fail_('NOT_FOUND', 'That profile no longer exists.');
      var refs = profilesReferencing_(profileId);
      if (refs.length) fail_('IN_USE', 'Profile "' + p.profileName + '" is used by ' + refs.join(', ') + '. Change those first.');
      deleteSheetRows_(requireSheet_(T_MAPPINGS.sheet), [p._row]);
      return { deleted: profileId };
    });
  });
}
