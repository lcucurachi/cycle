# Cycle – private period tracker

A period tracker that runs entirely in the browser. No account, no server: all data stays on the phone (IndexedDB), and it can be installed to the home screen and used offline.

## Features
- Log period start/end from the Today screen or by tapping days in the calendar
- Forecast of the next period with a likely range, late-period handling, optional fertile window
- Detects probable forgotten logs (cycles about twice the usual length) and asks about them
- "Add to calendar": one repeating event with a reminder
  - **iPhone**: opens an `.ics` calendar file → *Add to Calendar*
  - **Android**: opens the default calendar app pre-filled (falls back to a Google Calendar link)
  - Settings → *Other ways to add* lists every method, for testing
- Backup export/import (JSON)

## How the prediction works
See the comment at the top of [`js/predict.js`](js/predict.js). In short: median of the last 6 cycles, blended with the user's "typical cycle" setting (default 29 days) while few cycles are logged; the range comes from how much cycles vary; cycles under 15 days, about double the usual, or over 90 days are left out. Based on [Bull et al. 2019](https://pmc.ncbi.nlm.nih.gov/articles/PMC6710244), [Li et al. 2021](https://pmc.ncbi.nlm.nih.gov/articles/PMC8714275) and Apple's Cycle Tracking.

## Files
| Path | What it is |
|---|---|
| `index.html` | The page |
| `css/styles.css` | Styling (light + dark) |
| `js/app.js` | Screens and buttons |
| `js/predict.js` | Prediction logic |
| `js/calendar.js` | Add-to-calendar (.ics, Android, Google link) |
| `js/storage.js` | Saving data on the phone, backup |
| `js/dates.js` | Date helpers |
| `js/config.js` | Reads `app-id` / `app-version` from `index.html` |
| `sw.js`, `manifest.webmanifest`, `icons/` | Installable app + offline |
| `tests/index.html` | Automated tests – open in a browser |

## Run locally
```powershell
python -m http.server 8765
```
Then open http://localhost:8765 (app) and http://localhost:8765/tests/ (tests).

## Publish on GitHub Pages
1. Create a new GitHub repository and push this folder to its `main` branch.
2. In the repository: **Settings → Pages → Source: Deploy from a branch → `main` / `(root)`** → Save.
3. After a minute the app is at `https://<your-user>.github.io/<repo-name>/`.

### App settings at the top of `index.html`
| Setting | What it does |
|---|---|
| `app-version` | Change it when you publish an update (e.g. `1.0.1`). Shown in Settings → About; makes installed phones drop their offline copy and download the new files (visible from the second launch after the update). |
| `app-id` | Prefix for everything the app stores in the browser (database, offline copy), so other apps on the same address don't clash. Set it once before publishing; changing it later means users start with empty data. |

If you add a new file, also add it to the `ASSETS` list in `sw.js`.

### Security notes
- **Use a dedicated GitHub account/organization (or a custom domain) for this app.** All Pages sites of one account share the address `https://<user>.github.io`, and the browser treats them as one site: another of your Pages sites could read this app's data. The `app-id` prefix prevents accidental clashes, not deliberate reading.
- The page only runs scripts from its own site (Content-Security-Policy) and doesn't send its address to sites it links to (`no-referrer`).
- Backup files are checked on import: unknown or invalid values are dropped.

## Install on a phone
- **iPhone (Safari)**: Share → *Add to Home Screen*. Important: this also protects the data from Safari's automatic cleanup of sites not visited for 7 days.
- **Android (Chrome)**: menu ⋮ → *Install app* / *Add to Home screen*.

## Testing checklist for the calendar
| Phone | Try | Expected |
|---|---|---|
| iPhone, Safari | Add to calendar | Event preview with *Add All* / *Add to Calendar* |
| iPhone, home-screen app | Add to calendar | Same; if nothing happens, try *Other ways → Share .ics file* or *Download .ics file* |
| Android, Chrome | Add to calendar | Calendar app opens a new event, repeating every N days |
| Android | Other ways → Google Calendar link | Google Calendar new-event page |
| Android, Samsung Calendar | Other ways → Download .ics file | Open the file → import |

## Disclaimer
Estimates only. Not a medical device and not contraception.
