# Schedule Manager: Quinyx schedules in Google Sheets (v1.1)

A reusable Google Sheets template, powered by Apps Script, that:

- imports Quinyx schedule exports, primarily the **"Daily Schedule"** export (XLSX/CSV, or pasted into a tab);
- stores every shift once, in a normalized data table;
- renders a daily schedule view and a staff directory for each team.

Teams, team types, staff identifier fields, shift-type selections, column layouts and display settings are all configured through the **Schedule Manager** menu. Adding a team never requires a code change.

| Document | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Architecture, data model, keys, import pipeline, full sheet schema, assumptions, limitations |
| [docs/VERIFICATION.md](docs/VERIFICATION.md) | Test plan, the 30 acceptance criteria and how each is verified, manual checklist |
| [docs/EXTENDING.md](docs/EXTENDING.md) | Adding team types, fields, export formats, views, or a web app |
| [docs/CHANGELOG.md](docs/CHANGELOG.md) | What changed in v1.1 and why |

> **Quinyx format note.** No real Quinyx export has been available. The Daily Schedule parser follows the layout as **described** (date in A1, labels in row 2, data from row 3; A = shift type, B = employee name, C = shift information, F = hours). Every row and column position is configurable, and anything the parser cannot read is flagged for review rather than guessed. Import one real, anonymized export and adjust the layout before relying on it (see ARCHITECTURE.md §1).

## Updating an existing installation from v1.0

1. **Replace the files.** In the Apps Script editor, replace the contents of every changed file and add the two new files (see the manifest: files marked *new* or *changed*). Keep the file names exactly as listed.
2. **Save,** then **reload the spreadsheet tab.**
3. **Run the upgrade.** Open *Schedule Manager → Setup & Configuration → Setup / Configure Spreadsheet* and click **Upgrade**.
   - Until you do, other menu actions show "Run … Upgrade".
   - The upgrade only *adds* things: new columns, the `_STAFF_FIELDS` sheet, the Converse/Aircall/Astra identifier fields, the "Quinyx Daily Schedule" profile, and explicit operating hours/import settings for existing teams (their current hours are kept).
   - Running it again changes nothing.
4. **Optional:** adopt the new staff columns for an existing team via *Manage Existing Teams → Edit → Staff*. Unticked columns such as Email are hidden; their values are kept.

## File manifest

All files in `src/` belong in **one** Apps Script project bound to the spreadsheet. Apps Script shares one global scope across files, so "dependencies" below means *which other files' functions this file calls*.

