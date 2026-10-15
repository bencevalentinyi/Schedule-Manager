/**
 * TeamTypeService.gs
 * Team type definitions (_TEAM_TYPES): reusable defaults for schedule fields,
 * staff fields, display settings and the default import profile.
 *
 * Dependencies: Schema.gs, Utils.gs, SheetStore.gs, ImportMappingService.gs, TeamService.gs
 */

function rowToTeamType_(r) {
  return {
    typeId: str_(r.typeId),
    typeName: str_(r.typeName),
    description: str_(r.description),
    scheduleFields: normalizeScheduleFields_(Array.isArray(r.scheduleFields) ? r.scheduleFields : DEFAULT_SCHEDULE_FIELDS),
    staffFields: normalizeStaffFields_(Array.isArray(r.staffFields) ? r.staffFields : DEFAULT_STAFF_FIELDS),
    defaultImportProfileId: str_(r.defaultImportProfileId),
    display: mergeDisplay_(r.display),
    enabled: r.enabled === '' || r.enabled === null ? true : toBool_(r.enabled),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    _row: r._row
  };
}

function listTeamTypes_(includeDisabled) {
  return readTable_(T_TEAM_TYPES).rows.map(rowToTeamType_).filter(function (t) {
    return t.typeId && (includeDisabled || t.enabled);
  });
}

function getTeamType_(typeId) {
  var all = listTeamTypes_(true);
  for (var i = 0; i < all.length; i++) if (all[i].typeId === typeId) return all[i];
  return null;
}

/** Display settings merged over defaults, with types coerced. */
/**
 * Display settings merged over defaults, with types coerced. Backward compatible:
 * v1.0 stored workdayStart/workdayEnd; those become STANDARD operating hours.
 */
function mergeDisplay_(d) {
  var out = JSON.parse(JSON.stringify(DEFAULT_DISPLAY));
  d = d && typeof d === 'object' ? d : {};
  Object.keys(out).forEach(function (k) {
    if (d[k] === undefined || d[k] === null || d[k] === '') return;
    out[k] = typeof DEFAULT_DISPLAY[k] === 'boolean' ? toBool_(d[k]) : String(d[k]);
  });
  if (!d.operatingHoursMode && (d.workdayStart || d.workdayEnd)) {
    out.operatingHoursMode = 'STANDARD';
    if (d.workdayStart) out.operatingHoursStart = String(d.workdayStart);
    if (d.workdayEnd) out.operatingHoursEnd = String(d.workdayEnd);
  }
  if (!OPERATING_HOURS_MODES[out.operatingHoursMode]) out.operatingHoursMode = 'STANDARD';
  if (out.operatingHoursMode === '24_7') { out.operatingHoursStart = '00:00'; out.operatingHoursEnd = '23:59'; }
  if (!DEFAULT_DATE_MODES[out.defaultDate]) out.defaultDate = 'KEEP';
  if (!VIEW_REGISTRY[out.granularity]) out.granularity = 'DAILY';
  if (!VIEW_REGISTRY[out.defaultView]) out.defaultView = 'DAILY';
  if (out.layout !== 'CUSTOM') out.layout = 'STANDARD';
  return out;
}

function validateDisplay_(d, rep) {
  if (d.operatingHoursMode === '24_7') return;
  var s = hmToMinutes_(d.operatingHoursStart), e = hmToMinutes_(d.operatingHoursEnd);
  if (s === null || s >= 1440) rep.fatal.push('Operating hours start must be a time HH:mm between 00:00 and 23:59.');
  if (e === null) rep.fatal.push('Operating hours end must be a time HH:mm (00:00–24:00).');
  if (s === null || e === null) return;
  if (d.operatingHoursMode === 'STANDARD' && e <= s) {
    rep.fatal.push('Standard operating hours must end after they start on the same day. Use "Custom operating hours" for hours that cross midnight, or "24/7 coverage".');
  }
  if (d.operatingHoursMode === 'CUSTOM' && (e === s || (s === 0 && (e === 1440 || e === 1439)))) {
    rep.fatal.push('These custom hours cover the whole day. Choose "24/7 coverage" instead.');
  }
}

/**
 * The operating window of a team relative to 00:00 of the displayed date.
 * 24/7 = [0, 1440). Custom hours ending at or before their start cross midnight
 * (e.g. 18:00–06:00 = [1080, 1800)). An end of 23:59 means "until midnight".
 * @return {{startMin: number, endMin: number, fullDay: boolean, crossesMidnight: boolean, label: string}}
 */
