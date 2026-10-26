# Web app

The web app shows Schedule Manager in a normal browser tab, so day-to-day work doesn't need the spreadsheet. The data stays in the spreadsheet, and every number is calculated the same way as in the sheets.

| Page | What it does |
|---|---|
| **Home** | Teams, last import, quick actions, maintenance |
| **Schedule** | Everyone working on a day: one or several teams, list or timeline, search, meetings and flags, headcount by hour. Click a name to open the person. |
| **Dashboard** | Every team's day in numbers (shifts, staff, hours, peak, overlaps, unknown employees), headcount for all teams, recent imports. Click a number to see those people. |
| **Person** | One person's week (Monday–Sunday) in every team, with daily hours and their staff-sheet details |
| **Staff** | A team's staff sheet as a table: instant search, add, edit, remove, and "Find unknown employees" (people in the schedule but not in the staff sheet) |
| **Import**, **Teams**, **Links**, **Settings** | The same tools as the Sheets menu |
| **Links → See output** | What the Monitoring Links sheet holds now (what Slack reads), with copy buttons and the last generated time |

The daily sheets, staff sheets and the Dashboard sheet still exist and stay up to date. Every page links to its sheet ("Open in Sheets ↗").

## Tab icon

The browser tab shows the active theme's icon (Display Settings → Theme):
- **Default:** `assets/favicons/default.png`
- **Sky:** `assets/favicons/sky.png`
- **Ember:** `assets/favicons/ember.png`

Apps Script can only use an icon from a web address, so these are loaded from the repository on GitHub. The first line of a theme file names its icon: `<meta name="sm-favicon" content="https://…">`. Change that address to use your own.

## Speed

- **Loading screen when the web app is opened** (a bookmark, the link from Sheets, a reload): a light page with the top bar and a loading screen comes first, built without opening the spreadsheet (`WebLoading.html`). It then asks for the real page (`apiWebPage`) and puts it in place. Links inside the web app carry `nav=1` and skip it, so moving between pages stays one round trip.
- **One round trip per page.** The data a page needs when it opens is fetched while the page is built and sent with it, so the page doesn't have to ask the server again (`prefetch` in `WEB_PAGES`).
- **Fewer slow calls per page:** each distinct date in `_SCHEDULE_DATA` is converted once instead of once per row, sheets are looked up by ID from a map built once per run, and the time zone and theme file are read once.
- **Timings in the log:** every page writes `Web page "<page>": N ms, of which page data M ms` to Apps Script → Executions, so you can see which page is slow and whether the time goes to its data.
- **Settings are cached** for 5 minutes between calls (script cache), instead of reading `_CONFIG` every time. Saving settings, setup, or editing `_CONFIG` by hand clears the cache.
- **One read of the schedule per page:** all chosen teams and days at once, and only the matching rows.
- **Search on the page:** Schedule and Staff filter in the browser as you type, with no server call.
- **Instant feedback:** a progress bar appears as soon as you click a link.

What still takes time is Google itself: each page opening runs the script once (usually 1–3 seconds), and the first run after a while is slower. Before the loading screen appears there is still a short blank moment while Google starts the script; no code in the project can show anything earlier.

## Deploy (once)

1. Open the spreadsheet once, so the script remembers it. Any **Schedule Manager** menu item does this; **Maintenance → Open Web App** is a good one.
2. In the Apps Script editor, click **Deploy → New deployment**.
3. Click the gear next to *Select type* and choose **Web app**.
4. Set:
   - **Description**: e.g. `Schedule Manager`
   - **Execute as**: **User accessing the web app**
   - **Who has access**: **Anyone with a Google account**, or your organisation's domain
5. Click **Deploy**, allow the permissions, and copy the **Web app URL** (it ends in `/exec`).

Later, **Maintenance → Open Web App** in the spreadsheet shows the same link.

## Who can use it

The web app runs as the person who opens it. So only people who can **edit the spreadsheet** can use it. Everyone else sees "You have no access to the schedule spreadsheet". To give someone access, share the spreadsheet with them as an editor. Each person allows the permissions once, the first time they open it.

## After updating the code

A deployment keeps the code version it was created with. After pasting new files into Apps Script:

1. Click **Deploy → Manage deployments**.
2. Select the web app and click **Edit** (pencil).
3. Under **Version**, choose **New version**, then click **Deploy**.

The URL stays the same. **Deploy → Test deployments** gives a `/dev` URL that always runs the latest saved code; it's useful for trying changes before you deploy a new version.

## What is different from the Sheets menu

| In Sheets | In the web app |
|---|---|
| Close / Cancel | Goes back to the page it came from (or Home) |
| "Open sheet", schedule and staff links | Opens the sheet in a new tab |
| Schedule Viewer renders the team's sheet | **Schedule** shows the day on the page; the sheet viewer is still under Home → More tools |
| Delete a staff row in the sheet | **Staff → Edit → Remove from staff sheet** |
| Maintenance menu | Home → Maintenance |
| Undo Last Import | Import history → Undo |

Operations from the web app and from Sheets wait for each other (one lock for both), so an import in one never runs at the same time as an import in the other.

## Pages

`…/exec?page=` plus one of:

- `home`
- `schedule`, with `&date=yyyy-MM-dd`, `&teams=TEAM_001,TEAM_002`, `&flag=Overlap` and `&q=search text` as options
- `dashboard`, with `&date=` as an option
- `person`, with `&key=ID:1234` (or `NM:Name`) and `&week=` as an option
- `staff`, with `&teamId=` and `&q=` as options
- `import`, `teams`, `team` (`&teamId=…` to edit one), `links`, `output`, `settings`, `history`, `fields`, `ids`
- `viewer` (the sheet Schedule Viewer), `directory` (the staff sidebar), `setup`, `help`

Schedule, Dashboard, Person and Staff keep their date/team in the address, so you can bookmark a view. Before setup, every page opens Setup.

To add a page: add an entry to `WEB_PAGES` in `WebApp.gs` with its file and title, `nav` to show it in the bar, and `prefetch` for the API calls it makes when it opens.
