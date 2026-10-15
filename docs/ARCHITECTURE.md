# Architecture and Spreadsheet Schema

This covers Phase 1 (architecture) and Phase 2 (spreadsheet schema).

## 1. Missing information and assumptions

**No real Quinyx export was available while this was built.** Its column names, order, date format, encoding, and whether it includes a shift ID or a team column are all unknown. The import engine is therefore built so that **no column name is assumed**:

| Unknown | How the system handles it |
|---|---|
| Column names and order | Columns are located by header text, never by position. The admin confirms the mapping in the wizard and saves it as a **mapping profile**. Built-in "synonyms" (e.g. `Start Time` → Shift Start) are only *suggestions* and are not presented as verified Quinyx names. |
| Title rows above the header | The header row is auto-detected (the row with the most recognizable headers among the first 25) and can be overridden. |
| Date format (DMY vs MDY) | The whole batch is checked once. If one value settles it (e.g. `13/10/2026`), that order is used. If nothing settles it (`03/04/2026`), the import **stops** and asks the admin to choose. ISO, month names and spreadsheet serials are also supported. |
| Separate date and time columns vs combined date-time | Both are supported. Start and end values can be times or full date-times. |
| Overnight shifts | An end time earlier than the start time (with no explicit end date) means the shift ends the next day. If an explicit end date is earlier than the start, the row is rejected. |
| Shift ID available? | If one is mapped, it becomes the duplicate key. If not, a documented composite key is used (§4). |
| Team column available? | Rows are routed by team name, Team ID, or the team's **import aliases**. Without a team column, the admin selects the team. |
| Encoding | BOM detection, UTF-8, then a Windows-1252 fallback (with a warning). The encoding can also be chosen manually. |
| Time zones | Times are stored as **wall-clock** values as exported. Time-zone suffixes (`Z`, `+02:00`) are ignored, with a warning. |

### The Quinyx "Daily Schedule" export (v1.1): what is implemented vs. verified

The layout was **described, not shown**. The parser implements the description as a configurable default (profile *Quinyx Daily Schedule*, format `QUINYX_DAILY`):

| Described | Implemented default | Configurable | Verified against a real file? |
|---|---|---|---|
| A1 contains "Daily schedule *date*" | Title row 1, column A. Exactly one date must be found. | Title row/column; date order; manual date in the wizard | No |
| Row 2 contains column labels (and possibly data — unclear) | Row 2 = labels, first data row = 3. A warning appears if row 2 contains a time range in the shift column. | Header row (0 = none), first data row | No — **this is the main open question** |
| A = SHIFT TYPE, B = employee name, C = shift information, F = hours | Exactly these columns | Every column letter, plus an optional employee ID column | No |
| C contains shift times in an unknown format | Accepted: `08:00 - 16:00`, `08:00-16:00`, en dash, `to`, AM/PM, `08.00`, seconds, full date-time ranges, date + time ranges. Anything else, or several ranges in one cell, is **rejected for review**. | — | No |
| F = hours worked that day | Hours as `8`, `7.5`, `7,5`, `7:30`, `7h 30m` (plain numbers are hours unless the profile says minutes). Compared with the shift; never overwrites it. | Unit, tolerance (`HOURS_TOLERANCE_MINUTES`) | No |
| (not described) Shift type written once per group | Rows without employee and shift information are skipped. Optional *fill-down* copies the shift type from the row above. | Fill-down on/off | No |

Other assumptions:

- **Shift dates.** Times in column C belong to the schedule date from A1. An end time earlier than the start means the shift ends the next day. If the export lists a shift that *started the previous day* only by its times, it would be dated on the A1 date; this has to be checked against a real overnight example.
- **Other columns** (D, E, G, …) are preserved in Extra JSON and can be shown as team-specific columns.

**What to collect to finalize a deployment:** one real export per export setting your teams use (with personal data scrubbed if necessary). Import it once, correct the mapping or layout, tick *Save this mapping/layout*, and the format is pinned. Check in particular:

- whether a stable shift ID column exists (if so, map it);
- how breaks are expressed (minutes, `h:mm`, or start/end);
- whether the team/section column values match your team names (if not, add them as aliases).

## 2. System architecture

