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
check('untouched starter type gets the current default staff columns', run('listTeamTypes_(true)[0].staffFields.join(",")') === run('DEFAULT_STAFF_FIELDS.join(",")'));
check('Daily Schedule profile created', run('!!getProfile_(QUINYX_DAILY_PROFILE_ID)'));

// 5) Second run must not change anything structural.
const actions2 = run('initializeSystem_().actions');
const structural = actions2.filter((a) => !/^Refreshed the/.test(a));
check('second upgrade run changes nothing', structural.length === 0, structural.join(' | '));
check('no duplicate columns', (() => { const h = header(ss.getSheetByName('_SCHEDULE_DATA')).filter(Boolean); return h.length === new Set(h).size; })());
check('no staff fields created automatically', run('listStaffFields_().length') === 0);

/* ------------------------------------------------------------------------ */
/* Scenario B: v1.1.0 -> v1.1.1                                              */
/* ------------------------------------------------------------------------ */
console.log('v1.1.0 -> ' + run('APP.VERSION'));
const g2 = makeGlobals('Europe/Stockholm');
const ss2 = g2.spreadsheet;
const ctx2 = vm.createContext(g2.globals);
fs.readdirSync(SRC).filter((f) => f.endsWith('.gs')).sort().forEach((f) => vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), ctx2, { filename: f }));
const run2 = (code) => vm.runInContext(code, ctx2);
run2(`
  initializeSystem_();
  // v1.1.0 seeded three identifier fields; recreate them as user data.
  ['Converse ID', 'Aircall ID', 'AstraID'].forEach(function (n) { saveStaffField_({ displayName: n, fieldType: 'IDENTIFIER' }); });
  var type = listTeamTypes_(false)[0];
  var team = createTeam_({ teamName: 'Support', typeMode: 'EXISTING', teamTypeId: type.typeId,
    staffFields: LEGACY_DEFAULT_STAFF_FIELDS_V110.slice() }).team;
  var v = {}; v['Employee ID'] = 'E1'; v['Employee Name'] = 'Ann Lee'; v['Converse ID'] = '000777'; upsertStaff_(team, v, '');
  itImport_({ teams: {}, imports: [] }, 'Employee ID,Employee Name,Date,Start,End\\nE1,Ann Lee,2026-10-15,08:00,16:00', team.teamId, 'UPDATE');
`);
const before2 = run2('JSON.stringify(readAllScheduleRecords_().records.map(function (r) { return [r.recordKey, r.shiftStart]; }))');
// Rewind to the v1.1.0 layout.
const header2 = (sheet) => sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
const drop2 = (name, labels) => {
  const sh = ss2.getSheetByName(name);
  header2(sh).forEach((h, i) => { if (labels.indexOf(h) >= 0) for (let r = 1; r <= sh.getLastRow(); r++) sh.put(r, i + 1, { v: '' }); });
};
drop2('_SCHEDULE_DATA', ['Activity Category']);
drop2('_IMPORT_LOG', ['Meetings Imported', 'Meetings Excluded']);
drop2('_STAFF_FIELDS', ['Display Order']);
ss2.deleteSheet(ss2.getSheetByName('_TEAM_MEMBERSHIP'));
ss2.deleteSheet(ss2.getSheetByName('_SLACK_PAYLOADS'));
run2(`
  setConfigValues_({ SYSTEM_VERSION: '1.1.0' });
  var t = readTable_(T_TEAMS).rows[0];
  var s = JSON.parse(JSON.stringify(t.settings));
  delete s.import.importMeetings; delete s.import.meetingTypes; delete s.import.useStaffDirectoryRouting;
  t.settings = s; updateObject_(T_TEAMS, t);
  var ty = readTable_(T_TEAM_TYPES).rows[0];
  ty.staffFields = LEGACY_DEFAULT_STAFF_FIELDS_V110; updateObject_(T_TEAM_TYPES, ty);
  resetConfigMemo_();
`);
let code2 = '';
try { run2('requireInitialized_()'); } catch (e) { code2 = e.code; }
check('v1.1.0 spreadsheet asks for the upgrade', code2 === 'NEEDS_UPGRADE', code2);
const acts = run2('initializeSystem_().actions');
console.log('    upgrade actions:\n      - ' + acts.join('\n      - '));
check('new sheets _TEAM_MEMBERSHIP and _SLACK_PAYLOADS created', !!ss2.getSheetByName('_TEAM_MEMBERSHIP') && !!ss2.getSheetByName('_SLACK_PAYLOADS'));
check('new columns added', header2(ss2.getSheetByName('_SCHEDULE_DATA')).indexOf('Activity Category') >= 0 && header2(ss2.getSheetByName('_STAFF_FIELDS')).indexOf('Display Order') >= 0);
check('schedule records unchanged', before2 === run2('JSON.stringify(readAllScheduleRecords_().records.map(function (r) { return [r.recordKey, r.shiftStart]; }))'));
check('existing team keeps its identifier columns and values', run2('var t = listTeams_()[0]; var st = readStaff_(t); st.rows[0].values["Converse ID"]') === '000777');
const fieldNames = run2('listStaffFields_().map(function (f) { return f.displayName; }).join(",")');
check('existing identifier fields kept as user data, in their original order', fieldNames === 'Converse ID,Aircall ID,AstraID', fieldNames);
check('team gets explicit meeting/routing settings (off)', run2('var i = listTeams_()[0].settings.import; i.importMeetings === false && i.useStaffDirectoryRouting === false'));
check('untouched starter type now defaults to the 5 columns', run2('listTeamTypes_(true)[0].staffFields.join(",")') === 'employeeId,employeeName,active,role,notes');
const reimport = run2(`itImport_({ teams: {}, imports: [] }, 'Employee ID,Employee Name,Date,Start,End\\nE1,Ann Lee,2026-10-15,08:00,16:00', listTeams_()[0].teamId, 'UPDATE')`);
check('re-importing v1.1.0 data after the upgrade changes nothing', reimport.inserted === 0 && reimport.updated === 0 && reimport.unchanged === 1, JSON.stringify(reimport));
const acts2 = run2('initializeSystem_().actions').filter((a) => !/^Refreshed the/.test(a));
check('second upgrade run changes nothing', acts2.length === 0, acts2.join(' | '));
check('no duplicate columns or sheets', (() => {
  const h = header2(ss2.getSheetByName('_SCHEDULE_DATA')).filter(Boolean);
  return h.length === new Set(h).size && ss2.getSheets().filter((s) => s.getName() === '_TEAM_MEMBERSHIP').length === 1;
})());

