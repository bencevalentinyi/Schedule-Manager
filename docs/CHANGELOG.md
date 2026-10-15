# Changelog

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
