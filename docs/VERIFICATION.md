# Verification and Test Plan

## 0. v1.1 acceptance criteria

How each requirement of the v1.1 update is verified.

- **U** = unit test (`node tests/run-unit-tests.js`, 74/74 passing)
- **I** = integration test against the Sheets mock (`node tests/run-integration-tests.js`, 20/20 passing)
- **M** = upgrade test (`node tests/run-migration-test.js`, 14/14 passing)
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
- [ ] Column F hours are shown under *Scheduled Hours*. Differences show *Hours differ* (for example, unpaid breaks).
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
| 13 | Overnight shifts | unit "overnight" ×3, "break across midnight", integration #8 | no |
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

- [ ] Create **Customer Support** (Standard Team, alias `CS`). `Customer Support - Daily` and `Customer Support - Staff` appear. `_TEAMS` shows `TEAM_001`, status `READY`.
- [ ] Create **Back Office** with a *new* team type and custom columns. Its view shows only those columns.
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

- [ ] Mapping is suggested for Team, Employee ID, Employee Name, Date, Start, End, Break, Activity. *Cost Center* is listed as unmapped (preserved).
- [ ] *Team values found* shows `Customer Support` → Customer Support and `Back Office` → Back Office.
- [ ] With routing *Auto* (= split by team column) and strategy *Update*, **Analyze** shows: 6 source rows, 6 valid, 6 new, 1 unknown employee (1099), 1 inactive warning (Cy Moe), 1 overnight, 2 teams.
- [ ] **Apply import** succeeds. `_SCHEDULE_DATA` has 6 rows. `_IMPORT_LOG` has a `COMMITTED` row. `_IMPORT_CHANGES` has 6 `INSERT` rows.
- [ ] *Customer Support - Daily* on 2026-10-15 shows Ann, Bob ×2, Cy (22:00 to `06:00 (+1)`, flag *Overnight*). Net hours and headcount are filled in.
- [ ] On 2026-10-16, the view shows Cy as *From previous day* and 1099 as *Unknown employee*.
- [ ] *View Staff Directory → Add unknown employees…* offers 1099. After adding it, the flag disappears on refresh.

### Import: duplicates, updates, replace

- [ ] Re-import the same file: a warning says it was already imported. The preview shows 0 new and 6 potential duplicates (unchanged).
- [ ] Change Ann's break to 45 and import with **Ask**: *Pending decision* is 1 and *Apply* is disabled. Switch to **Update**: 1 updated.
- [ ] Remove Bob's 14:00 row and import with **Replace**: 1 removed (`Record Status` = `REMOVED`, not deleted). Shifts on 2026-10-16 are untouched.
- [ ] *Undo Last Import* restores Bob's shift. Repeating Undo reverts the previous imports one by one.

### Import: failure cases

- [ ] A file without an end column: *Must fix: No column is mapped to "Shift End"*. Nothing is written.
- [ ] A file whose only dates are like `03/04/2026`: "The date format is ambiguous". Choosing DMY lets it pass.
- [ ] A row with `25:00` or `2026-02-30` appears under *Rejected rows*, and Apply is blocked until *Import the valid rows…* is ticked.
- [ ] With *Replace*, a rejected row of that team blocks the import with "Replace is blocked…".
- [ ] A team value not matching any team or alias is rejected with guidance to add an alias.
- [ ] Upload a `.pdf`: "Unsupported file type".
- [ ] Upload a `.xlsx` with the Drive service disabled: a clear "Drive advanced service" message. With it enabled, the import works and no `[Schedule Manager temp]` file remains in Drive.
- [ ] Start an import in two browser tabs and apply both quickly. The second gets "Another Schedule Manager operation is running" or `PLAN_CHANGED`, never duplicated data.
- [ ] *Preview Import* never shows an Apply button and never writes to `_IMPORT_LOG`.

### Views and maintenance

- [ ] Changing B3, E3, G3 or I3 re-renders the view within a few seconds. Typing in the data area shows the protection warning.
- [ ] *Open Today's Schedule* on a team sheet jumps to today. Elsewhere it asks for the team (or goes directly if only one team exists).
- [ ] *Configure Display Settings*: changing `HEADER_COLOR` re-colors all generated sheets. Setting `SCHEDULE_SHEET_PATTERN` to `Daily` (without `{team}`) is refused.
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