```
 Quinyx export (CSV / XLSX / pasted tab)
        │  ImportDialog.html (upload, FileReader → base64)
        ▼
 QuinyxParser.gs ──► string table ──► _IMPORT_STAGING (chunked JSON, per Import ID)
        │
        ▼
 ImportMappingService.gs  (header detection, profile match, auto-map suggestions)
        │  admin confirms mapping / team routing / duplicate strategy
        ▼
 ImportService.buildImportPlan_  (pure: normalize → validate → route → match staff
        │                         → key → diff vs _SCHEDULE_DATA → overlaps → token)
        ▼  preview shown; admin confirms
 ImportService.commitImport_  (document lock, recompute plan, token check,
        │                      log COMMITTING → journal → single data write → COMMITTED)
        ▼
 _SCHEDULE_DATA  (source of truth)  ──► ScheduleService renders "<Team> - Daily"
        ▲                            ──► DashboardService renders "Dashboard"
 _IMPORT_CHANGES (undo journal)  _IMPORT_LOG (history)
```

Configuration lives in tables (`_CONFIG`, `_TEAMS`, `_TEAM_TYPES`, `_IMPORT_MAPPINGS`). Code contains only the *structure* of the system (field catalogs, sheet schemas), never deployment data such as team names.

### Key design decisions and trade-offs

| Decision | Why | Trade-off |
|---|---|---|
| A central `_SCHEDULE_DATA` table with team sheets as rendered views | Records exist once. Views can be rebuilt at any time. Multiple shifts per day, history, undo, and future weekly views all work on the same data. | Team views are read-only presentations. Edits made directly in a view are overwritten on refresh (the view is protected with a warning). |
| Views rendered by Apps Script, not `QUERY`/`FILTER` formulas | Flags, overnight carry-over, overlaps and headcount need logic. Formulas over a growing data sheet recalculate on every edit. | The view refreshes on date/filter edits (`onEdit`), after imports, and on *Refresh*. It does not update live while `_SCHEDULE_DATA` is edited by hand. |
| A pure planning function (`buildImportPlan_`) | The same code produces the preview and the commit. It is unit-tested without Google services (46 tests). | The analysis reads all of `_SCHEDULE_DATA` for each preview. This is fine up to tens of thousands of rows (see §7). |
| Wall-clock date-time strings stored as plain text | Avoids script/spreadsheet time-zone conversion bugs. Values look exactly like the export. | Durations across a DST change are off by the DST delta. |
| Soft delete (`REMOVED`) instead of deleting rows | Preserves history. Undo can restore records. | `_SCHEDULE_DATA` only grows. Archiving is a documented future extension. |
| Team sheets found by **sheet ID**, falling back to name | Renaming a tab by hand does not break the system. The registry heals itself. | None significant. |
| One JSON field map per profile row in `_IMPORT_MAPPINGS` | One profile per row is easy to list, match and edit. The UI edits it safely. | Editing the JSON directly in the sheet is possible but error-prone. Use *Configure Import Settings → Mapping profiles*. |

## 3. Data model

### Entities and keys

| Entity | Primary key | Notes |
|---|---|---|
| Team | `Team ID` (`TEAM_001`, …) from a never-reused sequence (`_CONFIG.TEAM_ID_SEQ`) | The name is unique (case/space-insensitive) but changeable. |
| Team type | `Team Type ID` (slug of the name, e.g. `CUSTOMER_SUPPORT`) | Provides defaults. Teams on the *Standard* layout follow their type's columns. |
| Mapping profile | `Profile ID` (`MAP_…`) | Pins the headers of one export format. |
| Employee | `Employee ID` within a team's staff sheet (case-insensitive, trimmed, optionally without leading zeros) | Names are never treated as unique. |
| Shift record | `Record Key` (§4) | One row per shift assignment in `_SCHEDULE_DATA`. |
| Import | `Import ID` (`IMP_<UTC timestamp>_<random>`) | Links log, journal and staging. |

### Relationships

- **Team → staff:** each team has its own staff sheet. The same person can appear in several teams' sheets. `_STAFF_MASTER` is a *derived, one-way* index (team sheets → master) that lists each Employee ID's teams and flags conflicting names/emails. Nothing ever writes back from the master, so there is no bidirectional sync.
- **Shift → team:** `_SCHEDULE_DATA.Team ID`. With a source shift ID, the team is an attribute: a re-import can move a shift to another team (UPDATE, with a warning). With a composite key, the team is part of the key.
- **Shift → employee:** `Employee ID` (the source ID, or the staff ID matched by unique exact name), plus `Staff Match` = `ID` / `NAME` / `AMBIGUOUS` / `UNKNOWN`, recorded at import time. Views re-evaluate the match against the current staff sheet each time they render, so adding a missing employee clears the flag without re-importing.

### Configurable staff fields (v1.1)

