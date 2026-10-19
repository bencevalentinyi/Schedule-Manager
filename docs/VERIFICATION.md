# Verification and Test Plan

## Simplification (unreleased)

Slack, the team type dialog and the import settings dialog were removed; the team and import dialogs were simplified (see CHANGELOG). The Slack tests were removed with the code. The remaining automated tests were **not re-run** after this change: run them before release (see README → Running the tests).

**Manual checklist (real spreadsheet):**

1. The menu has no *Slack Workflow Automation*, *Configure Team Types*, *Configure Import Settings* or *Preview Import*. `checkInstall` reports every file present.
2. *Create New Team*: five steps (General, Schedule, Staff sheet, Shift types, Review). The team is created with the starter type and its daily and staff sheets.
3. *Manage Existing Teams → Edit* a team that had settings no longer shown (e.g. aliases, a duplicate strategy, custom schedule columns). Change only the name and save: every other setting in `_TEAMS` is unchanged.
4. *Import Quinyx Export* with a Daily Schedule file: choose the team and file, check the date, choose shift types, review, apply. With a wrong layout, "The rows or columns look wrong?" opens by itself; after Apply, "Remember this layout" saves it to the profile.
5. Import a table CSV: map the columns, tick "Remember these columns", apply. The next import of the same format maps them automatically. A file whose only dates are like 03/04/2026 is blocked until "Dates like 03/04/2026 mean" is set.
6. *Configure Display Settings* shows display settings only and saves them.
7. After *Setup / Configure Spreadsheet* (and after *Repair Formatting*) every `_` sheet is hidden; the Dashboard and team sheets stay visible.
8. Nothing about breaks remains: no Break items in the import column mapping, no break or Net Hours columns in the daily view, no Breaks switch in the team dialog. Durations equal the shift length.
9. A new team's staff sheet has Employee ID, Employee Name, Role and Notes, with no Active column. In an older staff sheet, the Active column is hidden after *Repair Formatting* and its values are kept.
10. Team dialog → Staff sheet → "Add your own column" (e.g. "Phone"): after saving, the column is visible in the team's staff sheet and is an editable field in *View Staff Directory*.
11. In a copy where two teams share one staff sheet, run *Setup / Configure Spreadsheet → Repair*: the second team gets its own staff sheet (a copy, IDs with leading zeros intact), and a second run changes nothing. The staff sidebar has no membership box, and the import preview has no routing table.
12. Import with *All teams*: put each person in one team's staff sheet with exactly the Quinyx name. Every row lands in that person's team, filtered by that team's shift types; the review step lists each team's shift types.
13. Add someone to two staff sheets and leave someone out entirely: both appear under *Held back for review* and *Apply import* is disabled. Choose a team for one and Skip for the other, click *Re-check*: the import can be applied and contains exactly those decisions.
14. One-team import: a person missing from that team's staff sheet is held back too; "Import to <team> anyway" imports them flagged *Unknown employee*.
15. *Configure Display Settings → Theme* = Sky, Save: every daily sheet, staff sheet and the Dashboard switch to blue headers, Nunito font and matching tabs; reopened dialogs show the Sky look and logo. Repeat with Ember (black headers, red titles, Inter) and Default.

The sections below record how earlier versions were verified. Criteria about Slack payloads and messages, team types, shared staff sheets and team membership, routing modes and import aliases refer to features that were removed.

## v1.1.2 acceptance criteria (UI overhaul)

Results at hand-off, all executed under Node.js 20:

| Code | Suite | Command | Result |
|---|---|---|---|
| **UI** | Static UI checks | `node tests/run-ui-checks.js` | **1068 checks passed** in 15 HTML files |
| **U** | Unit tests | `node tests/run-unit-tests.js` | **91/91 passed**, plus the no-trigger check |
| **I** | Integration tests (Sheets mock) | `node tests/run-integration-tests.js` | **23/23 passed** |
| **M** | Upgrade tests | `node tests/run-migration-test.js` | **31/31 checks passed**, including 1.1.1 → 1.1.2 |
| **S** | Manual check in real Google Sheets | checklist below | **not yet done** |

