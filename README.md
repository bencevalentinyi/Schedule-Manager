# Schedule Manager: Quinyx schedules in Google Sheets (v1.1.3)

A reusable Google Sheets template, powered by Apps Script, that:

- imports Quinyx schedule exports, primarily the **"Daily Schedule"** export (XLSX/CSV, or pasted into a tab);
- stores every shift and meeting once, in a normalized data table;
- renders a daily schedule view and a staff directory per team (dedicated or shared between teams);
- generates Slack Workflow payloads with configurable dashboard URLs.

Teams, team types, staff fields, team membership, shift and meeting types, layouts, and payload/URL settings are configured through the **Schedule Manager** menu. Ordinary configuration never requires a code change.

| Document | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Architecture, data model, keys, import pipeline, sheet schema, assumptions, limitations |
| [docs/VERIFICATION.md](docs/VERIFICATION.md) | Test plan, acceptance criteria and how each is verified, manual checklists |
| [docs/EXTENDING.md](docs/EXTENDING.md) | Adding team types, fields, export formats, views, or a web app |
| [docs/CHANGELOG.md](docs/CHANGELOG.md) | What changed in each version and why |

> **Not yet verified against real files.** The Daily Schedule parser follows the layout as described; every row and column is configurable, and unreadable values are flagged rather than guessed. The Slack payload records are normalized rows, because the Slack Workflow input schema has not been confirmed (see ARCHITECTURE.md §1 and §9).

## Updating from 1.1.1 or 1.1.2 to 1.1.3

1.1.2 redesigned every dialog and sidebar. 1.1.3 adds the Slack Workflow message (one combined row). Neither changes team, staff or schedule data.

1. **Replace and add the files.** Add the new script file **`SlackMessageService`** (+ → Script). Replace `Schema`, `ConfigService`, `Setup`, `Main`, `Tests` and `SlackDialog`. Coming from 1.1.1, also replace every file marked *changed* in the manifest. With clasp: `git pull`, then `clasp push`.
2. **Check the files:** save, run **`checkInstall`**, then reload the spreadsheet.
3. **No upgrade is required.** A 1.1.1 or 1.1.2 spreadsheet keeps working. Running *Setup / Configure Spreadsheet → Repair* once adds the new `SLACK_MESSAGE_CONFIG` key and records version 1.1.3. Nothing else changes.
4. **Optional:** run *Maintenance → Repair Formatting* so existing daily sheets shade meeting rows.

## Updating an older installation (1.0 or 1.1.0 → 1.1.3)

1. **Replace and add the files.** In the Apps Script editor, replace every file in `src/` and add any that are missing, with exactly the listed names (`.gs` via **+ → Script**, `.html` via **+ → HTML**). Files new since 1.1.0: `MembershipService.gs`, `SlackPayloadService.gs`, `SlackMessageService.gs`, `SlackDialog.html`. With clasp: `git pull`, then `clasp push`.
2. **Save,** reload the spreadsheet, and run **`checkInstall`** in the editor. It must report that all script and HTML files are present.
3. **Run the upgrade:** choose *Schedule Manager → Setup & Configuration → Setup / Configure Spreadsheet → **Upgrade***.
   - Until you do, other actions show "upgrade required".
   - The upgrade only *adds* things: the Activity Category, Meetings and Display Order columns, the `_TEAM_MEMBERSHIP` and `_SLACK_PAYLOADS` sheets, and the Slack configuration keys.
   - Each team gets explicit settings with **meeting import off** and **directory routing off**, so imports behave exactly as before.
   - Existing staff fields such as Converse ID are kept. Only an untouched starter team type switches to the new five-column default.
   - Running it again changes nothing.
4. **Optional:** turn on meetings, a shared directory or directory routing per team via *Manage Existing Teams → Edit*.

## File manifest

All files in `src/` belong in **one** Apps Script project bound to the spreadsheet. "Depends on" lists the files whose functions a file calls (all files share one global scope). The *1.1.2* column marks the files changed in 1.1.2; 1.1.3 changes `Schema`, `ConfigService`, `Setup`, `Main`, `Tests` and `SlackDialog`, and adds `SlackMessageService`.