- **Built-in fields** live in code (`STAFF_FIELD_DEFS`): Employee ID, Employee Name, Active, Role, Notes, Email, Team, Skills, Last Updated.
- **Configurable fields** live in `_STAFF_FIELDS`, e.g. `external_id_1` = "Converse ID". Teams reference them as `field:<key>` in `settings.staffFields`.
- **Column linking.** Every managed staff-sheet header carries the note `sm-field: <key>`. Columns are resolved by note first, then by header text, so renaming "Converse ID" to "CRM ID" changes only the header.
- **Unselected or hidden fields** are hidden columns; values are never deleted.
- **Employee ID** is always the internal key. An identifier field is used for import matching only when a team explicitly selects it as its match key. Matched records then store the staff member's internal Employee ID, and the source value is kept in Extra JSON.

### Shift types and operating hours (v1.1)

**`team.settings.import`** holds:

| Setting | Values |
|---|---|
| `scheduleType` | `QUINYX_DAILY` or `TABLE` |
| `shiftTypeMode` | `NOT_CONFIGURED`, `SELECTED` or `ALL` |
| `shiftTypes` | the selected shift types |
| `knownShiftTypes` | every shift type seen for the team, used to warn about new ones |
| `matchField` | `employeeId` or `field:<key>` |
| `nameMatch` | team-level name-matching strategy |
| `duplicateStrategy` | team-level default strategy |

How the filter works:

- It runs **before** validation, so excluded rows never block an import.
- `NOT_CONFIGURED` blocks the import until the administrator chooses. "All" is never the default.
- With `SELECTED`, *Replace* only removes stored shifts of the selected types.

**`team.settings.display`** holds `operatingHoursMode` (`STANDARD`, `24_7` or `CUSTOM`), `operatingHoursStart`/`End` and `defaultDate`. The window for date D is `[D+start, D+end)`; a custom end at or before the start crosses midnight.

The view includes:

- every shift dated D;
- shifts from D−1 that run into D (always for 24/7, otherwise when they reach the window or `SHOW_CARRY_OVER` is on);
- shifts from D+1 that start inside a window crossing midnight.

Headcount covers exactly the window.

### Updates, deletions, history

- **Updates:** a re-import with the *Update* or *Replace* strategy overwrites the mapped fields of the matching record. Its previous values are journaled.
- **Deletions:** imports never delete rows. *Replace* marks records `REMOVED`. A later import containing the same key restores them.
- **History:** `REMOVED` records, the import log and the journal are kept indefinitely. Deleting a team keeps its records (reported as "records of an unregistered team" by *Validate Data*).
- **Employees moving teams:** add them to the new team's staff sheet and mark them *Inactive* in the old one. Past shifts keep their original Team ID. New imports route by the export's team column (or the selected team).
- **View refresh:** a view is re-rendered from `_SCHEDULE_DATA` for the selected date and filters. This happens on any edit of B3/E3/G3/I3, after commits/undos, on *Refresh Schedule Data*, and on *Repair Formatting*. Rendering never writes to `_SCHEDULE_DATA`.

## 4. Duplicate strategy

**Record key**

- With a mapped source Shift ID: `S|<shiftId>`.
- Otherwise: `C|<teamId>|ID:<EMPLOYEE ID>|<yyyy-MM-dd HH:mm start>|<… end>|<normalized activity>`, followed by `|ST:<normalized shift type>` when the row has a shift type (v1.1). When a row has no Employee ID, `NM:<normalized name>` replaces the ID part, which is the normal case for the Daily Schedule export. The key always comes from source data, even when the name was matched to a staff ID, so a staff change never changes keys. Records imported by v1.0 had no shift type, so their keys are unchanged.

Employee + date alone is never used as a key, so several shifts per person per day are supported.

**In the file:** an exact duplicate row is skipped (warning). Two rows with the same key but different values are a conflict: the second is rejected.

**Against stored data:**

| Stored state | Result |
|---|---|
| Key not stored | INSERT |
| Stored, `REMOVED` | Restore (UPDATE) |
| Stored with identical values | Unchanged |
| Stored with different values | Depends on strategy: **Skip** keeps the stored version, **Update** overwrites, **Ask** blocks until a strategy is chosen in the preview |

**Replace within range:** for each team in the file, any stored ACTIVE record of that team dated between that team's first and last imported date, and not present in the file, is marked REMOVED. Records outside that range are never touched. Replace is **blocked** if any of that team's rows were rejected, because their stored versions would otherwise be removed.

