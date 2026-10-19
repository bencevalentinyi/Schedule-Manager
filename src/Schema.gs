/**
 * Schema.gs
 * Static definitions of the system itself: internal sheet schemas, field catalogs,
 * enumerations and layout constants. Contains NO deployment data (no team names,
 * no shift types, no Quinyx column names). Deployment data lives in the _ sheets.
 *
 * Every top-level value here is a plain constant, so load order across .gs files
 * does not matter (helpers used at load time are defined in this file).
 */

var APP = Object.freeze({
  NAME: 'Schedule Manager',
  VERSION: '1.1.3',
  MENU: 'Schedule Manager',
  // Stored versions whose sheets and configuration need no migration for this code
  // (1.1.2 changed only the user interface; 1.1.3 adds one configuration key, which is
  // read with its default until Setup adds it). Setup still records the new version.
  COMPATIBLE_VERSIONS: Object.freeze(['1.1.1', '1.1.2'])
});

/** True when a spreadsheet stored with this version must run Setup → Upgrade first. */
function versionNeedsUpgrade_(stored) {
  return stored !== APP.VERSION && APP.COMPATIBLE_VERSIONS.indexOf(stored) < 0;
}

/** Builds a column definition. Options: text (plain-text cell format), json, datetime, number. */
function col_(key, label, opts) {
  var c = { key: key, label: label };
  if (opts) Object.keys(opts).forEach(function (k) { c[k] = opts[k]; });
  return c;
}

/* ------------------------------------------------------------------------ */
/* Internal (system) tables                                                  */
/* New columns are appended by Setup → Repair/Upgrade (idempotent migration). */
/* ------------------------------------------------------------------------ */

var T_CONFIG = {
  sheet: '_CONFIG',
  purpose: 'Global key/value configuration.',
  columns: [
    col_('key', 'Key', { text: true }),
    col_('value', 'Value', { text: true }),
    col_('description', 'Description'),
    col_('updatedAt', 'Updated At', { datetime: true })
  ]
};

var T_TEAMS = {
  sheet: '_TEAMS',
  purpose: 'One row per team. Team ID is the stable key; names may change.',
  columns: [
    col_('teamId', 'Team ID', { text: true }),
    col_('teamName', 'Team Name', { text: true }),
    col_('teamTypeId', 'Team Type ID', { text: true }),
    col_('active', 'Active'),
    col_('status', 'Status', { text: true }),
    col_('scheduleSheet', 'Schedule Sheet', { text: true }),
    col_('staffSheet', 'Staff Sheet', { text: true }),
    col_('defaultView', 'Default View', { text: true }),
    col_('importProfileId', 'Import Profile ID', { text: true }),
    col_('importAliases', 'Import Aliases', { text: true }),
    col_('description', 'Description', { text: true }),
    col_('settings', 'Settings JSON', { text: true, json: true }),
    col_('createdAt', 'Created At', { datetime: true }),
    col_('updatedAt', 'Updated At', { datetime: true })
  ]
};

var T_TEAM_TYPES = {
  sheet: '_TEAM_TYPES',
  purpose: 'Reusable team type definitions (defaults for new teams).',
  columns: [
    col_('typeId', 'Team Type ID', { text: true }),
    col_('typeName', 'Team Type Name', { text: true }),
    col_('description', 'Description', { text: true }),
    col_('scheduleFields', 'Schedule Fields JSON', { text: true, json: true }),
    col_('staffFields', 'Staff Fields JSON', { text: true, json: true }),
    col_('defaultImportProfileId', 'Default Import Profile ID', { text: true }),
    col_('display', 'Display Settings JSON', { text: true, json: true }),
    col_('enabled', 'Enabled'),
    col_('createdAt', 'Created At', { datetime: true }),
    col_('updatedAt', 'Updated At', { datetime: true })
  ]
};

