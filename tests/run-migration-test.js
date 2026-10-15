/**
 * Upgrade test (v1.0 -> v1.1) against the in-memory Sheets mock.
 * Builds a spreadsheet, rewinds it to the v1.0 layout (no _STAFF_FIELDS, no new
 * columns, v1.0 team/type settings, version 1.0.0), then runs the upgrade twice
 * and checks that data is preserved and the second run changes nothing.
 *
 * Usage:  node tests/run-migration-test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { makeGlobals } = require('./mock-gas');

const SRC = path.join(__dirname, '..', 'src');
const { globals, spreadsheet: ss } = makeGlobals('Europe/Stockholm');
const ctx = vm.createContext(globals);
fs.readdirSync(SRC).filter((f) => f.endsWith('.gs')).sort().forEach((f) => vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), ctx, { filename: f }));
const run = (code) => vm.runInContext(code, ctx);
let failed = 0;
const check = (name, cond, detail) => { console.log((cond ? '  PASS ' : '  FAIL ') + name + (cond ? '' : ' — ' + (detail || ''))); if (!cond) failed++; };

// 1) Build a populated spreadsheet with the current code.
run(`
  initializeSystem_();
  var type = listTeamTypes_(false)[0];
  var team = createTeam_({ teamName: 'Legacy Team', typeMode: 'EXISTING', teamTypeId: type.typeId }).team;
  var v = {}; v['Employee ID'] = '00042'; v['Employee Name'] = 'Ann Lee'; upsertStaff_(team, v, '');
  itImport_({ teams: {}, imports: [] }, 'Employee ID,Employee Name,Date,Start,End\\n00042,Ann Lee,2026-10-15,08:00,16:00\\nE9,Bob Ray,2026-10-15,22:00,06:00', team.teamId, 'UPDATE');
`);
const before = run('JSON.stringify(readAllScheduleRecords_().records.map(function (r) { return [r.recordKey, r.employeeId, r.shiftStart, r.shiftEnd]; }))');
const logRowsBefore = run('readImportLog_().length');

// 2) Rewind to the v1.0 layout.
const header = (sheet) => { const n = sheet.getLastColumn(); return sheet.getRange(1, 1, 1, n).getValues()[0]; };
const dropColumns = (name, labels) => {
  const sh = ss.getSheetByName(name);
  header(sh).forEach((h, i) => {
    if (labels.indexOf(h) < 0) return;
    for (let r = 1; r <= sh.getLastRow(); r++) sh.put(r, i + 1, { v: '' });
  });
};
dropColumns('_SCHEDULE_DATA', ['Shift Type', 'Source Shift Info', 'Source Hours', 'Scheduled Minutes']);
dropColumns('_IMPORT_LOG', ['Rows Excluded (Shift Type)', 'Shift Types Imported']);
ss.deleteSheet(ss.getSheetByName('_STAFF_FIELDS'));
run(`
  setConfigValues_({ SYSTEM_VERSION: '1.0.0' });
  var p = getProfile_(QUINYX_DAILY_PROFILE_ID); deleteSheetRows_(requireSheet_(T_MAPPINGS.sheet), [p._row]);
  var t = readTable_(T_TEAMS).rows[0];
  t.settings = { display: { workdayStart: '07:00', workdayEnd: '19:00', showBreaks: true, showDurations: true, showTeamFields: true, showHeadcount: true, layout: 'STANDARD' },
    scheduleFields: t.settings.scheduleFields, staffFields: ['employeeId', 'employeeName', 'email', 'team', 'role', 'active', 'skills', 'notes', 'lastUpdated'],
    extraFields: [], scheduleSheetId: t.settings.scheduleSheetId, staffSheetId: t.settings.staffSheetId, lastError: '' };
  updateObject_(T_TEAMS, t);
  var ty = readTable_(T_TEAM_TYPES).rows[0];
  ty.staffFields = LEGACY_DEFAULT_STAFF_FIELDS_V1; ty.display = { workdayStart: '06:00', workdayEnd: '22:00' };
  updateObject_(T_TEAM_TYPES, ty);
  resetConfigMemo_();
`);

// 3) Old spreadsheet + new code: actions must ask for the upgrade, not fail obscurely.
let code = '';
try { run('requireInitialized_()'); } catch (e) { code = e.code; }
check('outdated spreadsheet asks for the upgrade', code === 'NEEDS_UPGRADE', code);

// 4) Upgrade.
const actions1 = run('initializeSystem_().actions');
console.log('    upgrade actions:\n      - ' + actions1.join('\n      - '));
check('upgrade succeeds and records the new version', run('getConfig_().SYSTEM_VERSION') === run('APP.VERSION'));
check('new system sheet created', !!ss.getSheetByName('_STAFF_FIELDS'));
check('new columns restored', ['Shift Type', 'Scheduled Minutes'].every((h) => header(ss.getSheetByName('_SCHEDULE_DATA')).indexOf(h) >= 0));
const after = run('JSON.stringify(readAllScheduleRecords_().records.map(function (r) { return [r.recordKey, r.employeeId, r.shiftStart, r.shiftEnd]; }))');
check('schedule records unchanged', before === after, before + ' vs ' + after);
check('import history kept', run('readImportLog_().length') === logRowsBefore);
check('team keeps its 07:00–19:00 hours as STANDARD', run('var d = listTeams_()[0].settings.display; d.operatingHoursMode + " " + d.operatingHoursStart + "-" + d.operatingHoursEnd') === 'STANDARD 07:00-19:00');
check('team keeps its staff fields (Email not removed)', run('listTeams_()[0].settings.staffFields.indexOf("email") >= 0'));
check('existing staff ID with leading zeros intact', run('readStaff_(listTeams_()[0]).rows[0].employeeId') === '00042');
check('untouched starter type gets the new 8 default staff columns', run('listTeamTypes_(true)[0].staffFields.join(",")') === run('DEFAULT_STAFF_FIELDS.join(",")'));
check('Daily Schedule profile created', run('!!getProfile_(QUINYX_DAILY_PROFILE_ID)'));

// 5) Second run must not change anything structural.
const actions2 = run('initializeSystem_().actions');
const structural = actions2.filter((a) => !/^Refreshed the/.test(a));
check('second upgrade run changes nothing', structural.length === 0, structural.join(' | '));
check('no duplicate columns', (() => { const h = header(ss.getSheetByName('_SCHEDULE_DATA')).filter(Boolean); return h.length === new Set(h).size; })());
check('no duplicate staff fields', run('listStaffFields_().length') === 3);

console.log(failed ? failed + ' migration check(s) FAILED' : 'Migration test: all checks passed');
process.exit(failed ? 1 : 0);