Because the composite key includes start, end and activity, a shift whose time changed in Quinyx shows up as *new* under Update, and the old version stays. **When the export has no shift ID, use Replace** for re-imports of a period. This is why the default strategy is *Ask*.

**Exact re-imports** of the same file are detected by content hash and warned about. They are harmless, because everything is reported as unchanged.

## 5. Import integrity

1. The upload is parsed and staged in `_IMPORT_STAGING`. Nothing touches production data.
2. **Analyze** validates every row: required fields, calendar validity, time ranges, break consistency, team routing, staff match, keys, and the diff. The result is a plan with a token (a hash of every action, the strategy and the counts).
3. **Commit** (under `LockService` document lock):
   1. Recompute the plan. If the token differs, return a fresh preview (`PLAN_CHANGED`) and write nothing.
   2. If there are blockers (fatal errors, *Ask* with conflicts, or rejected rows without *Import valid rows*), stop and write nothing.
   3. Append the `_IMPORT_LOG` row with status `COMMITTING`.
   4. Append the before-images of every touched record to `_IMPORT_CHANGES`.
   5. Write `_SCHEDULE_DATA` with **one** `setValues` call (rows from the first modified row to the end, plus appended rows).
   6. Set the log row to `COMMITTED`, then clear staging and re-render the affected views and the dashboard.

If step 4 or 5 throws, the log row becomes `FAILED` and no data has changed. If the execution is killed (timeout), the log row stays `COMMITTING`. *Validate Data* reports it, and **Undo Last Import** rolls it back idempotently: it only reverts records whose `Last Import ID` is that import.

**Undo** reverts the newest `COMMITTED`/`COMMITTING` import: inserted rows are deleted, updated and removed rows are restored from their before-images. It can be repeated, newest first.

## 6. Spreadsheet schema (Phase 2)

All internal sheets start with `_`. They are protected with *warning only* and can be hidden (`HIDE_SYSTEM_SHEETS`). **Neither protection nor hiding is security:** every editor can read and change them. Text-typed columns are formatted as plain text (`@`) so IDs like `00123` and times like `08:00` are never converted by Sheets. Columns are found by header label, so admins may add their own columns (they are preserved on every write).

### Internal sheets

**`_CONFIG`**: key/value settings. Key: `Key`.

| Column | Type |
|---|---|
| Key | text |
| Value | text |
| Description | text |
| Updated At | datetime |

Keys include `SYSTEM_VERSION`, `INITIALIZED`, `INITIALIZED_AT`, `TEAM_ID_SEQ`, `TEST_MODE`, `TIMEZONE`, `DATE_FORMAT`, `TIME_FORMAT`, `SCHEDULE_SHEET_PATTERN`, `STAFF_SHEET_PATTERN`, `DASHBOARD_SHEET`, `SHOW_CARRY_OVER`, `HIDE_SYSTEM_SHEETS`, colors, `DEFAULT_DUPLICATE_STRATEGY`, `DEFAULT_DATE_ORDER`, `NAME_MATCH_STRATEGY`, `STRIP_LEADING_ZEROS`, `MAX_SHIFT_HOURS`, `MIN_SHIFT_MINUTES`, `MAX_FILE_MB`, `STAGING_RETENTION_HOURS` and `AUTO_MAP_SYNONYMS`. See `CONFIG_DEFAULTS` in `ConfigService.gs` for descriptions.

**`_TEAMS`**: key: `Team ID`.

| Column | Type | Notes |
|---|---|---|
| Team ID | text | `TEAM_001`… |
| Team Name | text | unique |
| Team Type ID | text | → `_TEAM_TYPES` |
| Active | boolean | |
| Status | text | `PENDING`, `READY` or `ERROR` |
| Schedule Sheet / Staff Sheet | text | current tab names |
| Default View | text | `DAILY` |
| Import Profile ID | text | → `_IMPORT_MAPPINGS`, optional |
| Import Aliases | text | comma-separated source team values |
| Description | text | |
| Settings JSON | JSON | `display`, `scheduleFields`, `staffFields`, `extraFields`, `scheduleSheetId`, `staffSheetId`, `lastError` |
| Created At / Updated At | datetime | |

**`_TEAM_TYPES`**: key: `Team Type ID`. Columns: Team Type Name, Description, Schedule Fields JSON (display field keys), Staff Fields JSON (staff keys and `custom:Label`), Default Import Profile ID, Display Settings JSON, Enabled, Created At, Updated At.

**`_IMPORT_MAPPINGS`**: key: `Profile ID`.