var T_MAPPINGS = {
  sheet: '_IMPORT_MAPPINGS',
  purpose: 'Saved mapping profiles: export format, layout / column mapping and parsing options.',
  columns: [
    col_('profileId', 'Profile ID', { text: true }),
    col_('profileName', 'Profile Name', { text: true }),
    col_('description', 'Description', { text: true }),
    col_('fieldMap', 'Field Map JSON', { text: true, json: true }),
    col_('options', 'Options JSON', { text: true, json: true }),
    col_('headerSignature', 'Header Signature', { text: true }),
    col_('createdAt', 'Created At', { datetime: true }),
    col_('updatedAt', 'Updated At', { datetime: true })
  ]
};

var T_SCHEDULE = {
  sheet: '_SCHEDULE_DATA',
  purpose: 'Source of truth: one normalized row per shift assignment. Team views are rendered from here.',
  columns: [
    col_('recordKey', 'Record Key', { text: true }),
    col_('teamId', 'Team ID', { text: true }),
    col_('shiftDate', 'Shift Date', { text: true }),
    col_('employeeId', 'Employee ID', { text: true }),
    col_('employeeName', 'Employee Name', { text: true }),
    col_('staffMatch', 'Staff Match', { text: true }),
    col_('activity', 'Activity', { text: true }),
    col_('role', 'Role', { text: true }),
    col_('shiftStart', 'Shift Start', { text: true }),
    col_('shiftEnd', 'Shift End', { text: true }),
    col_('grossMinutes', 'Gross Minutes', { number: true }),
    col_('shiftStatus', 'Shift Status', { text: true }),
    col_('recordStatus', 'Record Status', { text: true }),
    col_('sourceShiftId', 'Source Shift ID', { text: true }),
    col_('comment', 'Comment', { text: true }),
    col_('createdImportId', 'Created Import ID', { text: true }),
    col_('lastImportId', 'Last Import ID', { text: true }),
    col_('updatedAt', 'Updated At', { datetime: true }),
    col_('extra', 'Extra JSON', { text: true, json: true }),
    // v1.1
    col_('shiftType', 'Shift Type', { text: true }),
    col_('sourceShiftInfo', 'Source Shift Info', { text: true }),
    col_('sourceHours', 'Source Hours', { text: true }),
    col_('scheduledMinutes', 'Scheduled Minutes', { number: true }),
    // v1.1.1
    col_('activityCategory', 'Activity Category', { text: true })
  ]
};

var T_IMPORT_LOG = {
  sheet: '_IMPORT_LOG',
  purpose: 'One row per import attempt that reached the commit stage.',
  columns: [
    col_('importId', 'Import ID', { text: true }),
    col_('timestamp', 'Timestamp', { datetime: true }),
    col_('sourceFile', 'Source File', { text: true }),
    col_('sourceFileId', 'Source File ID', { text: true }),
    col_('format', 'Format', { text: true }),
    col_('profileId', 'Profile ID', { text: true }),
    col_('teams', 'Target Teams', { text: true }),
    col_('dateFrom', 'Date From', { text: true }),
    col_('dateTo', 'Date To', { text: true }),
    col_('rowsProcessed', 'Rows Processed', { number: true }),
    col_('rowsInserted', 'Rows Inserted', { number: true }),
    col_('rowsUpdated', 'Rows Updated', { number: true }),
    col_('rowsSkipped', 'Rows Skipped', { number: true }),
    col_('rowsRemoved', 'Rows Removed', { number: true }),
    col_('rowsRejected', 'Rows Rejected', { number: true }),
    col_('strategy', 'Strategy', { text: true }),
    col_('status', 'Status', { text: true }),
    col_('errorSummary', 'Error Summary', { text: true }),
    col_('user', 'User', { text: true }),
    col_('fileHash', 'File Hash', { text: true }),
    // v1.1
    col_('rowsExcluded', 'Rows Excluded (Shift Type)', { number: true }),
    col_('shiftTypes', 'Shift Types Imported', { text: true }),
    // v1.1.1
    col_('meetingsImported', 'Meetings Imported', { number: true }),
    col_('meetingsExcluded', 'Meetings Excluded', { number: true })
  ]
};

