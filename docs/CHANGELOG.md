# Changelog

## 2.0.0 — simplification, multi-team import, Monitoring Links, themes

Removed features and settings that were hard to understand (so they can be rebuilt one at a time), and added the features below. No team, staff or schedule data is deleted. Spreadsheets of 1.x run Setup → Upgrade once.

### Removed

- **Slack Workflow Automation**, completely: the menu, `SlackDialog.html`, `SlackMessageService.gs`, `SlackPayloadService.gs`, the `_SLACK_PAYLOADS` schema, the `SLACK_PAYLOAD_CONFIG` / `DASHBOARD_URL_CONFIG` / `SLACK_MESSAGE_CONFIG` keys and their tests. Existing spreadsheets keep the old sheet and keys; they are ignored and can be deleted by hand.
- **Configure Team Types** (`TeamTypeDialog.html` and its API). Team types still exist internally: new teams use the first enabled type (the starter "Standard Team").
- **Configure Import Settings**: the Import and Mapping profiles tabs. The import settings keep their values in `_CONFIG`; profiles are still created by the import wizard. The settings dialog now shows display settings only.
- **Preview Import (no changes)**: every import already previews before anything is written.

### Simplified

- **Team dialog** (create and edit): 5 steps: General, Schedule, Staff sheet, Shift types (with meetings), Review. Removed from the dialog: active switch (use Activate/Deactivate in the team list), team type, default date, time format, schedule columns, team-specific fields, shared staff sheet choice, inline custom field creation, legacy free-text columns, export type, import profile, employee match key, name matching, staff-directory routing, duplicate handling, header rows and import aliases.
  Settings that are no longer shown are **kept unchanged** when a team is edited; new teams get the defaults of the starter type.
- **Import wizard**: choose the team and the file; check the date (Daily Schedule) or the columns (table); choose the shift types; review. Removed: export type, mapping profile, file encoding and workbook sheet (auto-detected), day/month order (now an option under "Row of column names, date format"), team assignment modes (rows always go to the chosen team) and the duplicated duplicate-handling choice on the shift types step. The Daily Schedule layout fields are now behind "The rows or columns look wrong?" and open automatically when the default layout does not fit.
- **Team list**: no team type or import aliases.
- **System sheets are always hidden** after Setup and Repair Formatting (the `HIDE_SYSTEM_SHEETS` setting was removed). Nothing is hidden while no other sheet is visible, because Sheets needs one visible sheet. *Open System Configuration* still shows `_CONFIG`.
- **Breaks removed from the whole system**: no break import fields, no break or Net Hours columns in the daily view, no Breaks switch, no break unit in profiles, and `_SCHEDULE_DATA` no longer has Break Start / Break End / Break Minutes / Net Minutes. Working hours and "Hours differ" use the full shift length. A Break column in an export is kept as unmapped extra data. Existing spreadsheets keep their old break columns in `_SCHEDULE_DATA` (unused; delete them by hand if you like), and teams that showed *Net Hours* now show *Shift Length*.
- **Staff "Active" column retired.** It is no longer offered, created or required. In existing staff sheets the column is hidden (its values are kept) and everyone in a staff sheet counts as active. The staff sidebar no longer has "Include inactive" or "Mark inactive".
- **Team membership and shared staff sheets removed.** Every team has its own staff sheet. Removed: `MembershipService.gs`, the `_TEAM_MEMBERSHIP` schema, the import mode "Route by staff directory membership", the preview's routing table, the "Not a team member" flag, and the membership box and "Not a member" badge in the staff sidebar. *Setup / Configure Spreadsheet* gives a team that still shares a staff sheet its own copy (the team with the lowest Team ID keeps the original); nothing is deleted. Old `_TEAM_MEMBERSHIP` / `_SLACK_PAYLOADS` sheets are left unused and hidden.
- **Themes** (new): *Configure Display Settings → Theme* switches every dialog and sidebar between **Default**, **Sky** (bright blue, soft and rounded, pill buttons, Nunito) and **Ember** (bold red, high contrast, black table headers, Inter). Each theme is an optional file (`ThemeSky.html`, `ThemeEmber.html`) loaded after `Styles` and shows its own drawn mark at the top right of the dialog header (replace the `url(...)` in the theme file to show your own logo); a missing file falls back to the default look. The theme also styles every generated sheet (daily schedules, staff sheets, Dashboard): header, title, tab, stripe and flag colors plus the font (Arial / Nunito / Inter); changing it reformats them all at once. The separate HEADER_COLOR, HEADER_FONT_COLOR, BAND_COLOR, WARN_COLOR and ERROR_COLOR settings were removed (old values in `_CONFIG` are ignored). The Dashboard column "Net Hours" is now "Hours". `checkInstall` lists which theme files are present.
- **Import for all teams at once** (new): choose *All teams (find each employee in the staff sheets)* in the import. Each row goes to the team whose staff sheet lists the employee (by Employee ID, or by exact name ignoring case and extra spaces); that team's shift types then decide which rows are imported. Meetings follow the person.
- **Held back for review** (new): people not found in any staff sheet, found in several, or (for a one-team import) missing from that team's staff sheet are not imported. The preview lists them with a choice per person: a team, or Skip. "Skip all listed" and "Re-check" are next to the list. Nothing is guessed.
- **Web app, full version** (new):
  - **Schedule:** the day of one or several teams on the page (list or timeline, search, meetings, flags, headcount by hour).
  - **Dashboard:** every team's numbers; click a count to see those people.
  - **Person:** one person's week in every team.
  - **Staff:** search, add, edit and remove people, and add unknown employees.
  - **Links → See output:** what Slack reads, with copy buttons and the last generated time.
  - **Phones:** the layout fits a small screen.
  - **Speed:** each page arrives with its first data (prefetch, one round trip instead of two), settings are cached between calls for 5 minutes, Home no longer inspects every system sheet, and searches run in the browser.
  - **Same numbers everywhere:** the daily sheet, the Dashboard sheet and the web pages now share one calculation (`dayView_`).
  - New files: `WebDataService.gs`, `WebSchedule.html`, `WebDashboard.html`, `WebPerson.html`, `WebStaff.html`, `WebLinksOutput.html`.
