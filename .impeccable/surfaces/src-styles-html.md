---
version: 1
slug: "src-styles-html"
primary_target: "src/Styles.html"
related_targets: ["src/WebShell.html"]
---

Scope: the whole Schedule Manager UI (web app pages, Sheets dialogs and sidebars) through the shared stylesheet, the web shell, and page layouts; Default, Sky and Ember themes. Mode: Operate.

Audience and job: planners at a desk and team leads on a phone; read a day's coverage fast, import, fix staff data. Constraints: Apps Script HtmlService, no build step, one shared Styles.html, tests/run-ui-checks.js must pass.

## Direction contract

THESIS: A high-density module mosaic: every page is a packed grid of ruled modules, each with its own header strip, so a planner sees the whole day on one screen. Refuses the airy SaaS card dashboard (big soft cards, KPI tiles, lots of white).

OWN-WORLD: White ground, ink #111, one utility red #e60012 for the primary action, the active nav tab, counts and flags; light grey #f2f2f2 header strips and fills; 1px #d6d6d6 module borders, 2px corners, no shadows at rest. Noto Sans for text at 13px; Barlow Semi Condensed bold for figures and page titles. Segmented controls with a filled red active segment; rectangular tags (filled red, red outline, grey fill, black fill).

STORY: The planner opens a page, sees every module the job needs at once, reads numbers in condensed figures, and acts with one red button per module.

FIRST VIEWPORT: Two-tier white header: wordmark and spreadsheet link, then a nav row with a red underline on the current page. Page title row (24px condensed title, date/context, actions right). Below, a 12-column mosaic of modules: on Schedule a left control rail (day, teams, show) and team modules with time-tabular shift rows, an overview strip, flags and headcount by hour.

FORM: Challenger "Japanese contemporary high-density web" (catalog japanese-high-density-web), chosen by the user over the assigned T-card board. seed:351b3b3696ef857c

Signature move: every module header carries a filled red count tag (shifts, flags, items) so totals read across the mosaic at a glance; headcount by hour drawn as whole-cell columns. Raised from declined challengers: state by form not hue alone (previous/next-day shifts dashed, meetings hatched); one rule weight everywhere.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