function operatingWindow_(display) {
  var d = display || DEFAULT_DISPLAY;
  if (d.operatingHoursMode === '24_7') return { startMin: 0, endMin: 1440, fullDay: true, crossesMidnight: false, label: '24/7' };
  var s = hmToMinutes_(d.operatingHoursStart), e = hmToMinutes_(d.operatingHoursEnd);
  if (s === null || s >= 1440) s = 360;
  if (e === null) e = 1320;
  if (e === 1439) e = 1440;
  if (e <= s) e += 1440;
  return {
    startMin: s, endMin: e, fullDay: e - s >= 1440, crossesMidnight: e > 1440,
    label: minutesToHm_(s) + '–' + (e % 1440 === 0 ? '24:00' : minutesToHm_(e)) + (e > 1440 ? ' (+1)' : '')
  };
}

/** Keeps known fields and extra:* fields; always keeps start and end; removes duplicates. */
function normalizeScheduleFields_(list) {
  var out = [];
  (list || []).forEach(function (f) {
    f = str_(f);
    if (DISPLAY_FIELDS[f]) out.push(f);
    else if (f.indexOf(EXTRA_FIELD_PREFIX) === 0 && f.length > EXTRA_FIELD_PREFIX.length) out.push(f);
  });
  out = uniq_(out);
  if (out.indexOf('employeeName') < 0 && out.indexOf('employeeId') < 0) out.unshift('employeeName');
  ['start', 'end'].forEach(function (f) { if (out.indexOf(f) < 0) out.push(f); });
  return out;
}

/**
 * Keeps known staff keys, registry fields (field:<key>) and legacy custom:Label
 * fields; enforces mandatory fields and keeps the order given.
 * Registry keys are checked syntactically here; existence is validated by callers.
 */
function normalizeStaffFields_(list) {
  var out = [];
  var stdLabels = Object.keys(STAFF_FIELD_DEFS).map(function (k) { return STAFF_FIELD_DEFS[k].label.toLowerCase(); });
  (list || []).forEach(function (f) {
    f = str_(f);
    if (STAFF_FIELD_DEFS[f]) { out.push(f); return; }
    if (/^field:[a-z0-9_]{1,40}$/.test(f)) { out.push(f); return; }
    if (f.indexOf(CUSTOM_FIELD_PREFIX) === 0) {
      var label = sanitizeSheetName_(f.substr(CUSTOM_FIELD_PREFIX.length)).substr(0, 50).trim();
      if (label && stdLabels.indexOf(label.toLowerCase()) < 0) out.push(CUSTOM_FIELD_PREFIX + label);
    }
  });
  out = uniq_(out);
  MANDATORY_STAFF_FIELDS.forEach(function (k) { if (out.indexOf(k) < 0) out.push(k); });
  // Identity columns first, the rest in the given order.
  var head = ['employeeId', 'employeeName'];
  return head.concat(out.filter(function (f) { return head.indexOf(f) < 0; }));
}

/**
 * Display label of a staff field key.
 * @param {string} f field key (standard key, field:<key> or custom:<Label>)
 * @param {Object=} registry map fieldKey -> registry entry (getStaffFieldMap_())
 */
function staffFieldLabel_(f, registry) {
  if (STAFF_FIELD_DEFS[f]) return STAFF_FIELD_DEFS[f].label;
  if (f.indexOf(STAFF_REGISTRY_PREFIX) === 0) {
    var k = f.substr(STAFF_REGISTRY_PREFIX.length);
    return registry && registry[k] ? registry[k].displayName : k;
  }
  return f.indexOf(CUSTOM_FIELD_PREFIX) === 0 ? f.substr(CUSTOM_FIELD_PREFIX.length) : f;
}

/** Builds a readable unique ID such as CUSTOMER_SUPPORT or CUSTOMER_SUPPORT_2. */
function makeTypeId_(name, existingIds) {
  var base = normText_(name).toUpperCase().replace(/ /g, '_').substr(0, 40) || 'TYPE';
  var id = base, i = 2;
  while (existingIds.indexOf(id) >= 0) id = base + '_' + (i++);
  return id;
}

/**
 * Creates or updates a team type. Internal (no lock).
 * @param {Object} input {typeId?, typeName, description, scheduleFields, staffFields,
 *                        defaultImportProfileId, display, enabled}
 * @return {Object} saved team type
 */
