# Tabula — Manual Tab Sync

Tabula is a Chrome extension that keeps one or more "master" tab lists in a
private GitHub Gist and lets you sync your current browser window against
them, on demand. Nothing happens automatically: no polling, no background
service worker, no scheduled syncs. Every sync is a button you press.

There are no Tabula servers. The extension talks directly to GitHub's API
(`api.github.com`) using a token you provide, and stores your data in a Gist
in your own GitHub account. Tabula collects no analytics and has nothing to
send them to even if it wanted to.

## Install

Tabula is not on the Chrome Web Store yet. Load it unpacked:

1. Open `chrome://extensions`.
2. Turn on "Developer mode" (top right).
3. Click "Load unpacked" and select the `tabula/` folder in this repo.
4. Pin the Tabula icon to your toolbar if you want quick access.

## Setup

1. Create a GitHub **classic** Personal Access Token with only the `gist`
   scope checked — no other scopes are needed. See GitHub's guide:
   https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens
2. Click the Tabula icon, then the settings gear (or open the popup with no
   token configured, which links straight to Settings).
3. Paste the token and click **Validate & Save**. This:
   - calls `GET /user` to confirm the token works,
   - searches your Gists for one named/described `tabula-data`,
   - creates a new **private** Gist called `tabula-data` (seeded with an
     empty `Default.json` profile) if none is found,
   - saves the token and the Gist ID to `chrome.storage.sync`.
4. On first launch with no profiles, Tabula asks you to name your first
   profile.

Everything you sync lives inside that single `tabula-data` Gist, one JSON
file per profile.

## Usage

**Profile dropdown** (top of the popup): switch between profiles, or pick
"New profile…" to create one. You'll be asked to start it empty or seeded
from your current window's tabs. Next to the active profile:
- **Rename** — changes the display name and the Gist filename in one write.
- **Delete** — asks you to type the profile's exact name to confirm; you
  can't delete the only remaining profile.

**Status row**: shows the local tab count, the master (Gist) tab count, and
when master was last modified. None of this auto-refreshes — it updates only
when the popup opens and when you click the **↺** button, which re-fetches
the master file fresh.

**The four operations** — all act on the current window against the active
profile's master file, and master is re-fetched fresh immediately before
each one:

| Button | Direction | What it does |
|---|---|---|
| Push → master (merge) | local → master | Adds current tabs to master. A tab is a duplicate if its URL already exists in master (trailing slash ignored); duplicates are skipped, not overwritten. New local groups are added to master's group list. |
| Pull ← master (merge) | master → local | Opens master tabs that aren't already open locally, in master order, then applies their group titles/colors. Existing local tabs are never closed, moved, or altered. |
| Replace local ← master | master → local, **destructive** | Closes **every tab in the current window** and reopens master's tabs exactly — same order, groups, colors, pinned state. Anything open locally that isn't in master is gone. Requires confirmation, which states the tab count that will be closed. |
| Replace master ← local | local → master, **destructive** | Overwrites the profile file in the Gist with the current window's full state. Whatever was in master before is discarded. Requires confirmation naming the profile and the tab count that will replace it. |

Only **Replace local** and **Replace master** are destructive, and both are
gated behind a confirmation dialog that says exactly what will be lost
before you can proceed.

Tabs on `chrome://`, `chrome-extension://`, `edge://`, and `about:` URLs (and
empty URLs) are always skipped — they can't be reopened on another machine,
so Tabula never reads or writes them.

## Multi-machine use

Use the same GitHub token (and therefore the same Gist) on every Chrome
instance you want to sync across.

If you're signed into Chrome with sync turned on, `chrome.storage.sync`
carries the token and Gist ID to your other signed-in Chrome instances
automatically — you only need to run Setup once. If you're not signed into
Chrome, or sync is off, `chrome.storage.sync` behaves like local storage per
install: open Settings on each machine and paste the same token in manually.

## Data & privacy

- Network destinations are exactly two, both declared as host permissions:
  `api.github.com` for all reads/writes, and `gist.githubusercontent.com` as
  a fallback to fetch raw file content when a profile file is too large for
  the Gist metadata response to include inline (that raw-content request is
  sent without your token, since secret-Gist raw URLs are link-accessible on
  their own).
- The token is stored in `chrome.storage.sync`. It never leaves your browser
  except in the `Authorization` header sent to `api.github.com`.
- The Gist is created as **private** ("secret" in GitHub's terminology).
  Secret Gists are unlisted, not access-controlled: anyone who has (or
  guesses) the Gist's URL can view it without your token. Don't share the
  Gist link.
- Tabula has no servers of its own and collects no analytics or usage data.

## Troubleshooting

- **"Invalid or expired token" (401)** — re-enter your token in Settings.
- **Rate limited (403 with rate-limit headers)** — GitHub's API rate limit
  was hit; the error message shows the time it resets.
- **"Not found" (404) on the Gist** — the stored Gist ID no longer points to
  a real Gist (e.g. you deleted it). The popup offers to recreate a fresh
  private `tabula-data` Gist.
- **Network error** — shown for offline/DNS/connectivity failures; no
  partial writes happen, since operations only commit after both the read
  and write succeed.
- **Some tabs never sync** — `chrome://`, `chrome-extension://`, `edge://`,
  and `about:` tabs are deliberately skipped everywhere (reading, pushing,
  pulling); this is by design, not a bug.

## Development

```
tabula/
  manifest.json
  popup.html / popup.js / popup.css
  settings.html / settings.js / settings.css
  common.js          # shared storage + GitHub Gist API helpers, loaded by both pages
  icons/              # 16/32/48/128px, currently placeholder art
```

No build step, no dependencies, no bundler — plain HTML/CSS/JS loaded
directly via `<script>` tags. Edit the files and reload the extension from
`chrome://extensions`.

To package for the Chrome Web Store:

```
zip -r tabula.zip tabula/
```
