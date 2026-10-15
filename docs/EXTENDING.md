# Extending Schedule Manager

The ordinary cases (new teams, new team types, new export formats, extra columns) need **no code changes**. The developer-level extensions below each touch a small, isolated part of the code.

## No code changes

### A new team type

*Setup & Configuration → Configure Team Types → + New team type*, or choose *Create a new team type* in step 2 of the team wizard.

- Teams on the **Standard** layout follow the type's schedule columns automatically.
- Staff fields are copied into a team when it is created. Later type edits do not add columns to existing staff sheets; edit the team for that.

### New staff fields for a team

*Manage Existing Teams → Edit → Staff fields*: tick standard fields or add custom ones (comma-separated).

- New columns are appended to the staff sheet.
- Removed fields keep their column and data (never deleted automatically).

### Show more source data in a schedule view

Every unmapped export column is stored in `Extra JSON`.

- List the column names in the team wizard under *Team-specific fields from the export* (step 3). They appear as extra view columns.
- No re-import is needed; existing records already contain them.

### A new Quinyx export format

Import a sample with *Import Quinyx Export*, correct the mapping and tick *Save this mapping as a profile*.

- The profile is matched automatically next time: an exact header signature first, otherwise "all mapped columns present".
- Profiles can be edited under *Configure Import Settings → Mapping profiles*. There you can also:
  - set the date order, break unit, header row and default team;
  - map team values (`Section 4 = TEAM_002`).
- If a header wording is common in your organisation, add it to `AUTO_MAP_SYNONYMS` (JSON in *Import settings*) so the first auto-mapping is already right.

## Small code changes

### A new schedule field (a new internal column)

1. `Schema.gs`:
   - add a column to `T_SCHEDULE.columns`;
   - if it is mappable, add the field to `IMPORT_FIELDS` (and optionally to `DEFAULT_SYNONYMS` in `ImportMappingService.gs`);
   - if it is displayable, add it to `DISPLAY_FIELDS`.
2. `QuinyxParser.normalizeRow_`: read it with `get('<field>')` and set `rec.<field>`.
3. `ImportService.toStoredRecord_`: copy it. Add it to `COMPARE_FIELDS_` if a change should count as an update.
4. `ScheduleService.rowToRecord_` and `displayCell_`: read and format it.
5. Run *Setup / Configure Spreadsheet → Repair*. The new column is appended to `_SCHEDULE_DATA`; existing data stays intact, because columns are located by header.
6. Add a unit test in `Tests.gs` and run `node tests/run-unit-tests.js`.

### An additional schedule view (e.g. weekly)

The data model and import engine already support it: records are per shift and per date.

1. `Schema.gs`: add `WEEKLY: { label: 'Weekly', sheetPatternKey: 'WEEKLY_SHEET_PATTERN', renderer: 'renderWeeklyView_' }` to `VIEW_REGISTRY`, and a `WEEKLY_SHEET_PATTERN` default in `ConfigService.CONFIG_DEFAULTS`.
2. `ScheduleService.gs`:
   - write `renderWeeklyView_(team, opts)`, reusing `queryScheduleRecords_({teamIds, dates})` with seven dates, `buildDayRows_` per day and `headcountByHour_`;
   - register it in the `renderers` map inside `renderTeamView_`.
3. Give it a sheet: extend `buildTeamSheets_` and `resolveTeamSheet_` with a `'weekly'` kind (add `weeklySheetId` to the team settings), and add `'weekly'` to the onEdit index in `rebuildSheetIndex_`.
4. In `TeamService.validateTeamForm_`, replace the "Only the daily schedule view is available" check with "granularity must exist in `VIEW_REGISTRY`".

The views pick up new options from `VIEW_REGISTRY` automatically, because the team wizard lists `views` from the bootstrap.

### Another import source (e.g. a Drive folder, the Quinyx API, email)

Anything that produces a 2-D array of strings can reuse the whole pipeline:

```js
var importId = newId_('IMP');
stageTable_(importId, { meta: { fileName: '…', format: 'API', fileHash: hash64_(JSON.stringify(table)), warnings: [] }, table: table });
var insp = inspectTable_(table, { profileId: 'AUTO', headerRow: 0 }, getConfig_());
// then analyzeStaged_(req) / commitImport_(req) exactly as the dialog does (see itImport_ in Tests.gs)
```

- **Unattended imports:** a time-driven trigger can do this with a saved profile and a fixed strategy (`REPLACE_RANGE` is the safest when there is no shift ID). Wrap it in `withLock_` and only commit when `plan.canCommit` is true.
- **Permissions:** Drive-folder sources need a broader Drive scope (`drive.readonly`); Quinyx API calls need `script.external_request` and credentials stored in `PropertiesService` (never in sheets). Add these scopes only when the source is actually built.

### Archiving old records (for very large data)

Move `ACTIVE`/`REMOVED` records older than N months from `_SCHEDULE_DATA` to an `_SCHEDULE_ARCHIVE` sheet (same columns) in a maintenance action under the lock. Undo should then be limited to imports newer than the archive cut-off.

## A web app interface

All business logic sits in server functions that do not depend on the spreadsheet UI (`createTeam_`, `buildImportPlan_`, `commitImport_`, `undoImport_`, `queryScheduleRecords_`, `upsertStaff_`, …). The `api*` functions already return plain JSON (`{ok, data|error}`). To add a web app:

1. Add `doGet(e)` returning `HtmlService.createTemplateFromFile('WebApp').evaluate()`, and deploy as a web app (execute as *user accessing*, access *domain*).
2. Replace `SpreadsheetApp.getActiveSpreadsheet()` in `Utils.getSs_()` with `SpreadsheetApp.openById(<id stored in script properties>)`, because there is no active spreadsheet in a web-app context.
3. Reuse `Styles.html`, `ClientCore.html`, `ImportDialog.html`/`ImportPreview.html`. Replace `google.script.host.close()` with navigation.
4. Return schedule data as JSON (e.g. `apiGetDay(teamId, date)` built on `buildDayRows_`) instead of rendering into a sheet.
5. Keep authorization in mind: a web app executing as *me* would let every visitor act with the owner's rights. Prefer *user accessing the web app* and spreadsheet sharing as the access control.