var T_CHANGES = {
  sheet: '_IMPORT_CHANGES',
  purpose: 'Undo journal: before-images of every record an import touched.',
  columns: [
    col_('importId', 'Import ID', { text: true }),
    col_('seq', 'Seq', { number: true }),
    col_('recordKey', 'Record Key', { text: true }),
    col_('action', 'Action', { text: true }),
    col_('before', 'Before JSON', { text: true })
  ]
};

var T_STAGING = {
  sheet: '_IMPORT_STAGING',
  purpose: 'Parsed source tables waiting for preview/confirmation (chunked JSON).',
  columns: [
    col_('importId', 'Import ID', { text: true }),
    col_('chunk', 'Chunk', { number: true }),
    col_('payload', 'Payload', { text: true }),
    col_('createdAt', 'Created At', { datetime: true })
  ]
};

var T_STAFF_MASTER = {
  sheet: '_STAFF_MASTER',
  purpose: 'Derived, read-only index of employees across teams. Rebuilt from team staff sheets (one-way).',
  columns: [
    col_('employeeId', 'Employee ID', { text: true }),
    col_('employeeName', 'Employee Name', { text: true }),
    col_('email', 'Email', { text: true }),
    col_('teamIds', 'Team IDs', { text: true }),
    col_('activeIn', 'Active In', { text: true }),
    col_('conflicts', 'Conflicts', { text: true }),
    col_('updatedAt', 'Updated At', { datetime: true })
  ]
};

/** v1.1: registry of configurable staff fields (external identifiers and custom fields). */
var T_STAFF_FIELDS = {
  sheet: '_STAFF_FIELDS',
  purpose: 'Configurable staff fields. Field Key is permanent; Display Name can be renamed without losing data.',
  columns: [
    col_('fieldKey', 'Field Key', { text: true }),
    col_('displayName', 'Display Name', { text: true }),
    col_('fieldType', 'Field Type', { text: true }),
    col_('required', 'Required'),
    col_('visible', 'Visible'),
    col_('matchable', 'Usable As Match Key'),
    col_('description', 'Description', { text: true }),
    col_('createdAt', 'Created At', { datetime: true }),
    col_('updatedAt', 'Updated At', { datetime: true }),
    // v1.1.1
    col_('displayOrder', 'Display Order', { number: true })
  ]
};

/** Creation / validation order of system sheets. */
var SYSTEM_TABLES = [T_CONFIG, T_TEAMS, T_TEAM_TYPES, T_MAPPINGS, T_SCHEDULE,
  T_IMPORT_LOG, T_CHANGES, T_STAGING, T_STAFF_MASTER, T_STAFF_FIELDS];

/* ------------------------------------------------------------------------ */
/* Enumerations                                                              */
/* ------------------------------------------------------------------------ */

var TEAM_STATUS = { PENDING: 'PENDING', READY: 'READY', ERROR: 'ERROR' };
var RECORD_STATUS = { ACTIVE: 'ACTIVE', REMOVED: 'REMOVED' };
var IMPORT_STATUS = {
  COMMITTING: 'COMMITTING', COMMITTED: 'COMMITTED', FAILED: 'FAILED',
  UNDONE: 'UNDONE', BLOCKED: 'BLOCKED'
};
var DUPLICATE_STRATEGIES = {
  ASK: 'Ask me (decide in the preview)',
  SKIP: 'Skip existing records (keep what is already stored)',
  UPDATE: 'Update matching records',
  REPLACE_RANGE: 'Replace the team\'s imported shifts for the imported date(s)'
};
var TEAM_MODES = {
  AUTO: 'Auto-detect',
  EXPLICIT: 'All rows go to the selected team',
  SPLIT: 'Split rows by the team column',
  FILTER: 'Only import rows belonging to the selected team',
  STAFF: 'All teams: each row goes to the team whose staff sheet lists the employee'
};
var ACTIVITY_CATEGORY = { SHIFT: 'SHIFT', MEETING: 'MEETING' };
var STAFF_MATCH = {
  ID: 'ID', NAME: 'NAME', AMBIGUOUS: 'AMBIGUOUS', UNKNOWN: 'UNKNOWN'
};
var NAME_MATCH_STRATEGIES = {
  '': 'Use the global setting',
  EXACT_FLAGGED: 'Unique exact name match, flagged for review',
  NONE: 'Never match by name (ID only)'
};