function saveTeamType_(input) {
  var rep = newReport_();
  var name = str_(input.typeName);
  if (!name) rep.fatal.push('Team type name is required.');
  if (name.length > 60) rep.fatal.push('Team type name must be 60 characters or fewer.');
  var all = listTeamTypes_(true);
  var existing = input.typeId ? getTeamType_(input.typeId) : null;
  if (input.typeId && !existing) rep.fatal.push('Team type ' + input.typeId + ' no longer exists.');
  all.forEach(function (t) {
    if (normKey_(t.typeName) === normKey_(name) && (!existing || t.typeId !== existing.typeId)) {
      rep.fatal.push('A team type named "' + t.typeName + '" already exists.');
    }
  });
  var profileId = str_(input.defaultImportProfileId);
  if (profileId && !getProfile_(profileId)) rep.fatal.push('The selected import profile does not exist.');
  var display = mergeDisplay_(input.display);
  validateDisplay_(display, rep);
  var staffFields = normalizeStaffFields_(input.staffFields);
  validateRegistryRefs_(staffFields, rep);
  if (rep.fatal.length) fail_('VALIDATION', rep.fatal.join(' '), rep);

  var now = new Date();
  var obj = {
    typeId: existing ? existing.typeId : makeTypeId_(name, all.map(function (t) { return t.typeId; })),
    typeName: name,
    description: str_(input.description).substr(0, 500),
    scheduleFields: normalizeScheduleFields_(input.scheduleFields),
    staffFields: staffFields,
    defaultImportProfileId: profileId,
    display: display,
    enabled: input.enabled === undefined ? true : !!input.enabled,
    updatedAt: now
  };
  if (existing) {
    obj._row = existing._row;
    updateObject_(T_TEAM_TYPES, obj);
  } else {
    obj.createdAt = now;
    appendObjects_(T_TEAM_TYPES, [obj]);
  }
  return obj;
}

function teamsUsingType_(typeId) {
  return listTeams_().filter(function (t) { return t.teamTypeId === typeId; });
}

/* ------------------------------------------------------------------------ */
/* Client API                                                                */
/* ------------------------------------------------------------------------ */

function apiListTeamTypes() {
  return apiCall_('apiListTeamTypes', function () {
    requireInitialized_();
    var teams = listTeams_();
    return {
      types: listTeamTypes_(true).map(function (t) {
        t.teamCount = teams.filter(function (x) { return x.teamTypeId === t.typeId; }).length;
        return t;
      }),
      profiles: listProfiles_(),
      displayFields: DISPLAY_FIELDS,
      staffFieldDefs: STAFF_FIELD_DEFS,
      staffRegistry: listStaffFields_(),
      operatingModes: OPERATING_HOURS_MODES,
      defaults: { scheduleFields: DEFAULT_SCHEDULE_FIELDS, staffFields: DEFAULT_STAFF_FIELDS, display: DEFAULT_DISPLAY }
    };
  });
}

function apiSaveTeamType(input) {
  return apiCall_('apiSaveTeamType', function () {
    requireInitialized_();
    return withLock_(function () {
      var saved = saveTeamType_(input || {});
      // Teams with STANDARD layout follow their type: re-render them.
      teamsUsingType_(saved.typeId).forEach(function (team) {
        if (team.status !== TEAM_STATUS.READY || team.settings.display.layout !== 'STANDARD') return;
        try {
          var sh = resolveTeamSheet_(team, 'schedule');
          if (sh) { layoutScheduleSheet_(sh, team); renderTeamView_(team, {}); }
        } catch (e) { logError_('apiSaveTeamType.rerender', e); }
      });
      return saved;
    });
  });
}

function apiSetTeamTypeEnabled(typeId, enabled) {
  return apiCall_('apiSetTeamTypeEnabled', function () {
    requireInitialized_();
    return withLock_(function () {
      var t = getTeamType_(typeId);
      if (!t) fail_('NOT_FOUND', 'That team type no longer exists.');
      t.enabled = !!enabled;
      t.updatedAt = new Date();
      updateObject_(T_TEAM_TYPES, t);
      return t;
    });
  });
}

function apiDeleteTeamType(typeId) {
  return apiCall_('apiDeleteTeamType', function () {
    requireInitialized_();
    return withLock_(function () {
      var t = getTeamType_(typeId);
      if (!t) fail_('NOT_FOUND', 'That team type no longer exists.');
      var users = teamsUsingType_(typeId);
      if (users.length) {
        fail_('IN_USE', 'Team type "' + t.typeName + '" is used by ' + users.length + ' team(s) (' +
          users.map(function (u) { return u.teamName; }).join(', ') + '). Disable it instead, or move those teams to another type first.');
      }
      deleteSheetRows_(requireSheet_(T_TEAM_TYPES.sheet), [t._row]);
      return { deleted: typeId };
    });
  });
}