| Column | Contents |
|---|---|
| Profile Name, Description | text |
| Field Map JSON | `{"employeeId": "<exact header>", "start": "<header>", …}` |
| Options JSON | `{dateOrder, breakUnit, headerRow, defaultTeamId, teamValueMap}` |
| Header Signature | hash of the sorted normalized headers, used for automatic recognition |
| Created At / Updated At | datetime |

**`_SCHEDULE_DATA`**: the source of truth. Key: `Record Key`.

| Column | Type | Notes |
|---|---|---|
| Record Key | text | §4 |
| Team ID | text | |
| Shift Date | text | `yyyy-MM-dd`, the date the shift starts |
| Employee ID | text | |
| Employee Name | text | |
| Staff Match | text | `ID`, `NAME`, `AMBIGUOUS` or `UNKNOWN` |
| Activity, Role | text | |
| Shift Start, Shift End | text | `yyyy-MM-dd HH:mm`; End may fall on the next day |
| Break Start, Break End | text | `yyyy-MM-dd HH:mm` or blank |
| Break Minutes, Gross Minutes, Net Minutes | number | |
| Shift Status | text | from source |
| Record Status | text | `ACTIVE` or `REMOVED` |
| Source Shift ID | text | |
| Comment | text | |
| Created Import ID, Last Import ID | text | |
| Updated At | datetime | |
| Extra JSON | JSON | every unmapped, non-empty source column |
| Shift Type | text | v1.1, as in the export (whitespace-normalized) |
| Source Shift Info | text | v1.1, original shift-information cell |
| Source Hours | text | v1.1, original hours cell |
| Scheduled Minutes | number | v1.1, parsed hours (blank if missing or invalid) |

**`_TEAM_MEMBERSHIP`** (v1.1.1): key = Employee ID + Team ID.

| Column | Contents |
|---|---|
| Membership Status | `ACTIVE` or `INACTIVE` |
| Team Role | optional |
| Source | `BACKFILL`, `ADMIN` or `STAFF_SIDEBAR` |
| Created At / Updated At | datetime |

**`_SLACK_PAYLOADS`** (v1.1.1): key `Payload ID`. Columns: Generation ID, Generated At, Schedule Date, Employee ID / Name / Display, Team ID / Name, Activity Type / Category, Start/End DateTime, Start/End Time, Dashboard ID / URL, Block Number, Group Key, Source Schedule Record ID, Source Import ID, Payload Status, Message, Line Text, Slack User ID, Content Hash. This is derived output: regenerate it rather than editing it.

**`_SCHEDULE_DATA`** v1.1.1 adds **Activity Category** (`SHIFT` or `MEETING`; blank in older rows means `SHIFT`). **`_IMPORT_LOG`** adds Meetings Imported and Meetings Excluded. **`_STAFF_FIELDS`** adds **Display Order**.

**`_STAFF_FIELDS`** (v1.1): key `Field Key` (permanent).

| Column | Contents |
|---|---|
| Display Name | renamable |
| Field Type | `IDENTIFIER` (text, unique per team) or `TEXT` |
| Required | bool |
| Visible | bool |
| Usable As Match Key | bool |
| Description | text |
| Created At / Updated At | datetime |

**`_IMPORT_LOG`**: key: `Import ID`. Columns: Timestamp, Source File, Source File ID (reserved for Drive-based sources), Format (plus "Daily Schedule *date*"), Profile ID, Target Teams (`Name [TEAM_ID], …`), Date From, Date To, Rows Processed / Inserted / Updated / Skipped / Removed / Rejected, Strategy, Status (`COMMITTING`, `COMMITTED`, `FAILED` or `UNDONE`), Error Summary, User (where available), File Hash, and since v1.1 Rows Excluded (Shift Type) and Shift Types Imported.

**`_IMPORT_CHANGES`**: the undo journal. Columns: Import ID, Seq, Record Key, Action (`INSERT`, `UPDATE` or `REMOVE`), Before JSON.

**`_IMPORT_STAGING`**: parsed uploads awaiting confirmation. Columns: Import ID, Chunk, Payload (`~`-prefixed JSON chunk of ≤45,000 characters), Created At. Purged after `STAGING_RETENTION_HOURS` and on commit or cancel.

**`_STAFF_MASTER`**: derived and read-only. Columns: Employee ID, Employee Name, Email, Team IDs, Active In, Conflicts, Updated At.

### Team-facing sheets

**`<Team> - Daily`** (one per team; the pattern is configurable):