/** Import formats. TABLE = header row + rows; QUINYX_DAILY = "Daily schedule" export layout. */
var IMPORT_FORMATS = {
  QUINYX_DAILY: 'Quinyx "Daily Schedule" export',
  TABLE: 'Generic table (header row + one row per shift)'
};

/**
 * Default layout of the Quinyx "Daily Schedule" export, as DESCRIBED (not yet
 * verified against a real file): title + date in A1, column labels in row 2,
 * data from row 3; A = shift type, B = employee name, C = shift information,
 * F = hours. Every value is configurable per mapping profile.
 */
var DEFAULT_DAILY_LAYOUT = {
  titleRow: 1, titleColumn: 'A', headerRow: 2, firstDataRow: 3,
  shiftTypeColumn: 'A', employeeNameColumn: 'B', shiftInfoColumn: 'C', hoursColumn: 'F',
  employeeIdColumn: '', fillDownShiftType: false
};

var SHIFT_TYPE_MODES = {
  NOT_CONFIGURED: 'Not configured yet (imports will ask)',
  SELECTED: 'Import only the selected shift types',
  ALL: 'Import all shift types'
};

/* ------------------------------------------------------------------------ */
/* Import field catalog (internal fields a source column can map to)         */
/* ------------------------------------------------------------------------ */

var IMPORT_FIELDS = [
  { key: 'shiftId', label: 'Shift ID (source)', hint: 'Stable shift identifier, if the export has one. Preferred duplicate key.' },
  { key: 'employeeId', label: 'Employee ID', hint: 'Primary employee matching key (or the team\'s configured alternative key).' },
  { key: 'employeeName', label: 'Employee Name', hint: 'Full name. Used only as fallback for matching.' },
  { key: 'firstName', label: 'First Name', hint: 'Combined with Last Name if no full name column.' },
  { key: 'lastName', label: 'Last Name', hint: '' },
  { key: 'team', label: 'Team / Unit (source)', hint: 'Used to route rows to teams (via team name or import aliases).' },
  { key: 'shiftType', label: 'Shift Type', hint: 'Used for the team\'s shift-type filter.' },
  { key: 'date', label: 'Shift Date', hint: 'Required unless Start (or Shift Information) contains a full date-time.' },
  { key: 'endDate', label: 'End Date', hint: 'Optional. Without it, an end time earlier than the start is treated as overnight.' },
  { key: 'shiftInfo', label: 'Shift Information (time range)', hint: 'One cell with the start–end range, e.g. "08:00 - 16:00". Alternative to separate Start/End columns.' },
  { key: 'start', label: 'Shift Start', hint: 'Time (08:00) or date-time. Required unless Shift Information is mapped.' },
  { key: 'end', label: 'Shift End', hint: 'Time or date-time. Required unless Shift Information is mapped.' },
  { key: 'scheduledHours', label: 'Scheduled Hours', hint: 'Hours worked that day (7.5, 7,5, 7:30, 7h 30m). Compared with the shift, never overwritten.' },
  { key: 'activity', label: 'Activity', hint: '' },
  { key: 'role', label: 'Role', hint: '' },
  { key: 'shiftStatus', label: 'Shift Status', hint: '' },
  { key: 'comment', label: 'Comment', hint: '' }
];

/* ------------------------------------------------------------------------ */
/* Schedule view field catalog                                              */
/* ------------------------------------------------------------------------ */

