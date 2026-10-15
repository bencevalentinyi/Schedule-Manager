# Changelog

## 1.1.2 — User interface overhaul

A UI release. The scheduling engine, import rules, data model and stored configuration are unchanged, so **no migration is needed** (see "Version and upgrade" below).

### Design system

- **One stylesheet** (`Styles.html`) with tokens and components, used by every dialog and sidebar:
  - **tokens** for color, type, spacing and radius;
  - **controls:** buttons (primary, secondary, ghost, danger, danger-solid, small, icon), form fields with labels, hints and inline errors, styled selects, checkboxes, radios, switches and choice cards;
  - **feedback:** alerts with an icon and a title, badges that always carry text, summary tiles, empty states, a loading overlay and inline loading, confirmation panels and tooltips;
  - **structure:** panels, collapsible sections, tables with sticky headers, master/detail lists, tabs, a step indicator and a toolbar.
- **One set of client helpers** (`ClientCore.html`):
  - **calls:** `api` / `call`, where the overlay also blocks duplicate submissions;
  - **HTML builders:** `alertHtml`, `badge`, `stat`, `emptyHtml`, `stepperHtml`, `kvTable`;
  - **forms and navigation:** `fieldError`, accessible tabs with arrow-key navigation (`initTabs` / `selectTab`), `askConfirm` (optionally type-to-confirm) and `focusFirst`;
  - **errors:** readable messages with a suggested next step; technical details stay in the execution log.
- **The same frame on every page:** a header (title, subtitle, steps or tabs), a scrolling body, and a footer that stays visible. Cancel/Close sit on the left and the primary action on the right.
- **Three standard dialog sizes:** 520×420, 780×620 and 960×700. The page shows its own title; the dialog frame shows "Schedule Manager".
- **Layout and accessibility:**
  - layouts adapt to narrow windows and browser zoom, and wide tables scroll horizontally;
  - focus is visible and every control has a label;
  - status is never shown by color alone;
  - reduced-motion preferences are respected.

### Pages

| Page | What changed |
|---|---|
| Setup | Status alert, sheet table with badges, connection test shown inline |
| Create / Edit Team | Six steps: General, Schedule, Staff directory, Quinyx import, Meetings, Review. Operating hours, staff directory and shift-type mode are choice cards; advanced options are collapsed. When editing, any step can be opened directly ("Review changes"). The review lists name, type, display mode, directory, columns, import format and profile, shift types, meeting import, matching, duplicate handling, aliases and the sheets to be created |
| Manage Teams | Searchable table: Ready / Active / Shared or Dedicated badges, operating hours, shift types and meetings per team; deletion in a type-to-confirm panel |
| Team Types | Master/detail layout; deleting a type in use is explained instead of attempted |
| Staff Fields | Master/detail layout; hide vs. delete explained; delete panel where clearing values requires typing the field name |
| Staff Directory (sidebar) | List view, editor and unknown-employees view; dedicated or shared directory stated at the top (shared: "records are shared; membership and schedules stay team-specific"); membership switches; required fields checked inline |
| Schedule Viewer (sidebar, new) | Replaces the small date dialog. Team, ◀ date ▶, Today, Refresh, header facts (date, weekday, operating-hours mode and window, last import and status), summary tiles, employee search, shift-type and status filters, legend. Uses the team's default date when opened |
| Import | Steps: Select file, Inspect & map, Team & shift types, Review & confirm, Results. Detected file facts (name, type, structure, schedule date, profile); shift types marked Included / Excluded / New-unknown, and meeting types listed separately with whether this team imports them; grouped preview metrics; collapsible detail tables (shift types, routing decisions, teams, rejected rows, unknown employees, overlaps, row warnings); a "Confirm what will be written" summary (teams, dates, activity types, meetings, duplicate handling, updates/removals) built from the server's plan |
| Import History | Summary tiles, search and status filter, undo in a confirmation panel |
| Settings | Accessible tabs; settings shown with readable names (raw key beside them); profile deletion confirmed |
| Slack | Generate tab (current scope, Preview, results with records, blocks, teams, employees, missing identifiers, invalid URLs, unresolved employees; an "Open generated payloads" button; states plainly that nothing is sent to Slack); configuration grouped into Scope, Content and Output, with a re-orderable grouping list; Dashboard URL tab with placeholder chips, a "{EMPLOYEE_ID} = before + field + after" line, a status badge, and the inserted identifier highlighted in the test URL. The template is never modified |
| Report / Help | Error, warning and information tiles; updated help |

