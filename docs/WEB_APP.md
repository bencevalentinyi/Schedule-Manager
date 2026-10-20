# Web app

The web app shows the Schedule Manager tools in a normal browser tab, so you don't have to open the spreadsheet for them: import, the schedule viewer, teams, staff, Monitoring Links, settings, import history and maintenance. The data stays in the spreadsheet. Daily schedules, staff sheets and the Dashboard are still sheets, and the pages link to them ("Open … in Google Sheets ↗").

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
| Schedule Viewer shows the rows in the sheet | Shows the summary; *Open schedule in Sheets ↗* shows the rows |
| Maintenance menu | Home → Maintenance |
| Undo Last Import | Import history → Undo |

Operations from the web app and from Sheets wait for each other (one lock for both), so an import in one never runs at the same time as an import in the other.

## Pages

`…/exec?page=` plus one of: `home`, `import`, `schedule`, `teams`, `team` (`&teamId=…` to edit one), `staff`, `links`, `settings`, `history`, `fields`, `ids`, `setup`, `help`. Before setup, every page opens Setup.

To add a page: add an entry to `WEB_PAGES` in `WebApp.gs`, giving its file and title (and `nav` to show it in the bar).