The UI checker was itself tested: a scratch copy with an undefined handler, an unknown server function, a missing element ID, an unlabelled input, a button without a type, and a script syntax error. It reported each one. (Its first version missed `$('…')` references; this was fixed before the results above.)

| # | Criterion | How it is verified |
|---|---|---|
| 1 | All user-facing interfaces reviewed | All 15 HTML files were rewritten on the shared design system. The native menu was reorganized (its styling cannot change). The daily sheet got meeting shading and a legend. — S |
| 2 | Consistent design system | Every page includes `Styles` and `ClientCore` (UI). Page-specific CSS covers layout only, plus one highlight color in the import file preview. No page defines its own button styles. — S (visual) |
| 3 | Consistent buttons and controls | Every static button has `type="button"` and an accessible name (UI). Variants come from `Styles.html`. — S |
| 4 | Labels and validation | Every `<label for>` target exists, and every static input, select and textarea has a label (UI). Inline `fieldError` is used in the team wizard, import, settings, staff and Slack pages. The server still validates authoritatively. — S |
| 5 | Loading, success, error, empty states | The `call()` overlay blocks duplicate clicks. Alerts are used for success and errors (with a next step for known error codes). Empty states cover no teams, no staff, no schedule on the date, no history, no shift types, no profiles, no fields and nothing to generate. — S |
| 6–8 | Viewer readable; meetings distinct; 24/7 intact | The viewer API with filters, the filter cells, the meeting-shading rule and refusal of an unknown team are tested (I). No operating-hours or overnight logic was changed; the existing 24/7 and overnight tests still pass (U, I). — S |
| 9 | Custom fields and shared directories | No staff, field or membership backend change; the v1.1.1 tests pass (U, I, M). The shared-directory explanation is shown in the wizard and the sidebar. — S |
| 10–11 | Import workflow and accurate previews | No import planning or commit change except two additive bootstrap fields. Previews and the confirmation summary are built only from the plan returned by the server (U, I). — S |
| 12–13 | Payloads and URL previews | No generation or URL logic change. The URL preview still calls `buildDashboardUrl_`; the highlight only marks text (U, I). — S |
| 14 | Different window sizes | Responsive grid, `.split` collapses below 620 px, tables scroll inside their containers. — S |
| 15 | Keyboard focus and labels | Visible focus ring; tabs with arrow keys; stepper steps and list items are buttons or focusable; labels as in 4. — S |
| 16 | Data and configuration intact | Scenario C: teams, types, records, configuration and sheets identical after setup (M). |
| 17 | No disconnected controls | Every inline handler calls a defined function, every server call exists, every referenced element ID exists, and every menu item and dialog page exists (UI). |
| 18 | Maintainable and compatible | No framework, no external resources; HtmlService templates as before. Script syntax checked (UI). |

### Manual checklist for v1.1.2 (real spreadsheet; do this before production use)

**Setup and teams**

1. Open every menu item once. Each dialog should open at its standard size with a visible header and footer, no horizontal page scroll, and the primary button bottom right.
2. Setup: shows the connection result, the sheet table and the right button (Initialize / Upgrade / Repair). On a 1.1.1 spreadsheet it does not ask for an upgrade, and Repair records 1.1.2.
3. Create Team: walk through all six steps.
   - Leaving the team name empty shows an inline error.
   - 24/7 hides the time fields.
   - Sharing a directory shows the membership explanation.
   - Meeting import on, with no type ticked, blocks the step.
   - The review matches what you chose, and the team is created.
4. Edit Team: open the dialog, click the "Meetings" step directly, change a setting, click "Review changes", then save. Other settings are unchanged.

**Viewer, staff and fields**

5. Schedule Viewer (sidebar):
   - ◀ / ▶ / Today change the sheet date.
   - Employee search with a partial name filters to one person, or explains the ambiguity.
   - Shift-type and status filters work, and Clear filters resets them.
   - The summary matches row 4 of the sheet.
   - On a 24/7 team, a night shift from the previous day appears.
   - After Maintenance → Repair Formatting, meeting rows are shaded and their Flags cell reads "Meeting (…)".
