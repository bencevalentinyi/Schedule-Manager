# Schedule Manager: Quinyx schedules in Google Sheets (v2.0.0)

A reusable Google Sheets template, powered by Apps Script, that:

- imports Quinyx schedule exports, primarily the **"Daily Schedule"** export (XLSX/CSV, or pasted into a tab);
- stores every shift and meeting once, in a normalized data table;
- renders a daily schedule view and a staff sheet per team.

Teams, staff fields and shift and meeting types are configured through the **Schedule Manager** menu. Ordinary configuration never requires a code change.

| Document | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Architecture, data model, keys, import pipeline, sheet schema, assumptions, limitations |
| [docs/VERIFICATION.md](docs/VERIFICATION.md) | Test plan, acceptance criteria and how each is verified, manual checklists |
| [docs/EXTENDING.md](docs/EXTENDING.md) | Adding fields, export formats, views, or a web app |
| [docs/CHANGELOG.md](docs/CHANGELOG.md) | What changed in each version and why |

> **Not yet verified against real files.** The Daily Schedule parser follows the layout as described; every row and column is configurable, and unreadable values are flagged rather than guessed (see ARCHITECTURE.md §1).


## Updating an older installation (1.0 or 1.1.0) to 2.0.0

1. **Replace and add the files.** In the Apps Script editor, replace every file in `src/` and add any that are missing, with exactly the listed names (`.gs` via **+ → Script**, `.html` via **+ → HTML**). With clasp: `git pull`, then `clasp push`.
2. **Save,** reload the spreadsheet, and run **`checkInstall`** in the editor. It must report that all script and HTML files are present.
3. **Run the upgrade:** choose *Schedule Manager → Setup & Configuration → Setup / Configure Spreadsheet → **Upgrade***.
   - Until you do, other actions show "upgrade required".
   - The upgrade only *adds* things: the Activity Category, Meetings and Display Order columns.
   - Each team gets explicit settings with **meeting import off**, so imports behave exactly as before.
   - Existing staff fields such as Any desired ID are kept.
   - Running it again changes nothing.

## File manifest

All files in `src/` belong in **one** Apps Script project bound to the spreadsheet. "Depends on" lists the files whose functions a file calls (all files share one global scope).

| File | Responsibility | Depends on |
|---|---|---|
| `appsscript.json` | Manifest: V8, OAuth scopes, Drive advanced service v3 | — |
| `Schema.gs` | Sheet schemas, field catalogs, enums, layout constants; version and compatible versions | — |
| `Utils.gs` | Errors/reports, pure helpers, lock, logging, API wrapper | Schema |
| `SheetStore.gs` | Header-driven table read/write; preserves unknown columns | Utils |
| `ConfigService.gs` | `_CONFIG` defaults and validation, upgrade check | SheetStore |
| `Setup.gs` | Idempotent initialize/repair/upgrade (incl. splitting old shared staff sheets), `setupNow`, connection ping | all services |
| `TeamTypeService.gs` | Team types (internal defaults: new teams use the starter type), operating hours, field normalization | SheetStore, ImportMapping, TeamService |
| `TeamService.gs` | Teams, team dialog validation, meeting settings, create/update/delete | TeamType, Staff, Schedule, Dashboard |
| `StaffFieldService.gs` | Custom staff fields: permanent keys, display order, confirmed delete | TeamService, StaffService |
| `StaffService.gs` | Staff sheets, matching, staff index | TeamService, StaffFieldService, Schedule |
| `ScheduleService.gs` | Views, meeting/conflict classification, working-hours rule, headcount, Schedule Viewer API, meeting shading | TeamService, StaffService, AuditService |
| `DashboardService.gs` | All-teams dashboard | ScheduleService, AuditService |
| `QuinyxParser.gs` | File decoding, CSV/XLSX, Daily Schedule adapter, date/time parsing | ImportMapping |
| `ImportMappingService.gs` | Mapping profiles, auto-mapping | SheetStore, ConfigService |
| `ImportService.gs` | Import planner: meetings, shift-type filter; commit, undo | all of the above |
| `ValidationService.gs` | Structure and data validation (conflicts exclude meetings in shifts) | read services |
| `AuditService.gs` | Import log, journal, history API | SheetStore |
| `Main.gs` | Menu, standard dialog sizes, `onEdit`, `checkInstall` | all |
| `Tests.gs` | Unit and integration tests | all |
| `Styles.html` | Design system: tokens and components for every page | — |
| `ClientCore.html` | Client helpers and components: calls, loading, alerts, badges, empty states, stepper, tabs, confirmation, field errors | — |
| `SetupDialog.html`, `ReportDialog.html`, `HistoryDialog.html`, `SettingsDialog.html`, `TeamManager.html`, `StaffFieldsDialog.html` | Setup, reports and help, import history, display settings, team list, custom fields | their services |
| `TeamDialog.html` | Five-step team dialog (create and edit) | TeamService |
| `StaffSidebar.html` | Staff directory sidebar | StaffService |
| `StaffImportService.gs`, `StaffImportDialog.html` | Import Staff Data: fills staff columns (Employee ID, Email, Role, own columns…) from a file, a sheet tab or another Google Sheet; one column finds each person (Name, Employee ID, Email…). Recognises the Quinyx "Custom report" (Badge no. + Name) | StaffService, StaffFieldService, QuinyxParser, ImportService (staging) |
| `MonitoringLinkService.gs`, `MonitoringLinksDialog.html` | Monitoring links: dashboard URLs filled with the platform IDs (a staff column such as "Any desired ID") of the people who are working. Templates are stored in `_CONFIG` (LINK_TEMPLATES), never in code | Schedule, Staff, StaffFieldService, Config |
| `Navigator.html` | Schedule Viewer sidebar (date navigation, filters, summary) | ScheduleService |
| `WebApp.gs`, `WebShell.html`, `WebLoading.html`, `WebHome.html` | **Web app** (optional): `doGet` shows every tool as a page in a browser tab, with a navigation bar, a Home page and prefetched data (one round trip per page). The tool pages are the same dialog files. See [docs/WEB_APP.md](docs/WEB_APP.md). | all client APIs |
| `WebDataService.gs`, `WebSchedule.html`, `WebDashboard.html`, `WebPerson.html`, `WebStaff.html`, `WebLinksOutput.html` | Web app pages of their own: the day's schedule (teams, timeline, headcount), dashboard, a person's week, staff editing, and the Monitoring Links output. Numbers come from `dayView_` (ScheduleService), like the sheets. | ScheduleService, StaffService, MonitoringLinkService |
| `ImportDialog.html`, `ImportPreview.html` | Import wizard, preview and confirmation | ImportService |
| `ThemeSky.html`, `ThemeEmber.html` | **Optional** themes (a `<style>` block each), chosen in *Configure Display Settings → Theme*. Leave them out and the default look is used. To add a theme: create `Theme<Name>.html` and add one entry to `THEMES` in `Schema.gs`. | Styles (loaded after it by `include`) |

