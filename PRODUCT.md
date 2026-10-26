# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Workforce planners and team leads who run Quinyx-scheduled teams. Two equal situations:
- At a desk (laptop or monitor): importing the Quinyx "Daily Schedule" export, checking coverage for a day, fixing staff data, generating monitoring links.
- On the floor (phone or tablet): a quick look at who is working now, a person's week, headcount by hour.

## Product Purpose

Schedule Manager is a Google Sheets template with an Apps Script web app. It imports Quinyx schedule exports, stores every shift and meeting once, and shows each team's day, staff sheet and an all-teams dashboard, in Sheets and in a browser tab. Success: the day's schedule is correct, readable at a glance, and day-to-day work no longer needs the spreadsheet open.

## Positioning

It sits on the team's own spreadsheet: every number is calculated the same way as in the sheets, every page links to its sheet, and nothing lives outside the spreadsheet the team already owns.

## Operating Context

- Daily ritual: import the Quinyx export, check today's schedule per team, look at headcount by hour and flags (unknown employees, overlaps, meetings in shifts), drill into a person.
- Each web page is a full server round trip (Apps Script, 1–3 s); pages must feel immediate once loaded.
- The same stylesheet serves Sheets dialogs and sidebars (narrow, ~300 px) and the web app pages.

## Capabilities and Constraints

- Pages: Home, Schedule (list/timeline, multi-team, search, headcount by hour), Dashboard, Person (week), Staff (table, add/edit/remove, find unknown employees), Import, Teams, Links (+ output), Settings, Setup, History, Taxi (extension).
- Plain HTML/CSS/JS in Apps Script HtmlService templates (`<?!= include() ?>`); no build step, no framework. One shared stylesheet (`src/Styles.html`) plus client helpers (`src/ClientCore.html`).
- Display Settings → Theme offers Default, Sky and Ember; theme files only override the base. Each theme names its browser-tab icon in its first line.
- External resources: Google Fonts stylesheets are allowed (themes already use them).
- `tests/run-ui-checks.js` statically checks every page (ids, handlers, labels, includes).

## Brand Commitments

- Name: Schedule Manager. No logo beyond the theme favicons in `assets/favicons/`.
- Sky (bright sky blue, soft, rounded) and Ember (bold red, high contrast) are named themes users can choose; they stay recognisable as those colours.
- Plain, direct English UI copy in sentence case.
- The user rejected a neutral "clean dashboard" refresh (2026-10-26) as too generic and bland.

## Evidence on Hand

- Real content: Quinyx shift data, teams, staff fields, meetings, flags. Sample: `samples/sample-schedule.csv`.
- No customer quotes, metrics or logos; none may be invented.

## Product Principles

- The schedule is the product: the day's shifts must read faster than the spreadsheet does.
- Same numbers as the sheets, always; the page never invents or rounds differently.
- Works at a desk and on a phone equally.
- Every page tells you what to do next, including empty and error states.

## Accessibility & Inclusion

Keyboard operable, visible focus, labelled controls (enforced by `tests/run-ui-checks.js`), reduced motion respected, readable contrast in every theme.