var DISPLAY_FIELDS = {
  date: { label: 'Date', kind: 'date', width: 95 },
  employeeId: { label: 'Employee ID', kind: 'text', width: 100 },
  employeeName: { label: 'Employee Name', kind: 'text', width: 180 },
  team: { label: 'Team', kind: 'text', width: 130 },
  shiftType: { label: 'Shift Type', kind: 'text', width: 140 },
  activityCategory: { label: 'Category', kind: 'text', width: 85 },
  activity: { label: 'Activity', kind: 'text', width: 150 },
  role: { label: 'Role', kind: 'text', width: 120 },
  start: { label: 'Start', kind: 'time', width: 70 },
  end: { label: 'End', kind: 'time', width: 85 },
  grossDuration: { label: 'Shift Length', kind: 'duration', width: 90, group: 'durations' },
  scheduledHours: { label: 'Scheduled Hours', kind: 'duration', width: 100, group: 'durations' },
  sourceShiftInfo: { label: 'Shift Info (source)', kind: 'text', width: 150 },
  shiftStatus: { label: 'Shift Status', kind: 'text', width: 100 },
  flags: { label: 'Status / Flags', kind: 'text', width: 220 },
  staffMatch: { label: 'Staff Match', kind: 'text', width: 95 },
  comment: { label: 'Comment', kind: 'text', width: 200 }
};
var DEFAULT_SCHEDULE_FIELDS = ['employeeName', 'shiftType', 'start', 'end',
  'grossDuration', 'scheduledHours', 'flags'];
var EXTRA_FIELD_PREFIX = 'extra:';

/* ------------------------------------------------------------------------ */
/* Staff field catalog                                                       */
/* ------------------------------------------------------------------------ */

/** Built-in staff fields. Configurable identifier/custom fields live in _STAFF_FIELDS. */
var STAFF_FIELD_DEFS = {
  employeeId: { label: 'Employee ID', required: true, identifier: true, width: 110 },
  employeeName: { label: 'Employee Name', required: true, width: 190 },
  active: { label: 'Active', retired: true, width: 80 }, // retired: hidden in existing sheets, never offered; everyone is active
  role: { label: 'Role', width: 130 },
  notes: { label: 'Notes', width: 220 },
  email: { label: 'Email', width: 210 },
  team: { label: 'Team', width: 130 },
  skills: { label: 'Skills', width: 180 },
  lastUpdated: { label: 'Last Updated', width: 140 }
};
var MANDATORY_STAFF_FIELDS = ['employeeId', 'employeeName'];
var STAFF_REGISTRY_PREFIX = 'field:';   // team.settings.staffFields entry for a _STAFF_FIELDS field
var CUSTOM_FIELD_PREFIX = 'custom:';    // legacy (v1.0) free-text custom column, matched by label
var STAFF_FIELD_TYPES = { IDENTIFIER: 'External identifier (text, unique per team)', TEXT: 'Text' };

/** Default staff sheet: four columns. Identifier fields are created by administrators when needed. */
var DEFAULT_STAFF_FIELDS = ['employeeId', 'employeeName', 'role', 'notes'];
/** Earlier defaults; the migration upgrades a starter team type that still has exactly one of these lists. */
var LEGACY_DEFAULT_STAFF_FIELDS_V1 = ['employeeId', 'employeeName', 'email', 'team', 'role', 'active',
  'skills', 'notes', 'lastUpdated'];
var LEGACY_DEFAULT_STAFF_FIELDS_V110 = ['employeeId', 'employeeName', 'field:external_id_1', 'field:external_id_2',
  'field:external_id_3', 'active', 'role', 'notes'];

/* ------------------------------------------------------------------------ */
/* Display defaults and view registry                                       */
/* ------------------------------------------------------------------------ */

/**
 * Themes. Each theme styles the dialogs and sidebars (an optional HTML file loaded after Styles;
 * DEFAULT has none) and every generated sheet: daily schedules, staff sheets and the Dashboard.
 * sheet: font = Google Sheets font family; header/headerText = column header row; accent = titles,
 * tab color, date-cell border and the headcount scale; band = alternating rows; soft = filter cells
 * and secondary headers; warn/error = flag highlights.
 * To add a theme: create Theme<Name>.html and add one entry here.
 */
