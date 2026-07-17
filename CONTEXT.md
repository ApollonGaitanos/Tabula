# Tabula — Manual Tab Sync for Chrome

Build a complete, working Chrome extension in this folder. Read this entire spec before writing any code.

## What it is

Tabula lets a user keep one or more "master" tab lists stored in a **private GitHub Gist** and intentionally sync their current Chrome session against them. Nothing is automatic — every sync action is an explicit button press. This is deliberate: the user controls exactly when state moves in which direction.

## Hard constraints

- **Chrome only, Manifest V3.** No Firefox code paths, no polyfills.
- **No build step, no dependencies, no frameworks.** Vanilla JS, plain HTML/CSS. No npm, no bundler, no CDN scripts. Everything self-contained (Chrome Web Store forbids remotely hosted code).
- **No background service worker.** All logic lives in `popup.js` and `settings.js`. There is nothing to do in the background — no polling, no listeners, no alarms.
- **Storage backend:** GitHub Gist API (`https://api.github.com`), authenticated with a user-supplied Personal Access Token (classic, `gist` scope).
- **Version:** `1.0.0`. **No `key` field** in the manifest — the Web Store assigns the extension ID.

## Permissions (keep minimal — this ships to the Chrome Web Store)

```json
"permissions": ["tabs", "tabGroups", "storage"],
"host_permissions": ["https://api.github.com/*"]
```

Nothing else. No `<all_urls>`, no `activeTab`, no scripting.

## Files

```
tabula/
  manifest.json
  popup.html
  popup.js
  popup.css
  settings.html
  settings.js
  settings.css
  icons/
    icon16.png  icon32.png  icon48.png  icon128.png
```

Generate simple placeholder icons programmatically (solid rounded square with a "T" glyph is fine) so the extension loads and the store upload works; the user will replace the art later.

Manifest `name`: `Tabula — Manual Tab Sync`. Manifest `description` (also used in the store listing): `Push, pull, and merge your tabs and tab groups with a master list stored in your own private GitHub Gist. Manual, explicit, no tracking.`

## Data model

Each **profile** is one JSON file inside a single private Gist named `tabula-data`. File name pattern: `<profile-name>.json` (sanitize the profile name for the filename; keep the display name inside the JSON).

```json
{
  "displayName": "Work",
  "lastModified": "2026-07-17T12:00:00.000Z",
  "tabs": [
    { "url": "https://example.com", "title": "Example", "group": "Research", "pinned": false }
  ],
  "groups": {
    "Research": { "color": "blue", "collapsed": false }
  }
}
```

- `group` is the group **title** (string) or `null` for ungrouped tabs. Groups are keyed by title.
- Tab order in the array is meaningful and must be preserved on open.

## Local storage

- `chrome.storage.sync`: `githubToken`, `gistId` — these must flow automatically to every Chrome instance signed into the same Google account, so the user configures the token once.
- `chrome.storage.local`: `activeProfile`, UI state, cached master snapshot (with timestamp) for display purposes only — never trust the cache for sync operations, always re-fetch before any operation.

## Core operations (the four buttons)

All operate on the **current window's** tabs against the **active profile's** master file. Before each operation, fetch the master fresh from the Gist.

1. **Push (merge to master)** — Add current tabs to master. A tab is a duplicate if its URL (exact string match after stripping trailing `/`) already exists in master; skip duplicates. Merge group metadata: groups present locally but not in master are added with their color. Update `lastModified`, PATCH the gist file.
2. **Pull (merge to local)** — Open master tabs not already open locally (same duplicate rule). Create all tabs first in master order, then group them (Chrome requires tabs to exist before `chrome.tabs.group()`), then set each group's title/color via `chrome.tabGroups.update`. Never close or move existing local tabs.
3. **Replace local** — Close all current-window tabs (open a temporary `chrome://newtab` first so the window survives, close it at the end), then open master state exactly: order, groups, colors, pinned.
4. **Replace master** — Overwrite the profile file with the current window's full state.