| Location | Contents |
|---|---|
| Row 1 | Title and a link to the staff sheet |
| Row 2 | Team type, last import, import status, operating hours (I2) |
| Row 3 | **Controls:** B3 date picker, C3 weekday, E3 employee filter, G3 shift-type filter (activity when there is no shift type), I3 status filter |
| Row 4 | Summary: shifts, staff, net hours, overlaps, unknown employees |
| Row 5 | Messages |
| Row 6 | Headers |
| Row 7 onward | One row per shift: the team's configured fields, a *Status / Flags* column, and a *Hour / Headcount* table to the right covering the operating window |

Status flags: `OK`, Overnight, Overlap, Unknown employee, Name match, Long shift, Inactive employee, Hours differ, Outside operating hours, From previous day, Starts next day.

**`<Team> - Staff`**:

| Location | Contents |
|---|---|
| Row 1 | Title |
| Row 2 | Link and hint |
| Row 3 | Headers, linked to field keys by header notes (`sm-field: …`) |
| Row 4 onward | Data (default columns below) |

- **Default columns (v1.1):** Employee ID, Employee Name, Converse ID, Aircall ID, AstraID, Active, Role, Notes.
- **Identifier columns** are plain text, and duplicates are highlighted.
- **Active** is a dropdown (`Active`/`Inactive`, blank = Active).
- A basic filter supports searching.
- **Last Updated** is stamped on edit, if the team uses that column.

**`Dashboard`**: one row per team (shifts, staff, net hours and peak headcount today, unknown employees, overlaps, last import, links) plus the last 10 imports.

## 7. Known limitations

- **Volume.** Each import analysis reads all of `_SCHEDULE_DATA`. Expect smooth operation up to roughly 50,000 records. Beyond that, add archiving (see `EXTENDING.md`). One import is limited to 20,000 rows and `MAX_FILE_MB`.
- **XLSX/XLS/ODS** need the Drive advanced service (v3). The file is converted through a temporary Google Sheet in the user's Drive, which is permanently deleted right after reading. CSV/TSV and *paste into a tab* need no Drive access.
- **Daylight-saving time.** Durations of shifts spanning a DST change are off by the DST delta (wall-clock arithmetic).
- **Name-only matching** is exact after case/accent/space folding. "Doe, John" and "John Doe" do not match by design: no fuzzy merging.
- **View edits.** Changes typed into a daily view are not saved back. The data is changed by importing.
- **`onEdit` is a simple trigger.** Pasting into B3 from another sheet or editing via the API does not fire it. Use *Refresh Schedule Data*.
- **Repair Formatting** resets conditional-formatting rules on generated sheets (custom rules added there are replaced).
- **Leading apostrophe.** Source values beginning with `=`, `+`, `-` or `@` are stored as text with a leading apostrophe so they can never execute as formulas. In rare cases the apostrophe can be visible.
- **Daily Schedule layout is unverified** (see §1). The parser rejects what it cannot read, but the default rows and columns may need adjusting for the real export.
- **Shift-type matching is exact.** "Customer Support" and "customer support" are different types, by design. New spellings appear as *new* shift types in the preview.
- **Header layout profile.** The header row and first data row are stored in the mapping profile, so teams that share a profile share the layout.
- **Overnight shifts in a one-day export** are dated on the schedule date. A shift that started the day before cannot be recognized from times alone.
- **Meeting detection** depends on the shift/activity type text in the export. Meetings that Quinyx exports as part of a shift row (rather than as their own row) cannot be separated.
- **Directory routing** matches by Employee ID, or by a unique exact name using the global name strategy. A team's alternative match key is not used for routing.
- **Slack payloads** are normalized sheet rows. The Slack Workflow input schema has not been verified, so no specific schema is claimed (see §9).
- **Display Order** sets the order of new columns and of fields in the dialogs. Existing staff-sheet columns are never moved.

## 8. Meetings, shared directories and routing (v1.1.1)

### Meetings

- **Configuration.** A team lists its **meeting types**: shift/activity types, matched exactly after whitespace normalization, against the shift type column or, if there is none, the activity column. **Import meetings** turns them on.
- **Import meetings on:** matching rows are stored as separate assignments with `Activity Category = MEETING`. Their key includes their own times and type, so several meetings per employee per day never collide.
- **Import meetings off:** matching rows are excluded before validation and counted (*Meetings excluded*, also in `_IMPORT_LOG`).
- **Unknown types** are never meetings.
- **Overlaps of the same employee** are classified pairwise:

| Pair | Result |
|---|---|
| Meeting entirely inside a shift | Expected. Shown as *Meeting (in shift)*, not a conflict. |
| Meeting before or after a shift (touching or apart) | No overlap. Shown as *Meeting (outside shift)*. |
| Shift + shift, meeting + meeting, or a meeting partly outside a shift | **Conflict** (*Overlap*) |
| Identical source rows | Duplicate in the file; skipped |

**Working hours (documented rule).** For each employee and day: the net minutes of every shift (gross minus recorded break), plus only the part of each meeting that no shift covers. Activity durations and source hours (column F) are stored unchanged. The view's *Scheduled Hours* shows the source value per row.

### Shared staff directories and membership

- **Directory = staff sheet** (by sheet ID). A team uses either a **dedicated** sheet or **shares** another team's sheet. Only sheets registered as some team's staff sheet can be shared.
- **One record per employee.** Each employee exists once per directory. Updates are visible to every team using it.
- **Membership:**

| Directory | Who is a member of team T |
|---|---|
| Dedicated (one team) | Everyone in the sheet (implicit, unchanged from earlier versions) |
| Shared (2+ teams) | Only employees with an ACTIVE row (Employee ID, T) in `_TEAM_MEMBERSHIP`; a team-specific role is optional |

- **Backfill.** When a directory becomes shared, its current employees get explicit memberships for the team(s) that already used it, so nothing changes for them. The joining team gets members only if the administrator ticks *Make all current employees members*.
- **Staff added for a team** in a shared directory become members of that team only.
- **Moving between teams** means changing memberships (Staff sidebar); stored schedules keep the team they were imported for.
- **In the daily view,** employees who are in the directory but not members of the team are flagged *Not a team member*.

### Routing by staff directory membership

This is the import mode **Route by staff directory membership**. It covers all READY teams with *Use staff directory for employee matching and team routing* enabled. For each row:

1. **Identify the employee:** Employee ID if mapped, otherwise a unique exact name (global name strategy).
2. **Resolve them** against the routing teams' directories.
3. **Collect candidate teams** where the employee is an active member.
4. **Narrow the candidates:** first by the export's team column (if mapped and recognized), then by the teams' shift-type and meeting settings.
5. **Route only when exactly one team remains.**
   - **Ambiguous** rows (several teams) and **unroutable** rows (unknown employee, ambiguous name, or no membership) are rejected and listed in the preview's routing table.
   - The administrator assigns each one to a team or skips it, then re-analyzes. These decisions are part of the plan token.
   - Nothing is ever copied into several teams.

The preview's routing table shows the Quinyx name, matched Employee ID, staff name, match method, membership status, resolved team and routing status for every row, problems first.

## 9. Slack Workflow payloads and dashboard URLs (v1.1.1)

**Source.** Payloads are built only from ACTIVE records in `_SCHEDULE_DATA` and the authoritative staff directories. Quinyx files are never re-parsed and schedule data is never modified.

**Pipeline.** `buildPayloadPlan_` is pure and unit-tested:

1. **Retrieve and validate.**
   - Records are filtered by the selected teams and dates (by the shift's start date, so overnight shifts belong to the day they start), by activity types, and by meeting inclusion.
   - Employees are resolved in the team's directory and membership is checked.
   - Unresolved employees, non-members and inactive employees are excluded or kept with a status, per configuration. Every exclusion is counted.
2. **Group into blocks** (`groupIntoBlocks_`).
   - Records are sorted by the grouping keys (team / date / employee / activity), and groups are kept together.
   - **Without a records-per-block limit:** groups are spread over at most *N* blocks, combining consecutive groups when needed.
   - **With a limit:** blocks hold at most *M* records, and a group larger than *M* is split (with a warning). If more than *N* blocks would be needed, generation is **refused**; records are never dropped.
   - An internal check verifies that the record count is preserved.
3. **Serialize** with `PAYLOAD_SERIALIZERS.ROWS`, one `_SLACK_PAYLOADS` row per record. A serializer for a verified Slack schema can be added without touching stages 1–2.

**Records.** Every shift and meeting becomes its own record. Each record carries: Payload ID (`GEN_…-0001`), Generation ID and time, Schedule Date, Employee ID, name, display value, Team ID/Name, activity type and category, start/end date-time and time, Dashboard ID and URL, block number, group key, source Schedule Record Key, source Import ID, status, message, a rendered line text, an optional Slack user ID, and a content hash.

**Employee display.** The template defaults to `@{EMPLOYEE_NAME}`, built from the staff record (e.g. "@Bence Valentinyi"). This is a **display string**, not a Slack mention: a real mention needs a Slack user ID (`<@U…>`). If a staff field holding Slack user IDs is selected, its value is written to *Slack User ID*. No IDs are ever invented.

**Dashboard URL.**

| Setting | Behaviour |
|---|---|
| Template | Literal text plus supported placeholders only: `{EMPLOYEE_ID}`, `{EMPLOYEE_NAME}`, `{TEAM_ID}`, `{TEAM_NAME}`, `{DATE}`, `{START_TIME}`, `{END_TIME}`. Anything else makes the URL invalid. Templates are text; nothing is evaluated. |
| `{EMPLOYEE_ID}` | Becomes *text before* + identifier + *text after*. The identifier comes from the configured field (Employee ID or any staff field). The text before and after is inserted exactly, so custom delimiters such as `"…"%2"…"` are preserved. |
| Encoding | `COMPONENT` encodes each inserted value; `NONE` inserts values unchanged. The template itself and the text before/after are never encoded or altered. |
| Validation | **Invalid:** not http(s), whitespace, or leftover placeholders. The URL is left blank and the record is flagged. **Warning:** characters that are usually encoded, malformed `%` escapes, non-ASCII. These are kept as configured and flagged. |
| Missing identifier | Blank URL + warning, skip the record (counted), or block generation. |
| Preview | Uses the same `buildDashboardUrl_` as generation, so the preview always matches the generated URL. |

**Output modes.**
- **Replace** removes earlier payload rows of the selected teams within the selected dates, and keeps everything else.
- **Append** adds a new generation. Content identical to an earlier generation (same hash) needs explicit confirmation.

Generation always follows a preview: the plan token must match, and runs under the document lock.

**Automation.** None. No triggers are created by setup, the upgrade, or this module. A future scheduled run would need explicit administrator activation.

## 10. User interface (v1.1.2)

**Pages.** Every dialog and sidebar is an HtmlService template that includes two shared files:

| File | Contents |
|---|---|
| `Styles.html` | Design tokens and all component CSS. Pages add layout-only CSS at most. |
| `ClientCore.html` | Server calls and shared components |

`ClientCore.html` provides:

- **server calls:** `api()` and `call()`. `call()` shows the loading overlay, which also blocks duplicate submissions, and reports errors in `#status`;
- **HTML builders:** `alertHtml`, `badge`, `stat`, `emptyHtml`, `stepperHtml` / `renderStepper` and `kvTable`;
- **interaction:** `fieldError` / `clearFieldErrors`, `initTabs` / `selectTab`, `askConfirm` / `closeConfirm`, `focusFirst`, `radio`, `setRadio`, `checkedData` and `kv`.

**Page frame.** Every page uses the same structure:

```
<header class="app-header">  title · subtitle · stepper or tabs
<main class="app-body">       #status, then the content (scrolls)
<footer class="app-footer">   Cancel/Close … primary action
```

Sidebars add `class="sidebar"` to `<body>` for tighter padding.

**Dialog sizes and titles.** `showHtml_` takes one of the `DIALOG_SIZE` entries: SMALL 520×420, MEDIUM 780×620 or LARGE 960×700. The dialog frame is titled "Schedule Manager", and the page shows its own heading, passed in as `BOOT.title`.

**Design tokens:**

- **color:** primary, surface and background levels, text levels, borders, success, warning, error, info, meeting, focus and disabled;
- **type scale:** title 16 px, h2 14 px, h3 13 px, body 13 px, label 12.5 px, small 12 px, badge 11.5 px;
- **spacing:** 4, 8, 12, 16, 24 and 32 px;
- **dialog padding:** 16 × 20 px;
- **table cells:** 6 × 10 px.

Status is always written in text (badge text, alert title or icon glyph), never shown by color alone.

**Schedule Viewer.** `Navigator.html` is a sidebar. It calls:

- `apiNavigatorBootstrap` to list the teams;
- `apiViewerRender(teamId, date, filters)` for each user action.

`apiViewerRender` renders the daily sheet through `renderTeamView_`, activates it, and returns the header facts, summary and filter options. The filters are still stored in the sheet's row 3 cells, so editing them in the sheet and using the sidebar stay in sync. An empty date applies the team's "when the schedule is opened" setting.

**Meeting shading.** `layoutScheduleSheet_` adds a row rule that shades a row when its Flags text starts with "Meeting", or when its Category is "Meeting". The rule is applied when a sheet is created, rebuilt or repaired.

**Static checks.** `tests/run-ui-checks.js` enforces the conventions that keep controls connected and labelled. Run it after every UI change.