- **Web app** (new, optional): deploy the script as a web app (see `docs/WEB_APP.md`) to use the tools in a browser tab: Home (teams with links to their sheets, last import, quick actions, maintenance), Import, Schedule, Teams, Staff, Monitoring Links, Settings, Import history, Staff fields, Employee IDs, Setup and Help. New files `WebApp.gs`, `WebShell.html` (navigation bar) and `WebHome.html`; every other page is the existing dialog file. It runs as the person opening it, so only editors of the spreadsheet can use it. *Maintenance → Open Web App* shows the link. Sheets (schedules, staff, Dashboard, Monitoring Links) open in a new tab. Locks now use the script lock, so operations from Sheets and from the web app wait for each other; the onEdit sheet index is kept in script properties too.
- **Agent lists** (new item kind in Monitoring Links, *+ Agent list*): the people working yesterday, today or tomorrow (whole day, now, at a time or during a window; chosen teams), as names or any staff column (e.g. a Slack ID), with a separator and text before/after each value (e.g. `<@` … `>`). Optionally leave out people who also work on another day: *today, not yesterday* = who to add to a channel; *yesterday, not today* = who to remove. Written to the sheet like a plan. Type `\n` as the separator for one value per line. *Leave out these roles* (Role column of the staff sheets, e.g. Shift Lead) removes people by role.
- **Windows past midnight**: in links, plans and agent lists, an *Until* earlier than *From* ends the next morning (e.g. 23:00 – 08:00 lists everyone working at any point during that night, including shifts starting after midnight).
- **"From previous day" shifts left out** of links, plans and agent lists: an overnight shift that started the day before (e.g. 22:00 – 06:00) is no longer listed for the next day, unless *Include shifts that started the day before* is ticked for that item.
- **Whole shift length with other shift types**: a piece of a person's shift whose shift type is not imported for the team (e.g. 08:40–13:00 Customer Support + Training 13:00–13:30 + 13:30–17:00 another type) still counts, so the shift shows as 08:40–17:00. A training or meeting row with no name (blank or "-") directly below a person belongs to that person.
- **Monitoring Links sheet: one-row layout** (new, default): A1 "Key" / A2 "DAILY", B1 "Header_Date" / B2 the date, then one column per item (its name in row 1, its link or plan text in row 2), so a Slack Workflow selects the row where Key = DAILY and uses every column as a variable. The texts and the date format are set under *Sheet layout…*; "one row per item" remains available.
- **Daily plan sections and extra text by time** (new): a plan has any number of **sections**, each with its own heading (or none) and one or more roles from the staff sheet's Role column (e.g. "🎧 Shift leads" = Support Shift Lead; "⭐ Seniors" = Senior Agent, Team Lead), then everyone else (optional, with its own heading), and roles to leave out. **Extra text by time** rules add text after the name, or at `{TAGS}`, when a shift works during part of a window, the whole window, starts before / at or after a time, or ends after a time. A section can be set to "No extra text" (e.g. shift leads), so the time rules skip its people. `{ROLE}` and `{TAGS}` placeholders. Plans saved with the earlier role settings are converted automatically.
- **Monitoring Links: Slack-readable sheet, daily list plans, reordering, trigger** (new): the "Monitoring Links" sheet now has its column names in row 1 (Name · Kind · Date · Updated · Count · Missing · Text · URL · URL 2 …) and one row per item in the saved order, so a Slack Workflow can look a row up by Name; URL cells are the plain link text and clickable. New item kind **Daily list plan**: lines from the schedule with a line format ({START} {END} {NAME} {TYPE} {TEAM} {ID} {EMPLOYEE_ID}; {ID} takes any staff column, e.g. a Slack ID for `<@{ID}>` mentions), shifts and/or meetings, optional grouping by team, written to the Text column. Items can be moved up/down. `generateMonitoringLinks()` rebuilds everything for a time-driven trigger you add yourself (Apps Script → Triggers); the code never creates triggers.
- **Monitoring Links** (new): *Schedule Management → Monitoring Links*. Each link has a base URL with `{IDS}` (or IDs appended at the end), the staff column holding the platform ID (Employee ID or any own column, e.g. "Aircall ID"), a separator, optional text before/after each ID, URL-encoding and a max number of IDs per link. People: working now, at a time, during a window or the whole day (overnight shifts count; optionally without people in a meeting at that time), for chosen teams or all. Preview in the dialog; "Generate all links" writes the themed "Monitoring Links" sheet with clickable links and who is missing an ID. URLs and settings live in the spreadsheet only, so nothing company-specific is in the repository.
- **Whole shifts around meetings** (new): Quinyx splits a shift around a meeting or training (e.g. 08:00–15:00, Training 15:00–16:00, 16:00–16:20). The import now joins the pieces into the real shift (08:00–16:20) for everyone (also people not yet in a staff sheet), when the gap is empty or fully covered by their meeting/training rows (types ticked as meeting types; joined even if meeting import is off). The meeting stays its own row; a meeting or training touching the start or end of a shift is part of it (e.g. 09:00–14:15 + Training 14:15–15:00 → shift 09:00–15:00). Pieces stored by an earlier import are replaced by the whole shift. Scheduled hours of the joined shift include the meeting time, so it is not flagged "Hours differ".
- **Import Employee IDs** (new): *Schedule Management → Import Employee IDs* (or "Import IDs…" in the staff sidebar) reads a Quinyx "Custom report" (A1 "Custom report", A2 "Badge no.", B2 the name) and fills in the Employee ID of each person found by name in any staff sheet ("First Last"; "Last, First" as a fallback). Preview first; existing different IDs are only replaced when "Replace existing IDs" is ticked; a badge already used by someone else, duplicate names or badges in the file, and names that are not unique in a staff sheet are refused. IDs are written as text (leading zeros kept).
- **Held people can go to any team**: in the review list every active team can be chosen, so rows of people who belong to other teams are filled into those teams' schedules in the same import. Teams whose staff sheet lists the person are marked "(in its staff sheet)", and "Use the staff-sheet team for N person(s)" applies those suggestions at once. "Skip the rest" skips only people without a decision.
- **Daily sheets show times as they are**: an overnight shift reads 22:00 – 06:00 without "(+1)" / "(-1)"; the Flags column still says "Overnight" or "From previous day".
- **Name matching is normal now**: the "Name match" flag in the daily view and the per-row "matched by name only" warnings were removed, because exports without Employee IDs are matched by name by design.
- **Own staff columns from the team dialog**: the Staff sheet step has "Add your own column". It creates a visible text column, ticks it for the team, and other teams can tick it too.