Both "replace" operations get a confirmation dialog stating exactly what will be destroyed.

### Reading current state

`getCurrentTabs()` returns `{ tabs, groups }` from the current window:
- Query all tabs in the current window in index order.
- Use `tab.pendingUrl || tab.url` (navigating tabs report their target in `pendingUrl`).
- **Skip** tabs whose URL starts with `chrome://`, `chrome-extension://`, `edge://`, `about:`, or is empty — these can't be reopened and shouldn't pollute the master.
- For each grouped tab, resolve its group via `chrome.tabGroups.get(tab.groupId)` and record title, color, collapsed.

## Popup UI

Single compact popup:
- **Header:** profile dropdown (lists all profiles from the Gist + "New profile…"), settings gear.
- **Status row:** local tab count, master tab count, last-modified time of master, and a **↺ refresh button** that re-fetches the master file on demand. No auto-refresh, no polling — the counts update only on popup open and on ↺.
- **Four action buttons** clearly labeled with direction arrows: `Push → master (merge)`, `Pull ← master (merge)`, `Replace local ← master`, `Replace master ← local`.
- Inline feedback line for results ("Added 4 tabs to master, 12 duplicates skipped") and errors (rate limit, bad token, network).
- If no token is configured, the popup shows only a message and a button to open settings.

### Profiles

- **New profile:** prompt for a name, create the file in the Gist immediately with the current window's state as its initial content (ask the user: "Start empty or from current tabs?").
- **Rename:** available from the dropdown (pencil icon next to active profile). Renames the display name and the Gist filename (create new file + delete old in one PATCH).
- **Delete:** available from the dropdown, with a typed-name confirmation.
- **First launch** (token set, no profiles found): prompt the user to name their first profile.

## Settings page

- PAT input (password field) with a "How to create a token" link to GitHub's docs and a note that the token needs only the `gist` scope.
- **Validate & Save:** on save, call `GET /user` to verify the token, then search the user's gists for one named/described `tabula-data`; if found, store its `gistId`, otherwise create a new **private** gist with that description and an initial `Default.json`. Show clear success/failure states.
- A "Disconnect" button that clears token + gistId from storage (does not touch the Gist).
- Short privacy note: "Your token and tabs go only to api.github.com. Tabula has no servers and collects nothing."

## GitHub API details

- Auth header: `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`.
- Find gist: `GET /gists` (paginate up to 3 pages), match `description === "tabula-data"`.
- Read profile: gists list returns truncated content for large files — always fetch the file's `raw_url` for content.
- Write: `PATCH /gists/{id}` with `{ files: { "<name>.json": { content } } }`. Delete a file by setting it to `null`.
- Handle: 401 (bad token → tell user to re-enter), 403 with rate-limit headers (show reset time), 404 (gist deleted → offer to recreate), network failure.
- No optimistic-locking machinery — last write wins is acceptable for a manual tool, but re-fetching master immediately before each operation minimizes the window.

## Code style

- Small, single-purpose functions; shared Gist/API helpers duplicated into both `popup.js` and `settings.js` are acceptable given no build step, but prefer a shared `common.js` loaded via `<script>` in both pages.
- Every `chrome.*` call and every `fetch` wrapped with error handling that surfaces to the UI — no silent failures, no bare `console.error` as the only output.
- Comment the non-obvious parts: the pendingUrl rule, the tabs-before-groups ordering, the newtab-survival trick in Replace local.

## Definition of done

- Loads via `chrome://extensions` → Load unpacked with zero errors or manifest warnings.
- All four operations work between two Chrome profiles sharing one Gist.
- Profile create/rename/delete round-trips correctly against the Gist.
- Killing the network mid-operation produces a visible error, not a broken state.
- `zip -r tabula.zip tabula/` produces an archive ready for Chrome Web Store upload.