/* ------------------------------------------------------------------------ */
/* Scenario C: v1.1.1 / v1.1.2 -> current (UI release + one new config key; no data migration) */
/* ------------------------------------------------------------------------ */
['1.1.1', '1.1.2'].forEach((fromVersion) => {
  console.log('v' + fromVersion + ' -> ' + run('APP.VERSION'));
  const g3 = makeGlobals('Europe/Stockholm');
  const ctx3 = vm.createContext(g3.globals);
  fs.readdirSync(SRC).filter((f) => f.endsWith('.gs')).sort().forEach((f) => vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), ctx3, { filename: f }));
  const run3 = (code) => vm.runInContext(code, ctx3);
  run3(`
    initializeSystem_();
    var type = listTeamTypes_(false)[0];
    var team = createTeam_({ teamName: 'Current Team', typeMode: 'EXISTING', teamTypeId: type.typeId }).team;
    itImport_({ teams: {}, imports: [] }, 'Employee ID,Employee Name,Date,Start,End\\nE1,Ann Lee,2026-10-15,08:00,16:00', team.teamId, 'UPDATE');
    var key = readTable_(T_CONFIG).rows.filter(function (r) { return r.key === 'SLACK_MESSAGE_CONFIG'; })[0];
    deleteSheetRows_(requireSheet_(T_CONFIG.sheet), [key._row]); // that key did not exist before 1.1.3
    setConfigValues_({ SYSTEM_VERSION: '${fromVersion}' });
    resetConfigMemo_();
  `);
  const snapshot3 = () => run3(`JSON.stringify({
    teams: readTable_(T_TEAMS).rows.map(function (t) { return [t.teamId, t.settings]; }),
    types: readTable_(T_TEAM_TYPES).rows.map(function (t) { return [t.typeId, t.staffFields, t.display]; }),
    records: readAllScheduleRecords_().records.map(function (r) { return [r.recordKey, r.shiftStart, r.shiftEnd]; }),
    cfg: readTable_(T_CONFIG).rows.filter(function (r) { return r.key !== 'SYSTEM_VERSION' && r.key !== 'SLACK_MESSAGE_CONFIG'; }).map(function (r) { return [r.key, r.value]; }),
    sheets: getSs_().getSheets().map(function (s) { return s.getName(); })
  })`);
  const before3 = snapshot3();
  let code3 = 'OK';
  try { run3('requireInitialized_()'); } catch (e) { code3 = e.code; }
  check(fromVersion + ' spreadsheet keeps working without an upgrade', code3 === 'OK', code3);
  check('setup dialog does not ask for an upgrade', run3('getSetupState_().needsUpgrade') === false);
  check('workflow message works before Setup (starter columns from the default)', run3('loadWorkflowConfig_().columns.length') === 5);
  const acts3 = run3('initializeSystem_().actions').filter((a) => !/^Refreshed the/.test(a));
  console.log('    setup actions:\n      - ' + acts3.join('\n      - '));
  check('setup only adds the new key and records the version', acts3.length === 2 && /^Added 1 missing configuration key/.test(acts3[0]) &&
    /^Recorded version 1\.1\.3 \(from /.test(acts3[1]), acts3.join(' | '));
  check('version recorded', run3('getConfig_().SYSTEM_VERSION') === '1.1.3');
  check('new key added with an empty value', run3('getConfig_().SLACK_MESSAGE_CONFIG') === '{}');
  check('teams, types, records, other configuration and sheets unchanged', snapshot3() === before3);
  const acts3b = run3('initializeSystem_().actions').filter((a) => !/^Refreshed the/.test(a));
  check('second setup run changes nothing', acts3b.length === 0, acts3b.join(' | '));
});

console.log(failed ? failed + ' migration check(s) FAILED' : 'Migration test: all checks passed');
process.exit(failed ? 1 : 0);
