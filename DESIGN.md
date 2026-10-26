---
name: Schedule Manager
description: A dense mosaic of ruled modules that shows a team's whole day on one screen, in Sheets dialogs and the web app.
colors:
  utility-red: "#e60012"
  utility-red-deep: "#c2000f"
  utility-red-wash: "#fdeced"
  on-red: "#ffffff"
  ink: "#111111"
  ink-2: "#4a4a4a"
  ink-3: "#6b6b6b"
  ground-grey: "#f2f2f2"
  surface: "#ffffff"
  surface-2: "#f5f5f5"
  muted-fill: "#ebebeb"
  module-border: "#d6d6d6"
  border-strong: "#b3b3b3"
  inner-rule: "#e6e6e6"
  strip-grey: "#f2f2f2"
  ok-green: "#0b7a3e"
  ok-green-wash: "#e9f6ee"
  warn-amber: "#8a5300"
  warn-amber-wash: "#fff4d9"
  problem-red: "#c2000f"
  problem-red-wash: "#fdeced"
  meeting-purple: "#6a3d9a"
  meeting-purple-wash: "#f3edf9"
  disabled-fill: "#efefef"
  disabled-ink: "#8c8c8c"
  selection-pink: "#ffd5d9"
typography:
  title:
    fontFamily: "Barlow Semi Condensed, Arial Narrow, Noto Sans, sans-serif"
    fontSize: "24px"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "-0.01em"
  wordmark:
    fontFamily: "Barlow Semi Condensed, Arial Narrow, Noto Sans, sans-serif"
    fontSize: "19px"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "-0.01em"
  figure-stat:
    fontFamily: "Barlow Semi Condensed, Arial Narrow, Noto Sans, sans-serif"
    fontSize: "26px"
    fontWeight: 700
    lineHeight: 1.05
    letterSpacing: "-0.01em"
    fontFeature: "tnum"
  figure-row:
    fontFamily: "Barlow Semi Condensed, Arial Narrow, Noto Sans, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.25
    fontFeature: "tnum"
  module-title:
    fontFamily: "Noto Sans, -apple-system, Segoe UI, Roboto, Arial, sans-serif"
    fontSize: "14px"
    fontWeight: 700
    lineHeight: 1.3
  body:
    fontFamily: "Noto Sans, -apple-system, Segoe UI, Roboto, Arial, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Noto Sans, -apple-system, Segoe UI, Roboto, Arial, sans-serif"
    fontSize: "12.5px"
    fontWeight: 600
    lineHeight: 1.4
  small:
    fontFamily: "Noto Sans, -apple-system, Segoe UI, Roboto, Arial, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.3
  tag:
    fontFamily: "Noto Sans, -apple-system, Segoe UI, Roboto, Arial, sans-serif"
    fontSize: "11.5px"
    fontWeight: 600
    lineHeight: 1
rounded:
  radius-sm: "2px"
  radius: "2px"
  radius-lg: "3px"
spacing:
  s1: "4px"
  s2: "8px"
  s3: "12px"
  s4: "16px"
  s5: "24px"
  s6: "32px"
  gap: "8px"
  cell-y: "6px"
  cell-x: "10px"
  control-h: "32px"
  head-h: "36px"