### Daily schedule sheet

- **Meeting rows** are shaded violet when the sheet has a Flags or Category column. Their Flags text ("Meeting (in shift)" / "Meeting (outside shift)") is no longer colored as a warning.
- **Row 5** shows a short legend when there is no problem message.
- **Existing sheets** get the meeting shading after **Maintenance → Repair Formatting**; new or rebuilt sheets get it automatically.
- **Operating hours, 24/7 coverage and overnight shifts are unchanged:** no display logic was touched.

### Menu

*Schedule Management* now starts with **Schedule Viewer (date, filters, refresh)**. *Select Schedule Date* and *View Team Schedule* open the viewer, and a separator sets *View Staff Directory* apart. All existing menu functions keep their names.

### Server changes (additive; no contract removed)

| Function | Change |
|---|---|
| `apiViewerRender(teamId, date, filters)` | New. Renders, activates and returns the header facts, summary and filter options |
| `renderDailyView_` | Accepts `opts.filters` and returns more fields; existing callers are unaffected |
| `apiImportBootstrap` | Team entries include `importMeetings` and `meetingTypes` |
| `apiSlackPreview` / `apiSlackGenerate` | Also return `employees` (distinct employees) |
| `apiSlackOpenPayloadSheet()` | New |
| `showHtml_` | Takes a `DIALOG_SIZE` entry; `showScheduleViewer_` added |

### Version and upgrade

- `APP.VERSION` is `1.1.2`, and `APP.COMPATIBLE_VERSIONS = ['1.1.1']`.
- A spreadsheet stored as 1.1.1 is **not** blocked with "upgrade required". Running Setup simply records 1.1.2 ("no data or configuration changes were needed").
- Older versions still require Setup → Upgrade, as before.

### Tests

| Suite | Change |
|---|---|
| `tests/run-ui-checks.js` (new) | Static checks of every page: includes, script syntax, inline handlers, server calls, element IDs, label targets, labelled controls, button types and names, duplicate IDs, and the status area. Also checks menu targets and the pages opened by `showHtml_` |
| Unit tests | Version compatibility and the employee count |
| Integration tests | Schedule Viewer filters, stored filter cells, the meeting-shading rule, refusal of an unknown team |
| Migration test | Scenario C: 1.1.1 → 1.1.2 (no forced upgrade; teams, types, records, configuration and sheets unchanged; second run changes nothing) |

### Known limitations

- **No role filter in the viewer:** the daily sheet has no role filter cell, and adding one would change every team's sheet layout. Employee, shift-type/activity and status filters are available.
- **Native menu:** Google Sheets menus cannot be styled, so only labels and grouping changed.
- **Not visually verified in Google Sheets:** the pages have not been checked in a real Sheets dialog, at different zoom levels, or with a screen reader. The static checks do not replace that review.

## 1.1.1

### Meetings and multiple assignments per day

- **New per-team settings.** **Import meetings** (on/off) and **meeting types**: shift/activity types selected from the known or discovered types. Matching is exact after whitespace normalization, and unknown types are never treated as meetings.
- **Category.** Meeting rows become separate assignments with **Activity Category = MEETING** (new `_SCHEDULE_DATA` column). Normal shifts are `SHIFT`; records stored before 1.1.1 count as `SHIFT`.
- **Meeting import off.** Meeting rows are excluded and counted in the preview (*Meetings excluded*) and in `_IMPORT_LOG`.
- **Overlaps are classified:**
  - a meeting entirely inside a shift is expected (not a conflict);
  - two overlapping shifts, two overlapping meetings, or a meeting only partly inside a shift are conflicts;
  - identical source rows are duplicates and are skipped.
  - Overlap detection is now pairwise, so two meetings inside the same shift are also compared with each other.
- **Working hours.** The sum of shift net minutes, plus only the part of each meeting not covered by a shift. Activity durations and source hours are never changed. The daily view summary shows "Working hours" and the meeting count.
- **Preview counts:** normal shifts, meetings detected, selected and excluded, duplicates, invalid times, unknown employees, and ambiguous team assignments.

### Staff sheet and custom fields