var THEMES = {
  DEFAULT: { label: 'Default (classic blue)', file: '',
    sheet: { font: 'Arial', header: '#1f3b57', headerText: '#ffffff', accent: '#1f3b57', band: '#f3f6f9', soft: '#e8f0fe', warn: '#fff4ce', error: '#fde2e1' } },
  SKY: { label: 'Sky (bright blue, soft and rounded)', file: 'ThemeSky',
    sheet: { font: 'Nunito', header: '#009de0', headerText: '#ffffff', accent: '#009de0', band: '#eef8fd', soft: '#e6f6fd', warn: '#fff6d6', error: '#fde8e6' } },
  EMBER: { label: 'Ember (bold red, high contrast)', file: 'ThemeEmber',
    sheet: { font: 'Inter', header: '#191919', headerText: '#ffffff', accent: '#eb1700', band: '#fff3f1', soft: '#fff0ee', warn: '#fff4d6', error: '#fde2de' } }
};

var OPERATING_HOURS_MODES = {
  STANDARD: 'Standard operating hours',
  '24_7': '24/7 coverage',
  CUSTOM: 'Custom operating hours (may cross midnight)'
};
var DEFAULT_DATE_MODES = {
  KEEP: 'Keep the last selected date',
  TODAY: 'Open on today',
  LATEST_IMPORT: 'Open on the latest imported date'
};

var DEFAULT_DISPLAY = {
  granularity: 'DAILY',
  defaultView: 'DAILY',
  operatingHoursMode: 'STANDARD',
  operatingHoursStart: '06:00',
  operatingHoursEnd: '22:00',
  defaultDate: 'KEEP',
  timeFormat: '',          // '' = inherit global TIME_FORMAT
  showDurations: true,
  showTeamFields: true,
  showHeadcount: true,
  layout: 'STANDARD'       // STANDARD = follow team type fields, CUSTOM = per-team fields
};

/** Per-team import settings (team.settings.import). */
var DEFAULT_TEAM_IMPORT = {
  scheduleType: 'QUINYX_DAILY',
  matchField: 'employeeId',
  nameMatch: '',
  shiftTypeMode: 'NOT_CONFIGURED',
  shiftTypes: [],
  knownShiftTypes: [],
  duplicateStrategy: '',
  // v1.1.1
  importMeetings: false,
  meetingTypes: []
};

/**
 * Registry of schedule views. New views (e.g. WEEKLY) are added here plus a
 * renderer function; the import engine and data model do not change.
 */
var VIEW_REGISTRY = {
  DAILY: { label: 'Daily', sheetPatternKey: 'SCHEDULE_SHEET_PATTERN', renderer: 'renderDailyView_' }
};

/** Fixed cell positions of the generated daily view. */
var VIEW = Object.freeze({
  TITLE_ROW: 1,
  INFO_ROW: 2,
  FILTER_ROW: 3,
  SUMMARY_ROW: 4,
  MESSAGE_ROW: 5,
  HEADER_ROW: 6,
  FIRST_DATA_ROW: 7,
  HEADER_COLS: 9,
  DATE_COL: 2,       // B3
  WEEKDAY_COL: 3,    // C3
  EMPLOYEE_COL: 5,   // E3
  ACTIVITY_COL: 7,   // G3 (filters by Shift Type, or Activity when no shift type)
  STATUS_COL: 9      // I3
});

var STAFF_LAYOUT = Object.freeze({ TITLE_ROW: 1, NAV_ROW: 2, HEADER_ROW: 3, FIRST_DATA_ROW: 4 });

var STATUS_FILTER_OPTIONS = ['(All)', 'OK', 'Has warnings', 'Overnight', 'Overlap',
  'Unknown employee', 'Long shift', 'Hours differ', 'Outside operating hours',
  'From previous day', 'Starts next day', 'Meeting', 'Not a team member'];
var ALL_OPTION = '(All)';