components:
  button-primary:
    backgroundColor: "{colors.utility-red}"
    textColor: "{colors.on-red}"
    typography: "{typography.body}"
    rounded: "{rounded.radius}"
    padding: "0 14px"
    height: "{spacing.control-h}"
  button-primary-hover:
    backgroundColor: "{colors.utility-red-deep}"
    textColor: "{colors.on-red}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.radius}"
    padding: "0 14px"
    height: "{spacing.control-h}"
  button-secondary-hover:
    backgroundColor: "{colors.surface-2}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    padding: "0 14px"
    height: "{spacing.control-h}"
  button-danger:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.problem-red}"
    rounded: "{rounded.radius}"
    height: "{spacing.control-h}"
  button-small:
    padding: "0 10px"
    height: "26px"
  segment-pressed:
    backgroundColor: "{colors.utility-red}"
    textColor: "{colors.on-red}"
    rounded: "{rounded.radius}"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.radius}"
    padding: "0 10px"
    height: "{spacing.control-h}"
  module:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.radius}"
    padding: "12px 14px"
  module-head:
    backgroundColor: "{colors.strip-grey}"
    textColor: "{colors.ink}"
    typography: "{typography.module-title}"
    padding: "6px 14px"
    height: "{spacing.head-h}"
  count-tag:
    backgroundColor: "{colors.utility-red}"
    textColor: "{colors.on-red}"
    rounded: "{rounded.radius-sm}"
    padding: "0 6px"
    height: "20px"
  count-tag-quiet:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    height: "20px"
  tag-neutral:
    backgroundColor: "{colors.muted-fill}"
    textColor: "{colors.ink}"
    typography: "{typography.tag}"
    rounded: "{rounded.radius-sm}"
    padding: "0 6px"
    height: "20px"
  tag-problem:
    backgroundColor: "{colors.problem-red}"
    textColor: "{colors.on-red}"
    typography: "{typography.tag}"
    height: "20px"
  tag-shift:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.utility-red}"
    typography: "{typography.tag}"
    height: "20px"
  tag-dark:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.surface}"
    typography: "{typography.tag}"
    height: "20px"
  tag-meeting:
    backgroundColor: "{colors.meeting-purple-wash}"
    textColor: "{colors.meeting-purple}"
    typography: "{typography.tag}"
    height: "20px"
  table-header:
    backgroundColor: "{colors.strip-grey}"
    textColor: "{colors.ink}"
    typography: "{typography.small}"
    padding: "6px 10px"
  nav-link:
    textColor: "{colors.ink-2}"
    typography: "{typography.label}"
    padding: "0 12px"
    height: "40px"
  nav-link-current:
    textColor: "{colors.ink}"
---

# Design System: Schedule Manager

## Overview

**Creative North Star: "The Planner's Wall Chart"**

Every page is a packed wall of ruled modules, each with its own grey header strip, so a planner sees the whole day without scrolling between cards. The density is deliberate: 13px Noto Sans text, 32px controls, an 8px gap between modules, and a 12-column mosaic that packs modules side by side. Figures (times, counts, hours, headcount) are set in Barlow Semi Condensed bold with tabular numerals, so numbers read as numbers across the whole screen.

One utility red carries the system's voice: the main action in each module, the current page in the nav, the pressed segment, the count tag in each module header, and the peak hour. Everything else is ink on white modules set on a light grey ground. Depth comes from tone and a single 1px rule, never from shadows at rest. State is shown by form as well as hue: previous and next day shifts are dashed, meetings are hatched in purple, problems are filled red tags.

The same stylesheet serves narrow Sheets sidebars (~300px), dialogs, and full web pages. Sky and Ember are named themes that override tokens and a small set of shape traits; they keep their own recognisable character (rounded and pill shapes, their own faces) while the module mosaic underneath stays the same. The user rejected a neutral, airy "clean dashboard" look as too generic; big soft cards, KPI tiles and lots of white are not this system.

**Key Characteristics:**
- Light grey ground (`ground-grey`), white modules with a 1px border, grey header strips.
- One utility red for action, current place, counts, flags and peaks.
- Condensed bold figures with tabular numerals for every number and page title.
- Dense: 13px body, 32px controls, 8px module gap, 36px header strips.
- Flat at rest; tone steps and 1px rules do the separating.
- State by form and hue together: dashed, hatched, filled.

## Colors

A near-monochrome ink-and-grey field with one loud utility red and four quiet state colours.

### Primary
- **Utility Red** (`utility-red`): the primary button, the pressed segment, the current-page underline in the nav, the filled count tag in module headers, the peak column of the headcount chart, links, the current step, the focus border on inputs, the spinner arc, and the page-load bar. Also the header strip of a module in edit mode (Staff edit panel) and today's column on the Person week.
- **Deep Red** (`utility-red-deep`): hover for red buttons and links.
- **Red Wash** (`utility-red-wash`): selected list items, selected table rows, checked choice cards, the row being edited.