| File | v1.1 | Responsibility | Depends on |
|---|---|---|---|
| `appsscript.json` | | Manifest: V8 runtime, OAuth scopes, Drive advanced service v3 | — |
| `Schema.gs` | changed | Sheet schemas, field catalogs, enums, layout constants (no deployment data) | — |
| `Utils.gs` | changed | Errors/reports, pure value/date/sheet-name helpers, lock, logging, API wrapper | Schema |
| `SheetStore.gs` | | Header-driven read/write of internal tables; preserves unknown columns | Utils |
| `ConfigService.gs` | changed | `_CONFIG` defaults, typed access, validated settings, upgrade check, shift-type discovery list | SheetStore |
| `Setup.gs` | changed | Idempotent initialize/repair/**upgrade (migration)**, system sheet formatting, rebuild missing sheets | all services |
| `TeamTypeService.gs` | changed | `_TEAM_TYPES` CRUD, field normalization, **operating hours** | SheetStore, ImportMapping, TeamService |
| `TeamService.gs` | changed | `_TEAMS` registry, team wizard validation, **per-team import settings**, create/update/delete, rename-tolerant sheet resolution | TeamType, Staff, Schedule, Dashboard |
| `StaffFieldService.gs` | **new** | `_STAFF_FIELDS` registry: configurable identifier/custom fields with permanent keys | TeamService, StaffService |
| `StaffService.gs` | changed | Staff sheet layout (columns linked to field keys), reading, matching (incl. alternative match key), upsert without duplicates, `_STAFF_MASTER` | TeamService, StaffFieldService, ScheduleService |
| `ScheduleService.gs` | changed | Record queries, daily view rendering with **operating-hours window**, overlaps, headcount, filters | TeamService, StaffService, AuditService |
| `DashboardService.gs` | changed | All-teams dashboard | ScheduleService, AuditService |
| `QuinyxParser.gs` | changed | File decoding, CSV/XLSX, **Daily Schedule adapter (A1 date, layout, shift info, hours)**, date/time parsing, row normalization | ImportMapping |
| `ImportMappingService.gs` | changed | Mapping profiles (**Daily Schedule format + layout**), auto-mapping suggestions, mapping validation | SheetStore, ConfigService |
| `ImportService.gs` | changed | Staging, pure import planner (**shift-type filtering**), diff and keys, journaled commit, undo, import API | all of the above |
| `ValidationService.gs` | changed | Structure and data validation reports | read services |
| `AuditService.gs` | | `_IMPORT_LOG`, journal reads, import history API | SheetStore |
| `Main.gs` | changed | `onOpen` menu, `onEdit` trigger, menu handlers, dialog openers | all |
| `Tests.gs` | changed | 74 pure unit tests and 20 integration tests | all |
| `Styles.html`, `ClientCore.html` | | Shared CSS and client helpers | — |
| `SetupDialog.html` | changed | Guided setup, repair and **upgrade** | Setup |
| `TeamDialog.html` | changed | Team wizard: General, Schedule (operating hours), Staff (identifier fields), Import (shift types, match key, duplicates, layout), Confirm | TeamService, StaffFieldService |
| `TeamManager.html` | changed | List, edit, activate, rebuild and delete teams | TeamService |
| `TeamTypeDialog.html` | changed | Team type editor | TeamTypeService |
| `StaffFieldsDialog.html` | **new** | Add/rename/hide identifier and custom fields; choose which teams use them | StaffFieldService |
| `SettingsDialog.html` | changed | Display settings, import settings, mapping-profile editor (incl. Daily Schedule layout) | ConfigService, ImportMapping |
| `ImportDialog.html` + `ImportPreview.html` | changed | Upload → date/layout or column mapping → team & shift types → preview → apply | ImportService |
| `HistoryDialog.html` | | Import history, statistics, undo | AuditService, ImportService |
| `StaffSidebar.html` | changed | Search, add, edit, deactivate staff; add unknown employees | StaffService |
| `Navigator.html` | | Team/date picker | ScheduleService |
| `ReportDialog.html` | changed | Validation reports and help | — |

Also included (not part of the Apps Script project):

| File | Purpose |
|---|---|
| `tests/run-unit-tests.js` | Runs the unit tests with Node.js |
| `tests/run-integration-tests.js` + `tests/mock-gas.js` | Run `runIntegrationTests()` against an in-memory Sheets mock |
| `tests/run-migration-test.js` | Simulates a v1.0 spreadsheet and upgrades it twice |
| `samples/sample-schedule.csv` | **Synthetic** generic-table test file, not a Quinyx format |

## Installation (new spreadsheet)

### Option A: copy and paste (no tools needed)

1. **Create a spreadsheet:** go to [sheets.new](https://sheets.new) and name it.
2. **Open the Apps Script editor:** *Extensions → Apps Script*.
3. **Show the manifest:** *Project Settings* (gear icon) → tick **Show "appsscript.json" manifest file in editor**.
4. **Create the files:**
   - Delete the default `Code.gs`.
   - For each `.gs` file in `src/`, click **+ → Script** and give it the same name *without* the extension (e.g. `Schema`).
   - For each `.html` file, click **+ → HTML** with the same name without the extension (e.g. `Styles`).
   - Names are case-sensitive.
5. **Paste the code:** paste each file's complete contents, and replace `appsscript.json` with `src/appsscript.json`.
6. **Enable the Drive service:** under *Services (+)*, add **Drive API**, version **v3**, identifier **`Drive`**. It is needed for XLSX imports such as the Daily Schedule export; CSV and pasted tabs work without it.
7. **Save** (Ctrl+S) and check that there are no red error markers.
8. **Reload the spreadsheet tab.** The **Schedule Manager** menu appears after a few seconds. If it doesn't, select `onOpen` in the editor, click **Run**, and read the error.
9. **Initialize:** choose *Schedule Manager → Setup & Configuration → Setup / Configure Spreadsheet*, accept the authorization prompt (for a private script, choose *Advanced → Go to …*), and click **Initialize system**.
10. **Create the first team:** click **Create first team** and go through the wizard (*General → Schedule → Staff → Import → Confirm*). On the *Import* step:
    - choose the shift types the team should import;
    - or use *Discover shift types from an export file*.
11. **Add staff** in *Schedule Management → View Staff Directory*.
12. **Import a Daily Schedule export:**
    1. Open *Schedule Import → Import Quinyx Export* and upload the file.
    2. Confirm the schedule date read from A1, and compare the layout with the row preview. Adjust the rows/columns if needed and tick *Save this layout*.
    3. Confirm the shift-type selection, then click **Analyze**, review the preview, and click **Apply import**.
13. **Verify:** open the team's *Daily* sheet and check shifts, flags and headcount. See [docs/VERIFICATION.md](docs/VERIFICATION.md).

### Option B: clasp

```bash
npm i -g @google/clasp && clasp login
clasp create --type sheets --title "Schedule Manager" --rootDir src   # or: clasp clone <scriptId> --rootDir src
clasp push
```

Continue from step 7. Turn on the Apps Script API first at https://script.google.com/home/usersettings.

### Permissions (`appsscript.json`)

| Scope | Why |
|---|---|
| `spreadsheets` | Read and write this spreadsheet. Also needed to *read* the temporary converted copy of an XLSX upload. |
| `script.container.ui` | Menus, dialogs, sidebar |
| `drive.file` | Create and delete **only the files this script creates** (the temporary XLSX conversion). Gives no access to other Drive files. |
| `userinfo.email` | Records the executing user in `_IMPORT_LOG` where Google provides it |

## Running the tests

| Test | How to run | Result at hand-off |
|---|---|---|
| Unit tests | `node tests/run-unit-tests.js`, or `runUnitTests` in the editor | **74/74 passed** |
| Integration tests (mock) | `node tests/run-integration-tests.js` (Sheets mock) | **20/20 passed** |
| Upgrade test (mock) | `node tests/run-migration-test.js` | **all 14 checks passed** |
| Integration tests (real Sheets) | Run `runIntegrationTests` in a **copy** of the spreadsheet: a blank one, or set `_CONFIG` → `TEST_MODE` = `TRUE` | **not yet run** |

The mock is strict about out-of-range writes, leading zeros and date cells, but it is not Google Sheets. Run the real-Sheets integration tests once before production use.

## Using it day to day

| Task | Where |
|---|---|
| Today's schedule | *Schedule Management → Open Today's Schedule*, or edit B3 on a daily sheet |
| Filter a view | Row 3 of a daily sheet: employee, shift type, status |
| Add or fix staff | *View Staff Directory* (sidebar). *Add unknown employees…* lists people found in imported shifts |
| Rename an identifier column (e.g. Converse ID → CRM ID) | *Setup & Configuration → Configure Staff Fields* |
| Change which shift types a team imports | *Manage Existing Teams → Edit → Import*, or tick *Save this selection* in the import wizard |
| Undo an import | *Schedule Import → Undo Last Import* (repeatable, newest first) |
| Something broken or missing | *Maintenance → Rebuild Missing Sheets*, *Repair Formatting*, *Validate Data* |