| File | 1.1.2 | Responsibility | Depends on |
|---|---|---|---|
| `appsscript.json` | | Manifest: V8, OAuth scopes, Drive advanced service v3 | — |
| `Schema.gs` | changed | Sheet schemas, field catalogs, enums, layout constants; version and compatible versions | — |
| `Utils.gs` | | Errors/reports, pure helpers, lock, logging, API wrapper | Schema |
| `SheetStore.gs` | | Header-driven table read/write; preserves unknown columns | Utils |
| `ConfigService.gs` | changed | `_CONFIG` defaults and validation, upgrade check, Slack config keys | SheetStore |
| `Setup.gs` | changed | Idempotent initialize/repair/upgrade, `setupNow`, connection ping | all services |
| `TeamTypeService.gs` | | Team types, operating hours, field normalization | SheetStore, ImportMapping, TeamService |
| `TeamService.gs` | | Teams, wizard validation, meeting settings, shared directories, create/update/delete | TeamType, Staff, Membership, Schedule, Dashboard |
| `StaffFieldService.gs` | | Custom staff fields: permanent keys, display order, confirmed delete | TeamService, StaffService |
| `MembershipService.gs` | | Shared directories, explicit `_TEAM_MEMBERSHIP`, backfill, sidebar membership API | TeamService, StaffService |
| `StaffService.gs` | | Staff sheets (union of fields for shared sheets), matching, membership-aware index | TeamService, StaffFieldService, Membership, Schedule |
| `ScheduleService.gs` | changed | Views, meeting/conflict classification, working-hours rule, headcount, **Schedule Viewer API, meeting shading** | TeamService, StaffService, AuditService |
| `DashboardService.gs` | | All-teams dashboard | ScheduleService, AuditService |
| `QuinyxParser.gs` | | File decoding, CSV/XLSX, Daily Schedule adapter, date/time parsing | ImportMapping |
| `ImportMappingService.gs` | | Mapping profiles, auto-mapping | SheetStore, ConfigService |
| `ImportService.gs` | changed | Import planner: meetings, directory routing with manual decisions, routing table; commit, undo | all of the above |
| `SlackPayloadService.gs` | changed | Payload generation (retrieve → blocks → serialize), dashboard URL generator, validation, **open payload sheet** | Schedule, Staff, Membership, Config |
| `SlackMessageService.gs` | **new in 1.1.3** | Slack Workflow message: one row with configurable columns (lists, links, dates, text); `generateSlackWorkflowMessage` for a daily trigger you add | Schedule, Staff, Membership, SlackPayload, Config |
| `ValidationService.gs` | changed | Structure and data validation (conflicts exclude meetings in shifts) | read services |
| `AuditService.gs` | | Import log, journal, history API | SheetStore |
| `Main.gs` | changed | Menu, **standard dialog sizes**, `onEdit`, `checkInstall` | all |
| `Tests.gs` | changed | 96 unit tests and 24 integration tests | all |
| `Styles.html` | changed | **Design system:** tokens and components for every page | — |
| `ClientCore.html` | changed | **Client helpers and components:** calls, loading, alerts, badges, empty states, stepper, tabs, confirmation, field errors | — |
| `SetupDialog.html`, `ReportDialog.html`, `HistoryDialog.html`, `TeamTypeDialog.html`, `SettingsDialog.html`, `TeamManager.html`, `StaffFieldsDialog.html` | changed | Setup, reports and help, import history, team types, settings, team list, custom fields | their services |
| `TeamDialog.html` | changed | Six-step team wizard (create and edit) | TeamService |
| `StaffSidebar.html` | changed | Staff directory sidebar incl. team membership | StaffService, Membership |
| `Navigator.html` | changed | **Schedule Viewer** sidebar (date navigation, filters, summary) | ScheduleService |
| `ImportDialog.html`, `ImportPreview.html` | changed | Import wizard, preview and confirmation | ImportService |
| `SlackDialog.html` | changed | Workflow message, Generate payloads, Payload configuration, Dashboard URL | SlackMessageService, SlackPayloadService |

Unchanged in 1.1.2: `appsscript.json` and the `.gs` files with an empty *1.1.2* cell. Every HTML file changed.

Test files outside the Apps Script project:

| File | Purpose |
|---|---|
| `tests/run-unit-tests.js` | Unit tests plus a static check that no code creates triggers |
| `tests/run-integration-tests.js` + `tests/mock-gas.js` | Integration tests against an in-memory Sheets mock |
| `tests/run-migration-test.js` | Upgrade from v1.0 and from v1.1.0 (each run twice), and 1.1.1 / 1.1.2 → 1.1.3 without migration |
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
6. **Create teams:** choose *Create New Team*. On the **Staff directory** step, pick a dedicated sheet or share an existing one. On the **Quinyx import** step choose the shift types, and on the **Meetings** step optionally turn on meeting import with the meeting types.
7. **Add staff and any custom fields:** use *View Staff Directory* and *Configure Staff Fields*.
8. **Import:** choose *Schedule Import → Import Quinyx Export*, then check the preview counts, the routing table and the confirmation summary before applying.
9. **View schedules:** choose *Schedule Management → Schedule Viewer* to move between dates, filter and refresh.
10. **Set up the Slack message:** choose *Slack Workflow Automation → Workflow Message*, set up the columns, preview, then click **Save and write row**. To run it daily, add a time-driven trigger for `generateSlackWorkflowMessage` (Apps Script → Triggers). Optionally, set up per-assignment payload records:
   1. *Slack Workflow Automation → Configure Dashboard URL*: enter the template, test it with the preview, and save.
   2. *Configure Payload Generation*: choose teams, dates, blocks and mode.
   3. *Generate Payloads*: preview, then generate.

## Running the tests

| Test | Command | Result at hand-off |
|---|---|---|
| Unit tests | `node tests/run-unit-tests.js` (or `runUnitTests` in the editor) | **96/96 passed**, no-trigger check passed |
| Integration (Sheets mock) | `node tests/run-integration-tests.js` | **24/24 passed** |
| Upgrade 1.0 → 1.1.3 and 1.1.0 → 1.1.3; 1.1.1 / 1.1.2 → 1.1.3 without migration (mock) | `node tests/run-migration-test.js` | **41/41 checks passed** |
| UI static checks | `node tests/run-ui-checks.js` | **1118 checks passed** (15 HTML files) |
| UI in a real Google Sheets dialog | manual checklist in docs/VERIFICATION.md §UI | **not yet done** |
| Integration in real Google Sheets | `runIntegrationTests` in a **copy**, with `_CONFIG TEST_MODE = TRUE` | **not yet run** |

The mock enforces out-of-range errors, loss of leading zeros in non-text cells, and date cells read back as Dates. It is still not Google Sheets, so run the real-Sheets tests in a copy before production use.

## Permissions

| Scope | Why |
|---|---|
| `spreadsheets` | This spreadsheet, and reading the temporary XLSX conversion |
| `script.container.ui` | Menus and dialogs |
| `drive.file` | Only the temporary files this script creates |
| `userinfo.email` | The user column in `_IMPORT_LOG` |

The Slack module adds **no** permissions: it writes rows to sheets and does not call Slack. A daily trigger you add yourself runs under your account.