## 1.1.3 — Slack Workflow message (one combined row)

The logic of the earlier "daily plan" script (`daily_wf`), rebuilt on the normalized schedule data. Teams, roles, times, URLs and IDs are now settings, not code.

### What it produces

- **One row** in an output sheet (default `Slack Workflow`): headers in row 1, values in row 2. A Slack Workflow reads it with "Select a spreadsheet row", for example where `Key` = `DAILY`.
- **Column types:**

| Type | Value |
|---|---|
| Fixed text | Exactly what you type, e.g. `DAILY` |
| Date | The run date ± days, in any `Utilities.formatDate` format (e.g. `yyyy. MM. dd`) |
| Schedule list | One line per person, sorted by start time, e.g. `08:00 - 16:00 — @Ann Lee :aircall:` |
| Dashboard link | One URL with the identifiers of everyone who matches, e.g. `…users=1%2C2%2C3` or `…&userIds=1&userIds=2` |

- **Filters for lists and links:**
  - teams (none ticked = all active teams);
  - day (yesterday, today, tomorrow, up to ±7 days);
  - shifts, meetings or both;
  - activity types;
  - roles: everyone, only these roles, or everyone except them. Roles come from the team role in a shared directory, then the staff Role column, then the export;
  - inactive employees and people missing from the staff directory;
  - a time rule: works during part of a window, works across a time, starts before, starts at or after, or ends after. `24:30` means 00:30 the next day.