### Neutral
- **Ink** (`ink`): text, the default headcount cells, timeline bars, the dark tag, the focus ring outline.
- **Ink 2 / Ink 3** (`ink-2`, `ink-3`): secondary text, notes, hints, axis labels; ink 3 for placeholders, muted rows and carried-over shifts.
- **Ground Grey** (`ground-grey`): the page ground behind the mosaic on web pages and dialog bodies. Modules sit on it in white; the tone step is what separates them.
- **Surface** (`surface`): modules, tables, inputs, buttons, the web top bar and page header.
- **Surface 2 / Muted Fill** (`surface-2`, `muted-fill`): row hover, subtle modules, code boxes; neutral tags, ghost-button hover.
- **Strip Grey** (`strip-grey`): module header strips, table headers, disclosure summaries.
- **Module Border / Border Strong / Inner Rule** (`module-border`, `border-strong`, `inner-rule`): the 1px outline of every module and table; control outlines; the hairline between rows inside a module.

### State colours
- **OK Green** (`ok-green`, `ok-green-wash`): success alerts, the ok tag (green outline), good figures.
- **Warn Amber** (`warn-amber`, `warn-amber-wash`): warnings, rows that need attention.
- **Problem Red** (`problem-red`, `problem-red-wash`): errors, invalid fields, the filled problem tag, danger buttons, confirm panels. It is a darker red than the utility red so an error never reads as a primary action.
- **Meeting Purple** (`meeting-purple`, `meeting-purple-wash`): meetings everywhere: hatched timeline bars, the hatched marker before a meeting's time, meeting rows and tags.