6. Staff Directory (sidebar): search, add (required-field check), edit, mark inactive, membership on a shared directory, and Unknown….
7. Configure Staff Fields:
   - Add, rename (values kept), hide, change order, and choose the teams that use the field.
   - Delete without clearing values: the column stays.
   - Delete with clearing values requires typing the name.

**Import**

8. Import a Daily Schedule export end to end:
   - File facts are shown, and an unreadable date gives an inline error.
   - Apply layout reports the row count.
   - Shift types show Included / Excluded / New, and meeting types are listed separately.
   - The preview groups match the file.
   - The confirmation summary lists the right teams, dates, types and duplicate handling.
   - The results page opens the team.
9. Import History: search, filter by status, and undo via the confirmation panel.

**Settings and accessibility**

10. Keyboard only: Tab through the team dialog and the import wizard. Focus is always visible, and every control can be reached and operated.
11. Browser zoom at 80 % and 150 %: dialogs remain usable, with internal scrolling and the footer always visible.

## v1.1.1 acceptance criteria (the 32 test scenarios of the patch)

Results at hand-off, all executed under Node.js 20:

- **U** = unit tests (`node tests/run-unit-tests.js`): **89/89 passed**, plus the static check that no file creates triggers.
- **I** = integration tests against the Sheets mock (`node tests/run-integration-tests.js`): **22/22 passed**.
- **M** = upgrade tests (`node tests/run-migration-test.js`): **25/25 checks passed**, covering 1.0 → 1.1.1 and 1.1.0 → 1.1.1, each run twice.
- **S** = must still be checked in real Google Sheets: run `runIntegrationTests` in a copy, and the checklist below.

Nothing has been tested against a real Quinyx export or a real Slack Workflow.