Test files outside the Apps Script project:

| File | Purpose |
|---|---|
| `tests/run-unit-tests.js` | Unit tests plus a static check that no code creates triggers |
| `tests/run-integration-tests.js` + `tests/mock-gas.js` | Integration tests against an in-memory Sheets mock |
| `tests/run-migration-test.js` | Upgrade from 1.0 and from 1.1.0 (each run twice), and from 1.1.1–1.1.3 to 2.0.0 |
| `tests/run-ui-checks.js` | Static checks of every HTML page: handlers, server calls, element IDs, labels, buttons, script syntax |

## Installation (new spreadsheet)

1. **Create the project:** create a spreadsheet, then open *Extensions → Apps Script*. Enable *Show "appsscript.json"* in Project Settings.
2. **Add the code:** create every file in `src/` with the same name. Or use clasp:
   ```
   clasp clone <scriptId> --rootDir src
   clasp push
   ```
3. **Enable Drive (for XLSX):** under *Services (+)*, add **Drive API v3** with identifier `Drive`.
4. **Check the files:** save, run **`checkInstall`**, then reload the spreadsheet.
5. **Initialize:** choose *Schedule Manager → Setup & Configuration → Setup / Configure Spreadsheet → Initialize* and authorize. If the dialog reports that it cannot reach the script, see its message (usually several Google accounts are signed in), or run **`setupNow`** in the editor.
6. **Create teams:** choose *Create New Team*: name, operating hours, staff columns, and the shift types (and optionally meeting types) to import.
7. **Add staff and any custom fields:** use *View Staff Directory* and *Configure Staff Fields*.
8. **Import:** choose *Schedule Import → Import Quinyx Export*: pick the team and the file, check the date, choose the shift types, then review the preview before applying.
9. **View schedules:** choose *Schedule Management → Schedule Viewer* to move between dates, filter and refresh.

## Running the tests

| Test | Command |
|---|---|
| Unit tests | `node tests/run-unit-tests.js` (or `runUnitTests` in the editor) |
| Integration (Sheets mock) | `node tests/run-integration-tests.js` |
| Upgrades 1.0 / 1.1.x → 2.0.0 (mock) | `node tests/run-migration-test.js` |
| UI static checks | `node tests/run-ui-checks.js` |
| UI in a real Google Sheets dialog | manual checklist in docs/VERIFICATION.md §UI |
| Integration in real Google Sheets | `runIntegrationTests` in a **copy**, with `_CONFIG TEST_MODE = TRUE` |

The mock enforces out-of-range errors, loss of leading zeros in non-text cells, and date cells read back as Dates. It is still not Google Sheets, so run the real-Sheets tests in a copy before production use.

## Permissions

| Scope | Why |
|---|---|
| `spreadsheets` | This spreadsheet, and reading the temporary XLSX conversion |
| `script.container.ui` | Menus and dialogs |
| `drive.file` | Only the temporary files this script creates |
| `userinfo.email` | The user column in `_IMPORT_LOG` |