- **Lines:**
  - one line per person (earliest start to latest end, like the old script) or one per assignment;
  - an editable template with `{START_TIME} {END_TIME} {DISPLAY} {MENTION} {EMPLOYEE_NAME} {TEAM_NAME} {ACTIVITY} {ROLE} {TAG} {DATE}`;
  - a tag appended to lines that match their own time rule;
  - a text for "nobody matches".
- **Mentions:** `{MENTION}` is a real Slack mention (`<@U…>`) when the payload configuration names a staff field holding Slack user IDs and the person has one. Otherwise it falls back to the display value (`@Name`), which Slack shows as text only.
- **Links:**
  - text before each ID, between IDs and after each ID;
  - encoding;
  - each ID appears once;
  - people without an ID are left out and listed in a warning, never guessed.

### Mapping the old script

| Old `daily_wf` column | New column setting |
|---|---|
| NOR_SL / NOR_Agents / SWE_Agents / LUX_Agents | Schedule list; team; People = only / except "Shift Lead" |
| NOR_Aircall_Tag | Schedule list; except Shift Lead; Works across a time 14:00; line `{DISPLAY}` |
| NOR_Late_Shifts / NOR_Yesterday_Late_Shifts | Schedule list; Ends after 24:30; Day = today / yesterday; line `{DISPLAY}` |
| NOR_Tomorrow_Aircall_Agents | Schedule list; Day = tomorrow; Starts before 14:00; line `{DISPLAY}` |
| Meetings_Trainings | Schedule list; Include = meetings (add training types under Activity types); per assignment; line `… ({ACTIVITY})` |
| `:aircall:` suffix | Tag `:aircall:`, with a time rule |
| *_Converse / *_Aircall / *_Astra URLs | Dashboard link with `{IDS}`; identifier field = your Aircall/Converse/Astra staff field; separator `%2C` or prefix `&userIds=`; time filter (e.g. 08:00–14:00) and roles as needed |

### Running it

- **Manually:** *Slack Workflow Automation → Workflow Message (one row for Slack)*. Edit the columns, preview with a copy button per column, then **Save and write row**.
- **Daily:** add a time-driven trigger for `generateSlackWorkflowMessage` yourself (*Extensions → Apps Script → Triggers*). It uses the saved columns and today's date.
  - Schedule Manager still never creates triggers.
  - One function writes all columns, so a morning and an evening trigger can no longer overwrite each other's columns (the old P2/Q2 problem).

### Other changes

- New file `SlackMessageService.gs`.
- `SlackDialog.html` has a new first tab.
- `Main.gs`: new menu item; `checkInstall` now expects 21 script files.
- New configuration key `SLACK_MESSAGE_CONFIG`.
- **Upgrade:** 1.1.1 and 1.1.2 spreadsheets keep working without one. Until Setup runs, the key is read with its default; Setup then adds it ("Added 1 missing configuration key") and records 1.1.3. No team, staff or schedule data changes.

### Tests

| Suite | What it covers |
|---|---|
| Unit tests (5 new) | Merging and sorting, overnight shifts, every time rule, yesterday and tomorrow, roles, tags, mentions, links (join, prefix, encoding, one ID once, missing IDs), empty text, configuration errors |
| Mutation check | The new tests were run against a copy with three planted bugs (sorting, the "across a time" rule, duplicate IDs). All three were caught, after one test was added for the duplicate-ID case |
| Integration test (1 new) | Preview writes nothing; the row is written; an invalid configuration is refused; the trigger entry point uses the saved columns |
| Upgrade test | Scenario C now starts from 1.1.1 and from 1.1.2 |

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