| # | Scenario | Verified by |
|---|---|---|
| 1 | One normal shift | U (meeting fixture: Bob; v1.1 plan tests) |
| 2 | Several meetings on one date | U ("Meetings #1–5": four meetings for Ann, distinct keys) |
| 3 | Meeting before the shift | U (07:30–08:00: not a conflict, counted outside the shift) |
| 4 | Meeting during the shift | U (10:00 and 15:00: *in shift*, no conflict) |
| 5 | Meeting after the shift | U (16:00–16:30) |
| 6 | Meeting import on/off | U (off: 4 excluded and reported, shifts unchanged) |
| 7 | Repeated import: no duplicate meetings | U (second run: 0 actions, 6 unchanged) |
| 8 | No double-counting | U (working minutes = 480 + 30 + 30) |
| 9 | Default staff columns | U, I (exactly Employee ID, Name, Active, Role, Notes) |
| 10 | No identifier fields by default | U (`SEED_STAFF_FIELDS_` empty), M (none created on upgrade) |
| 11 | Add a custom identifier field | I |
| 12 | Rename keeps values | I (`000123` kept through rename; also kept after delete-without-confirmation) |
| 13 | One sheet shared by several teams | I |
| 14 | Shared records stay authoritative | I (one record per employee; same directory sheet ID) |
| 15 | Membership explicit | U (checker), I (owner backfilled, joining team has no implicit members) |
| 16 | Ambiguous routing flagged | U (ambiguous / unknown / no membership; override and skip), I (blocks until decided) |
| 17 | Payloads for one team | U |
| 18 | Payloads for several teams | U, I |
| 19 | Selected date or range | U (date filter), I (single date) |
| 20 | Separate records for shifts and meetings | U |
| 21 | `@Name` display | U, I (`@Shared One`) |
| 22 | URL from the template | U, I |
| 23 | Selectable identifier field | U (`field:crm` → `CRM-001`, leading zeros `007`) |
| 24 | Custom delimiters preserved | U (`https://google.com/user="xy"%2"yx"` exactly, flagged as unusual) |
| 25 | Encoding applied correctly | U (`A B/7` → `A%20B%2F7`; the template is not encoded) |
| 26 | Missing-identifier policies | U (blank + warning / skip / block) |
| 27 | Preview = final URL | U (same builder; equality asserted) |
| 28 | Selectable number of blocks | U |
| 29 | Grouping never drops records | U (refuses when records don't fit; record count verified) |
| 30 | Replace keeps unrelated payloads | I (other team's rows kept, no duplication) |
| 31 | Append creates a new Generation ID | U, I (two generations; identical content flagged) |
| 32 | No duplicate triggers | Static check: no source file calls `ScriptApp.newTrigger`; the upgrade never creates triggers |

### Manual checklist for v1.1.1 (real spreadsheet)

**Upgrade**

- [ ] Run `checkInstall`; it should report every file present.
- [ ] Run Setup → **Upgrade**. It lists the added columns and sheets and "meeting import off, staff-directory routing off" for each team. A second run lists nothing new.
- [ ] Existing views, staff columns and identifiers look exactly as before.

**Meetings (with a real Daily Schedule export containing meetings)**

- [ ] Discover the types and tick the meeting types for a team. With *Import meetings* **off**, the preview shows *Meetings excluded = n*. With it **on**, it shows *Meetings selected = n*.
- [ ] The daily view shows meetings flagged *Meeting (in shift)* or *(outside shift)*; only real clashes are flagged *Overlap*.
- [ ] *Working hours* in row 4 does not grow when a meeting lies inside a shift.
- [ ] Importing the same file again creates 0 new rows.

**Staff and shared directories**

- [ ] A new team's staff sheet has exactly five columns.
- [ ] Add "Converse ID" in *Configure Staff Fields*, enter `000123`, rename the field; the value is kept.
- [ ] Create team B sharing team A's staff sheet. The sheet title lists both teams. A's employees are still A's members; B has none.
- [ ] In *View Staff Directory* for team B, mark one employee as a member of both teams.
- [ ] Enable routing for A and B and import with *Route by staff directory membership*. The routing table shows that employee as **AMBIGUOUS**; Apply is blocked until a team is chosen.

## v1.1 acceptance criteria

How each requirement of the v1.1 update is verified.

- **U** = unit test
- **I** = integration test against the Sheets mock
- **M** = upgrade test
- **S** = needs a real spreadsheet: `runIntegrationTests` in a copy, plus the manual checklist in §0.1

Nothing has been verified against a real Quinyx export yet.

| # | Criterion | Verified by | Notes |
|---|---|---|---|
| 1 | Standard operating hours | U (windows), I (#1–3) | |
| 2 | 24/7 coverage | U (24 headcount slots, midnight shifts), I (#1–3: I2 shows "24/7") | |
| 3 | Custom operating hours | U (18:00–06:00 window, next-day starts), I | |
| 4 | Existing teams retain settings | M (07:00–19:00 kept as STANDARD; staff fields kept) | |
| 5 | Editing preserves unchanged settings | I (#5: only the description changes) | |
| 6 | Staff sheet has the 8 default columns | U, I (#6–10) | |
| 7 | No Email column by default | U, I | Existing v1.0 teams keep theirs (M) |
| 8 | Add identifier fields | I (#6–10 via registry), S (dialog) | |
| 9 | Renaming keeps values | U (key-note resolution), I (rename and back, value kept) | |
| 10 | Leading zeros and alphanumerics kept | U (`007`, `AB-12`), I (`000123` through rename), M (`00042`) | The mock converts numeric strings in non-text cells, like Sheets does |
| 11 | Duplicate Employee IDs detected | U, I (duplicate identifier refused) | |
| 12 | Unknown employees flagged | U, I | |
| 13 | Date from A1 | U, I | Unverified format |
| 14 | Configured header/data rows | U (header row 0, data row 2; warning when row 2 looks like data) | |
| 15 | Discover shift types | U, I | |
| 16 | Select multiple shift types | U (selection list), S (dialog checkboxes) | |
| 17 | Only selected types imported | U, I (only "Customer Support" stored) | |
| 18 | Excluded types reported | U, I (`excluded = 1`) | |
| 19 | Unknown shift types warn | U | |
| 20 | Name matching per strategy | U (unique exact name = NAME match; ambiguous names never merged) | |
| 21 | Shift info parsed with the verified format | U (described formats) | **Real format not verified** |
| 22 | Overnight shifts | U, I | |
| 23 | Hours (column F) imported and validated | U (parse, missing, invalid, differ) | |
| 24 | Invalid rows reported before import | U (missing name, unparseable info, row numbers) | |
| 25 | Repeated imports create no duplicates | U, I (`unchanged = 2`) | |
| 26 | Outside-scope schedules unchanged | U (Replace keeps other types and dates) | |
| 27 | Failed import writes nothing | I (blocked and stale-token imports write no rows) | |
| 28 | Upgrade preserves team configuration | M, I | |
| 29 | Upgrade can run repeatedly | M (second run: no structural changes, no duplicate columns or fields) | |
| 30 | Missing sheets regenerate without losing records | I (#18) | |

### 0.1 Manual checklist for v1.1 (real spreadsheet)

**Upgrade**

- [ ] On a v1.0 spreadsheet, every menu action except Setup and Help says an upgrade is required.
- [ ] Setup shows **Upgrade**. Running it lists the added columns, `_STAFF_FIELDS`, identifier fields, the Daily Schedule profile, and per-team upgrades. Running it again lists nothing new.
- [ ] Existing daily views look the same as before, including the same hours.

**Operating hours**

- [ ] **Standard:** create a team with 06:00–22:00. Entering 22:00–06:00 is refused with a hint to use Custom.
- [ ] **24/7:** I2 shows "24/7" and the headcount has 24 rows. A 23:00–07:00 shift appears on both days (*Overnight* / *From previous day*).
- [ ] **Custom 18:00–06:00:** a 02:00 shift dated the next day appears as *Starts next day*, and the headcount runs from 18:00 to 06:00.
- [ ] Edit only the team's description. The hours and shift-type selection are unchanged.

**Staff**

- [ ] A new team's staff sheet has exactly: Employee ID, Employee Name, Converse ID, Aircall ID, AstraID, Active, Role, Notes.
- [ ] Type `000123` into Converse ID; it stays `000123`.
- [ ] In *Configure Staff Fields*, rename Converse ID to "CRM ID". The header changes in every team and the values stay.
- [ ] Hide the field: the column is hidden, not deleted. Un-hide it and the values are back.
- [ ] Adding a staff member with an existing Converse ID is refused.

**Daily Schedule import**

Use a real, anonymized export.

- [ ] The date is read from A1. Compare the *First rows of the file* preview with the highlighted title row, header row and first data row, and check the column letters.
- [ ] Adjust the layout if needed, click *Apply layout*, tick *Save this layout*, and verify that the next import picks it up.
- [ ] Shift types are listed with row counts. For a team with no selection, the preview blocks until a selection is made. Selecting two types imports only those; the others are counted as *Excluded by shift type*.
- [ ] A shift type not seen before is marked *new* and produces a warning.
- [ ] Shift-information cells parse correctly. Any that are rejected are listed with their row numbers. **Report the exact cell text if a valid shift is rejected.**
- [ ] Column F hours are shown under *Scheduled Hours*. Differences show *Hours differ*.
- [ ] Import the same file again: 0 new shifts.
- [ ] Import with *Replace* after removing one row: only that shift (same team, same date, selected types) is marked REMOVED. Undo restores it.

## 1. What has and has not been verified (v1.0 baseline)

| Area | Status |
|---|---|
| Parsing, date/time normalization, mapping, keys, import planning (diff, strategies, replace scope, routing, staff matching, overlaps, token), day-view model | **Automated, executed:** 46/46 unit tests pass under Node.js 20 (`node tests/run-unit-tests.js`). The same tests run in Apps Script via `runUnitTests`. |
| All `.gs` files and all HTML client scripts parse. Every client → server call targets an existing public function. Every menu item and template exists. | **Checked statically** at hand-off |
| Sheet creation, rendering, commit/undo | Executed against the in-memory Sheets mock (v1.1). **Not yet executed in real Google Sheets.** Run `runIntegrationTests` in a copy before production use. |
| Formatting, locking, Drive conversion, dialogs | **Not executed** (no Google environment available). Covered by the manual checklist below. |

## 2. Test matrix (required scenarios)

| # | Scenario | Automated test | Real Sheets environment needed |
|---|---|---|---|
| 1 | Initialize a new spreadsheet | integration #1 | yes |
| 2 | Run initialization again (idempotent) | integration #2 | yes |
| 3 | Create the first team | integration #3 | yes |
| 4 | Several teams of the same type | integration #4 | yes |
| 5 | Teams of different types | integration #5 | yes |
| 6 | Duplicate team names | integration #6 | yes |
| 7 | Invalid worksheet names | unit "Sheet names", integration #7 | partly |
| 8 | Import a valid schedule | unit "Plan: valid import", integration #8 | partly |
| 9 | Different column ordering | unit "different column order", integration #9 | no |
| 10 | Missing required columns | unit "missing required column", integration #10 | no |
| 11 | Unknown employee | unit "unknown and inactive", integration #8 | no |
| 12 | Multiple shifts per day | unit "multiple shifts", integration #8 | no |
| 13 | Overnight shifts | unit "overnight" ×2, integration #8 | no |
| 14 | Duplicate records | unit "re-import unchanged", "conflicting copies", integration #9 | no |
| 15 | Update an existing schedule | unit "SKIP, UPDATE and ASK", integration #15 | no |
| 16 | Replace within a date range | unit "REPLACE_RANGE", integration #16 | no |
| 17 | Records outside the range unchanged | unit "REPLACE_RANGE" (asserts 14th/16th survive), integration #16/17 | no |
| 18 | Recover from missing team worksheets | integration #18 | yes |
| 19 | Malformed dates and times | unit "Dates", "Times", "rejected rows", "ambiguous" | no |
| 20 | Failed import leaves no partial data | unit "rejected rows block", "REPLACE blocked"; integration #10/19/20 and stale-token | partly |

## 3. Manual acceptance checklist

Work in a **copy** of the template. Use `samples/sample-schedule.csv` (synthetic), and then a real Quinyx export.

### Setup

- [ ] After reloading, the **Schedule Manager** menu shows four submenus.
- [ ] **Setup / Configure Spreadsheet → Initialize system** creates 9 `_` sheets plus *Dashboard*, a "Standard Team" type and a "Generic (auto-detect columns)" profile.
- [ ] Running Setup again reports "nothing changed" (apart from refreshing the dashboard). Sheet count and `_CONFIG` row count are unchanged.
- [ ] Delete the `Description` column header in `_TEAM_TYPES`. Setup then shows *missing columns*, and *Repair* restores the column without touching data.
- [ ] Any menu item other than Setup and Help, used in an uninitialized spreadsheet, shows "has not been initialized".

### Teams

- [ ] Create **Customer Support**. `Customer Support - Daily` and `Customer Support - Staff` appear. `_TEAMS` shows `TEAM_001`, status `READY`.
- [ ] Creating `customer support` again fails with "already exists".
- [ ] A team named `Ops: [EU]/Night?` gets sheets without `[ ] * ? / \ :`.
- [ ] Rename `Customer Support - Daily` by hand. *Validate Spreadsheet Structure* reports no error, and `_TEAMS` shows the new name (self-healing via sheet ID).
- [ ] Delete `Back Office - Daily`. *Validate Spreadsheet Structure* reports it as missing. *Rebuild Missing Sheets* recreates it, and the team is `READY`.
- [ ] *Manage Existing Teams → Edit*: rename the team. Generated sheet names follow; manually renamed sheets keep their names.

### Staff

- [ ] In *View Staff Directory*, add 1001 Ann Lee, 1002 Bob Ray, 1003 Cy Moe to Customer Support and 2001 Dee Fox to Back Office.
- [ ] Adding 1001 again is refused ("already exists").
- [ ] Marking Cy Moe *Inactive* greys the row.
- [ ] Editing a cell in the staff sheet stamps *Last Updated*.
- [ ] Typing a duplicate ID directly in the sheet highlights both cells red. *Validate Data* reports it.

### Import: happy path (`sample-schedule.csv`)

- [ ] Mapping is suggested for Team, Employee ID, Employee Name, Date, Start, End, Activity. *Cost Center* is listed as unmapped (preserved).
- [ ] *Team values found* shows `Customer Support` → Customer Support and `Back Office` → Back Office.
- [ ] With routing *Auto* (= split by team column) and strategy *Update*, **Analyze** shows: 6 source rows, 6 valid, 6 new, 1 unknown employee (1099), 1 inactive warning (Cy Moe), 1 overnight, 2 teams.
- [ ] **Apply import** succeeds. `_SCHEDULE_DATA` has 6 rows. `_IMPORT_LOG` has a `COMMITTED` row. `_IMPORT_CHANGES` has 6 `INSERT` rows.
- [ ] *Customer Support - Daily* on 2026-10-15 shows Ann, Bob ×2, Cy (22:00 to `06:00`, flag *Overnight*). Net hours and headcount are filled in.
- [ ] On 2026-10-16, the view shows Cy as *From previous day* and 1099 as *Unknown employee*.
- [ ] *View Staff Directory → Add unknown employees…* offers 1099. After adding it, the flag disappears on refresh.

### Import: duplicates, updates, replace

- [ ] Re-import the same file: a warning says it was already imported. The preview shows 0 new and 6 potential duplicates (unchanged).
- [ ] Change Ann's name to "Ann Lee-Smith" and import with **Ask**: *Pending decision* is 1 and *Apply* is disabled. Switch to **Update**: 1 updated.
- [ ] Remove Bob's 14:00 row and import with **Replace**: 1 removed (`Record Status` = `REMOVED`, not deleted). Shifts on 2026-10-16 are untouched.
- [ ] *Undo Last Import* restores Bob's shift. Repeating Undo reverts the previous imports one by one.

### Import: failure cases

- [ ] A file without an end column: *Must fix: No column is mapped to "Shift End"*. Nothing is written.
- [ ] A file whose only dates are like `03/04/2026`: "The date format is ambiguous". Choosing DMY lets it pass.
- [ ] A row with `25:00` or `2026-02-30` appears under *Rejected rows*, and Apply is blocked until *Import the valid rows…* is ticked.
- [ ] With *Replace*, a rejected row of that team blocks the import with "Replace is blocked…".
- [ ] Upload a `.pdf`: "Unsupported file type".
- [ ] Upload a `.xlsx` with the Drive service disabled: a clear "Drive advanced service" message. With it enabled, the import works and no `[Schedule Manager temp]` file remains in Drive.
- [ ] Start an import in two browser tabs and apply both quickly. The second gets "Another Schedule Manager operation is running" or `PLAN_CHANGED`, never duplicated data.

### Views and maintenance

- [ ] Changing B3, E3, G3 or I3 re-renders the view within a few seconds. Typing in the data area shows the protection warning.
- [ ] *Open Today's Schedule* on a team sheet jumps to today. Elsewhere it asks for the team (or goes directly if only one team exists).
- [ ] *Configure Display Settings*: changing the Theme re-colors (and re-fonts) every daily sheet, staff sheet and the Dashboard. Setting `SCHEDULE_SHEET_PATTERN` to `Daily` (without `{team}`) is refused.
- [ ] *Repair Formatting* keeps the selected date and filters.
- [ ] *Validate Data* reports overlaps, unknown future employees and interrupted imports, and rebuilds `_STAFF_MASTER`.
- [ ] Simulate an interrupted import: set a `COMMITTED` row's status to `COMMITTING`. *Validate Data* shows it as fatal, and *Undo Last Import* rolls it back.

## 4. Expected failure behavior (summary)

| Situation | Behavior |
|---|---|
| Not initialized | Every action except Setup and Help explains how to initialize |
| Sheet missing or renamed | Self-heals by sheet ID. Otherwise: "Required sheet … is missing → Rebuild Missing Sheets" |
| Missing/unknown columns in internal sheets | Error names the columns; Setup → Repair restores them |
| Ambiguous dates, missing mapping, unknown team | Import stops at preview with a "Must fix" list. Nothing is written. |
| Concurrent modification | Document lock (30–60 s wait), then a "BUSY" message. The plan token guards against stale previews. |
| Unexpected exception | Short user message plus a structured log entry (no row data) in *Executions* |