### Theme overrides
Themes replace these tokens only. **Sky** sets a sky-blue primary (#0079b8, accent #009de0), a blue-grey ground (#f1f6f9) and pale blue header strips (#eaf5fb). **Ember** sets a bold red primary (#d91500), a black shell and black module strips (#141414 with white text), and a 4px red line under the top bar.

### Named Rules
**The One Red Rule.** Utility red marks only action, current place, counts, flags and peaks. In a module there is at most one red button; if a second action needs weight, it is a secondary button.

**The Tone Step Rule.** Modules are white on the grey ground. Never set a module on white or a grey module on grey; the step between ground and module is the separator, the 1px border confirms it.

**The State Pairs Rule.** The four state colours (green ok, amber warn, purple meeting, red problem) live beside the utility red and are never used decoratively. Each always comes with text or form (a tag label, a dash, a hatch), so colour is never the only signal.

## Typography

**Display Font:** Barlow Semi Condensed (with Arial Narrow, Noto Sans)
**Body Font:** Noto Sans (with -apple-system, Segoe UI, Roboto, Arial)
**Label/Mono Font:** system monospace (ui-monospace, SFMono-Regular, Consolas) for links and codes only

**Character:** A plain, legible workhorse for words and a condensed, bold face for numbers and titles, so a scan across the mosaic lands on figures first.

### Hierarchy
- **Title** (700, 24px, 1.1): page titles and dialog titles; 20px in sidebars.
- **Wordmark** (700, 19px, 1): the product name in the web top bar.
- **Figure, stat** (700, 26px, 1.05, tabular): summary figures in the stat strip. Home's single big figure uses 40px.
- **Figure, row** (600 to 700, 13 to 15px, tabular): shift times, hours, counts in team rows, headcount labels (11px).
- **Module title** (700, 14px, 1.3): the heading in each module header strip.
- **Body** (400, 13px, 1.5): everything else; tables use 12.5px.
- **Label** (600, 12.5px): form labels, nav links and tabs (600, 13px).
- **Small / Tag** (12px; 600 at 11.5px): hints, notes, meta lines, table headers; tags.

Sky sets both roles in Nunito (800 for titles and figures); Ember sets both in Inter (800, tighter tracking). The ramp stays the same.

### Named Rules
**The Figures Are Condensed Rule.** Every number a planner reads (times, counts, hours, headcount, step numbers) is set in the figure face with tabular numerals. Words never use the figure face except page titles and the wordmark.

**The Sentence Case Rule.** Titles, labels and buttons are sentence case. No uppercase labels, no letter-spaced small caps.

## Layout

The web page is a centred column at most 1180px wide (`--web-max`), with full-width bars. Under the two-tier top bar comes a white page header (title, one-line subtitle, actions on the right) and then the body on the grey ground.

Content is a 12-column mosaic with an 8px gap; modules span 3 to 12 columns. Below 900px, 3 to 5 column modules take half the width and wider ones take the full row; below 620px every module is full width, side padding drops to 12 to 14px, and the page subtitle hides. Schedule uses a 232px left control rail (day, view, teams, flags) beside the content; under 900px the rail dissolves and its modules reorder around the schedule (day and view first, teams last).

Spacing steps are 4, 8, 12, 16, 24 and 32px. Modules pad 12px by 14px; table cells 6px by 10px; fields sit 12px apart. Lists of facts, choices and check grids use auto-fit columns (110 to 190px minimum) rather than fixed layouts. Wide tables scroll inside their box; the page never scrolls sideways.

### Named Rules
**The Whole Day Rule.** Pack modules edge to edge on the mosaic so the job's modules are visible at once. Use the 8px module gap, not larger gutters, and do not centre a few big cards in white space.

## Elevation & Depth

Flat by default. Modules, tables, the stat strip and the top bar have no shadow (`--shadow: none`); depth is the tone step from grey ground to white module plus a 1px border. Inset box-shadows are used as rules, not as depth: the 3px underline on nav links and tabs, the 1px dividers between stats, the outline of a quiet count tag. Only floating layers lift.

### Shadow Vocabulary
- **Float** (`box-shadow: 0 6px 20px rgba(0, 0, 0, .14)`): the loading box and tooltips, things that float above the page.
- **Focus ring** (`box-shadow: 0 0 0 2px #ffffff, 0 0 0 4px #111111`): keyboard focus on buttons, links, tabs and list items. Sky uses a 3px sky-blue halo, Ember a red outer ring.

### Named Rules
**The Flat At Rest Rule.** Nothing on the page casts a shadow at rest. A shadow means the layer floats (loading, tooltip) or has focus.

## Shapes

Default corners are nearly square: 2px for modules, buttons, inputs and tags, 3px at most. Rectangles with one rule weight (1px) everywhere, inside and out. Segmented controls and button groups join flush with shared borders. The only round forms are the switch, the spinner, and the tooltip trigger.

Themes change this on purpose: Sky rounds modules (14px), inputs (6px) and makes buttons, segments, tags and count tags pills, with a pill search field; Ember uses 4 to 6px corners, pill buttons, segments, tags and count tags, and 1.5px control borders.

### Named Rules
**The One Rule Weight Rule.** In the default theme every border and divider is 1px; emphasis comes from colour (red border for edit and today, error border for confirm), not from thicker lines.

## Components

### Buttons
Compact, rectangular, and decisive.
- **Shape:** near-square (2px), 32px tall, 14px side padding; small buttons 26px tall with 10px padding.
- **Primary:** utility red fill, white 600 text. One per module.
- **Secondary:** white with a strong grey outline; hover fills surface 2 and darkens the outline.
- **Ghost:** no fill or border, underlined text with a grey underline that turns ink on hover.
- **Danger:** problem red text and wash-red outline; solid danger for the final confirm.
- **Hover / Focus / Active:** 120ms colour transitions; pressing nudges the button down 1px; keyboard focus shows the double ring.
- **Icon buttons:** square (32 or 26px) with a 13 to 14px line icon.

### Segmented control
A row of joined small buttons; the pressed segment fills utility red. Used for view switches (List / Timeline).

### Chips (tags)
- **Style:** 20px tall rectangles with 11.5px 600 text. Variants: neutral grey fill, ok (green outline), warn (amber wash), problem (filled red), meeting (purple wash), shift (red outline), dark (black fill), info (ink outline).
- **State:** tags carry a word, so colour is never the only signal. Flag kinds are buttons whose tag dims slightly on hover.

### Count tag (signature)
The filled red figure in a module header (shifts, flags, items, peak). Condensed bold 13px, 20px tall, at least 22px wide. The quiet variant (white with a grey inset outline) shows when the count is zero.

### Cards / Containers (modules)
- **Corner Style:** 2px.
- **Background:** white on the grey ground; subtle modules use surface 2.
- **Shadow Strategy:** none (see Elevation & Depth).
- **Border:** 1px module border; red for a module being edited.
- **Header strip:** 36px tall, strip-grey fill, 1px bottom rule, title then count tag, notes and actions pushed right. Flush modules hold a table or stat strip edge to edge.
- **Internal Padding:** 12px by 14px.

### Stat strip
Figures in one ruled strip, auto-fit cells at least 110px wide, separated by 1px inner rules. The label sits above a 26px condensed figure; good, warn, bad and meeting figures take their state colour.

### Inputs / Fields
- **Style:** 32px, white, 1px strong grey outline, 2px corners, 10px side padding; labels 12.5px 600 above.
- **Focus:** border turns utility red with a 1px red halo.
- **Error / Disabled:** problem red border and halo plus a 600 red message under the field; disabled fields use the disabled fill and ink.
- Checkboxes, radios and switches use the utility red when checked. Choice cards outline red and fill red wash when checked.

### Tables
Sticky strip-grey header in 12px 600, 6px by 10px cells, inner rules between rows, surface 2 on row hover, right-aligned tabular numbers. Rows needing attention take the amber wash; selected rows the red wash. Tables live inside a bordered box that scrolls.

### Navigation
- **Web top bar:** two tiers on the shell colour (white by default). Top row: a 26px red square mark with three white lines, the wordmark, and an outlined "Open spreadsheet" link on the right. Second row: page links, 40px tall, 600 13px in ink 2.
- **States:** hover darkens the text and shows a 3px grey underline; the current page is ink with a 3px utility red underline.
- **Mobile:** the links scroll sideways in one row with a fade at the right edge; the spreadsheet link drops its label.
- **Tabs** inside pages follow the same underline model. **Stepper** steps use 20px square numbers: done steps black, the current one red.
- Ember sets the shell black with white text and a 4px red base line; Sky colours the mark and current underline sky blue.

### Headcount by hour (signature)
Whole-cell columns: one small block per person (or per n people when the peak is high), stacked bottom up, with the count in condensed figures above each column and an ink baseline with every third hour labelled. Cells are ink; the peak hour turns utility red. On the Dashboard the same idea appears as a 96px sparkline.

### Shift rows and timeline
Shift times in 14px condensed figures at the start of each row. Previous or next day shifts are greyed with a dashed underline (dashed outline on the timeline); meetings have a purple wash and a small hatched marker (hatched purple bar on the timeline). Timeline bars are ink on a surface 2 track.

### Alerts and empty states
Alerts are ruled boxes in a state wash with a small square state icon (drawn line icon in white on the state colour), a bold title, and a body. Empty states centre a 28px line icon, a bold title and one sentence saying what to do next.

### Icons
A small set of drawn line icons on a 24px grid, 2px stroke, round caps (check, alert, cross, info, grid, search, person, people, link, list, download, plus, external, car), always inline SVG in the current text colour.

## Do's and Don'ts

### Do:
- **Do** set the page on the grey ground (`ground-grey`) and every module on white with a 1px `module-border`; let the tone step separate modules.
- **Do** give every module a 36px grey header strip with a 14px bold title and, when it holds a countable list, a filled red count tag.
- **Do** set every time, count and hour in Barlow Semi Condensed bold with tabular numerals.
- **Do** keep one red primary button per module; everything else is secondary or ghost.
- **Do** show state with form and a word as well as colour: dashed for carried-over shifts, hatched purple for meetings, filled red tags for problems.
- **Do** keep theme files to token overrides plus their own recognisable traits (Sky: rounded modules, pill buttons, Nunito; Ember: pill buttons, Inter, black shell and module strips).
- **Do** use the drawn line icons from the shared set, inline SVG at 13 to 14px in buttons.

### Don't:
- **Don't** build the airy SaaS dashboard: big soft cards, KPI tiles, lots of white, large gutters.
- **Don't** add shadows to modules, tables or the top bar at rest; only floating layers (loading box, tooltip) use the float shadow.
- **Don't** use the utility red for decoration, headings or large fills beyond the header strip of a module in edit mode or today's day column.
- **Don't** use the state colours (green, amber, purple, problem red) for anything other than their state.
- **Don't** add uppercase or letter-spaced labels above titles; titles and labels are sentence case and stand alone.
- **Don't** use text glyphs or emoji as icons; map them to the drawn line icons.