- **Default staff sheet:** Employee ID, Employee Name, Active, Role, Notes.
- **No automatic identifier fields.** Converse ID, Aircall ID and AstraID are no longer created; administrators add any field under *Configure Staff Fields*.
- **Field settings:** each field has a permanent key, display name, type, visibility, required flag, the teams that use it, and a new **Display Order**.
- **Delete field.** Removes the field from all teams. By default its column and values stay in the sheets as an ordinary column. Clearing the values permanently requires typing the field name.
- **Existing installations:** fields and columns created by 1.1.0 are kept as user data. Teams keep their current columns; only an untouched starter team type moves to the five-column default.

### Shared staff directories and explicit membership

- **Choice per team:** when creating or editing a team, choose a **dedicated** staff sheet or **share** an existing staff sheet of another team. System and schedule sheets cannot be chosen.
- **New `_TEAM_MEMBERSHIP` table** (Employee ID, Team ID, Membership Status, Team Role):
  - In a *dedicated* directory, every employee is a member of its one team (as before).
  - In a *shared* directory, membership is explicit: sharing never makes everyone a member of every team.
  - When a directory becomes shared, its existing employees get explicit memberships for the team(s) that already used it, so nothing changes for them. Optionally, all of them can also be added to the new team.
- **Staff sidebar:** shows membership per team for shared directories and lets you edit it (including a team-specific role). New staff added for a team become members of that team only.
- **New team-level option:** **Use staff directory for employee matching and team routing**, plus a new import routing mode **Route by staff directory membership**. A row goes to a team only when the employee is an active member and the destination is unambiguous:
  - first narrowed by the export's team column, then by the teams' shift-type and meeting settings;
  - rows that remain ambiguous or unroutable are listed in a routing table, where each one is assigned to a team or skipped before the import can be applied;
  - nothing is copied into every team that shares a directory.

### Slack Workflow Automation (new)

- **New menu:** *Generate Payloads*, *Configure Payload Generation*, *Configure Dashboard URL*, *View Generated Payloads*, *Validate Payload Data*. Generation is manual only; no triggers are ever created.
- **Configuration:**
  - which teams, and one date, a date range, today or tomorrow;
  - activity types, and whether meetings are included;
  - whether inactive employees, and unresolved employees or non-members, are excluded;
  - number of blocks, records per block, grouping (team / date / employee / activity);
  - output mode (Replace or Append);
  - display and line templates, and an optional staff field holding Slack user IDs.
- **Records** are written to `_SLACK_PAYLOADS` in three stages: retrieve and validate, group into blocks, serialize.
  - **Separate records:** every shift and every meeting gets its own record.
  - **Blocks:** records are never dropped to fit a block limit. If they don't fit, generation is refused.
  - **Replace** only touches the selected teams and dates. **Append** creates a new Generation ID, and appending identical content needs explicit confirmation.
  - **Preview first:** generation requires a preview, and is refused if the data changed since that preview.
- **Employee display** defaults to `@{EMPLOYEE_NAME}` (e.g. "@Bence Valentinyi"). This is a display string, not a Slack mention.
- **Dashboard URL generator:**
  - a template with the supported placeholders only;
  - a configurable identifier field (Employee ID or any staff field);
  - literal text before and after the identifier, so custom delimiters are kept exactly;
  - value encoding (component or none); the rest of the template is never altered;
  - a missing-identifier policy (blank + warning, skip, or block);
  - validation that rejects invalid URLs and flags unusual characters;
  - a live preview that uses the same function as generation.

### Data model and migration

| Sheet | Change |
|---|---|
| `_SCHEDULE_DATA` | New column: Activity Category |
| `_IMPORT_LOG` | New columns: Meetings Imported, Meetings Excluded |
| `_STAFF_FIELDS` | New column: Display Order |
| `_TEAM_MEMBERSHIP` | New sheet |
| `_SLACK_PAYLOADS` | New sheet |
| `_CONFIG` | New keys: `SLACK_PAYLOAD_CONFIG`, `DASHBOARD_URL_CONFIG` |

The upgrade (Setup → Upgrade) is idempotent:

- it adds columns, sheets and keys;
- it gives teams explicit settings with meetings off and routing off, so imports behave as before;
- it fills Display Order for existing fields in their current order;
- it updates only an untouched starter type.

Record keys are unchanged, so re-importing data stored by 1.1.0 is recognized as unchanged.

### Fixes found while testing

- Overlap detection compared each assignment only with the longest preceding one, so two overlapping meetings inside one shift were missed. It now compares every pair.

## 1.1.0

### Operating hours

