# Roster Manager

A personal iPad web app (PWA) to capture the Virgin Australia roster from Sabre (CIA), review it, sync it to Google Calendar, and back it up to Google Drive. No server, no App Store, no fees.

**Flow:** open app → confirm the 28-day period → Open Sabre → tap the *Capture Roster* bookmark → Copy → Import → review → Confirm → Compare with calendar → approve → Apply. The Drive backup runs automatically.

## Status

| Part | State |
|---|---|
| 28-day period selection, validation, history | Done |
| Capture bookmarklet (username fill on login pages, roster snapshot, Copy) | Done (tested on mock pages) |
| Review / edit / add / delete duties, raw page viewer | Done |
| Google Calendar sync: create, update changed, approve removals, no duplicates | Done (tested against a simulated Google API) |
| Google Drive: folder structure, history-keeping backups, restore | Done (tested against a simulated Google API) |
| Offline access, backup to/restore from file | Done |
| **Sabre roster parser** | **Not yet.** Needs one real capture of the roster page. Until then duties can be entered by hand. |

## One-time setup

### 1. Host the app (free, GitHub Pages)
1. Create a GitHub account if you don't have one, then a **new public repository** named `roster-manager`. No roster data or secrets ever go in the repo.
2. Upload every file in this folder (keep the folder structure). The `tests/` and `bookmarklet/` folders are optional.
3. Repo → **Settings → Pages** → Source: *Deploy from a branch*, Branch: `main` / root → Save.
4. After a minute the app is live at `https://<your-username>.github.io/roster-manager/`.

### 2. Google Cloud project (about 10 minutes, free)
1. Go to <https://console.cloud.google.com/>, create a project called *Roster Manager*.
2. **APIs & Services → Library**: enable **Google Calendar API** and **Google Drive API**.
3. **Google Auth Platform → Branding / Audience**: User type **External**, app name *Roster Manager*, your Gmail as support and developer contact. Under **Audience → Test users**, add your own Gmail address. Leaving it in *Testing* is fine: this app doesn't use refresh tokens, so the 7-day refresh-token limit doesn't apply.
4. **Data access → Add scopes**: add `.../auth/calendar.app.created` and `.../auth/drive.file`.
5. **Clients → Create client → Web application**:
   - Authorised JavaScript origins: `https://<your-username>.github.io`
   - Authorised redirect URIs: `https://<your-username>.github.io/roster-manager/`

   The app shows the exact values under Settings → Google account.
6. Copy the **Client ID** (`…apps.googleusercontent.com`). No client secret is needed.

Google will show "Google hasn't verified this app" on sign-in. That's expected for a personal app: tap *Continue*.

### 3. Install on the iPad
1. In **Safari**, open your GitHub Pages address → Share → **Add to Home Screen**.
2. Open the app from the home screen → **Settings**:
   - Paste the Client ID → Save → **Sign in to Google**. Tick both permission boxes.
   - Check the Sabre URL, Microsoft email and Sabre User ID.
3. Settings → **Install Capture bookmark** (opens in Safari) → follow the 4 steps on that page.

### 4. Passwords
Log in to Sabre once in Safari and tap **Save Password** for the Microsoft and Sabre logins. Safari's Passwords (iCloud Keychain) keeps them encrypted behind Face ID and offers to update them when they rotate. The app never stores passwords. iPadOS only allows Safari itself to fill another site's login form.

## Using it
- **Capture:** Capture tab → check the dates → *Open Sabre* → log in → open the roster → tap the **Capture Roster** favourite → **Copy** → back to the app → **Import from clipboard**.
- **Review:** problems show in red and block confirming. Tap any duty to fix it. *View captured page* shows exactly what was captured.
- **Sync:** *Compare with calendar* shows new / changed / unchanged / no-longer-on-roster. Removals are unticked by default; tick the ones you want deleted. Re-running after a failure only does what's left.
- The app only writes to the calendar it created (*VA Roster*). Google enforces that via the `calendar.app.created` permission, so your other calendars can't be touched. In Drive it can only see the files it created (`drive.file`).
- Each Google sign-in lasts about an hour, after which Sync asks you to sign in again (usually one tap).

## Design rules the app follows
- Sabre is only opened when you tap *Open Sabre*. There's no background access, polling or retries.
- The "last capture" reference only moves when a reviewed roster is confirmed.
- Times keep their basis (`local` at a named airport, or `UTC`). Both are shown in event descriptions; nothing missing is invented. Unknown airports must be added under Settings → Airport time zones.
- Drive files are never overwritten: each sync writes new, timestamped files.
- Backups exclude passwords and Google tokens (there are none to include).

## Files
```
index.html, styles.css, manifest.webmanifest, sw.js   app shell + offline cache
bookmarklet.html                                      bookmark installer page
js/app.js        screens & flow           js/db.js      on-device storage (IndexedDB)
js/dates.js      28-day periods           js/tz.js      airport time zones
js/model.js      duty model & keys        js/parser.js  Sabre parser (to be written)
js/events.js     calendar event + diff    js/google.js  Google sign-in, Calendar, Drive
bookmarklet/capture.src.js                bookmarklet source (rebuild: see build.mjs)
tests/core.test.mjs                       node --test tests/core.test.mjs
```
After changing files, bump `VERSION` in `sw.js` so the iPad picks up the update.