Each team (and team type) now has an operating-hours mode, stored in `team.settings.display`:

| Setting | Values / notes |
|---|---|
| `operatingHoursMode` | `STANDARD` — same-day start/end, default 06:00–22:00<br>`24_7` — 00:00–23:59, no times to enter<br>`CUSTOM` — any start/end; an end before the start continues past midnight |
| `operatingHoursStart`, `operatingHoursEnd` | `HH:mm`. In custom mode, `23:59` means "until midnight". |
| `defaultDate` | `KEEP`, `TODAY` or `LATEST_IMPORT` |

The hours change what the daily view shows, not just a label:

- **24/7:** shifts from the previous day that run past 00:00 are always shown.
- **Custom hours that cross midnight:** shifts dated the next day that start inside the window are shown and flagged *Starts next day*.
- **Standard hours:** shifts completely outside the hours are still shown, flagged *Outside operating hours*.
- **Headcount:** covers exactly the operating window (24 slots for 24/7).

v1.0 teams kept their `workdayStart`/`workdayEnd` values; the upgrade converts them to `STANDARD` hours.

### Staff sheet and configurable identifiers

- **New default columns:** Employee ID, Employee Name, Converse ID, Aircall ID, AstraID, Active, Role, Notes. Email is no longer a default column.
- **New `_STAFF_FIELDS` registry.** Identifier and custom fields have a permanent key (`external_id_1`, …) and a display name that can be renamed.
- **Columns are linked to field keys** through a header note (`sm-field: …`). Renaming a field only changes the header text, so no values are lost.
- **Unticked or hidden fields** are hidden columns; values are never deleted.
- **Identifier values are stored as text** (leading zeros kept) and must be unique within a team.
- **Alternative match key:** a team can explicitly use an identifier field as the import match key. Identifier fields never take part in matching unless configured.
- **Name matching** strategy can be set per team.

### Quinyx "Daily Schedule" import

- **New profile format `QUINYX_DAILY`** with a configurable layout. The default is the *described* layout (A1 title/date, row 2 labels, data from row 3, A/B/C/F); it has not been verified against a real export.
- **Schedule date** is read from the title cell. It is never taken from today; an unreadable or ambiguous date must be entered by the administrator.
- **Shift information** cells such as `08:00 - 16:00`, `22:00–06:00`, AM/PM times or full date-time ranges are parsed into start and end. Cells with no range, or with several ranges, are rejected for review.
- **Hours column:** parsed and compared with the shift length; it never overwrites the times. Missing or invalid values, and differences above `HOURS_TOLERANCE_MINUTES`, are flagged *Hours differ*.
- **Group and spacer rows** are skipped. Optional *fill-down* handles shift types listed once per group.

### Shift-type filtering

- **Per-team settings:** `team.settings.import.shiftTypeMode` (`NOT_CONFIGURED`, `SELECTED` or `ALL`) plus the selected shift types.
- **Exact matching:** shift types match exactly after whitespace normalization.
- **Applied before validation:** excluded rows never block an import and are counted in the preview and log.
- **Never all by default:** a team without a selection must choose before anything is written. "All" is an explicit choice.
- **New shift types** (not seen before for the team) produce a warning. The wizard lets you update and save the selection.
- **Replace scope:** *Replace* only affects the team's stored shifts of the **selected** shift types for the imported date.

### Data model and migration

| Sheet | Change |
|---|---|
| `_SCHEDULE_DATA` | New columns: Shift Type, Source Shift Info, Source Hours, Scheduled Minutes |
| `_IMPORT_LOG` | New columns: Rows Excluded (Shift Type), Shift Types Imported |
| `_STAFF_FIELDS` | New sheet |

- **Record keys** get a `|ST:<shift type>` suffix only when a shift type exists, so v1.0 keys are unchanged and re-imports of v1.0 data are still recognized.
- **The upgrade** (Setup → Upgrade) is idempotent:
  - it adds missing columns, sheets, fields and profiles;
  - it writes explicit settings for teams that lack them;
  - it updates a starter team type only if its staff fields are still exactly the v1.0 default.
- **Until the upgrade has run,** actions show a clear "upgrade required" message instead of failing on missing columns.

### Fixes found while testing

- With an alternative match key, an unmatched source identifier could have been stored as the internal Employee ID. It is now stored as blank, with the source value kept in Extra JSON.
- Partial team edits (for example, changing only the description) now keep the team type and all other settings.
