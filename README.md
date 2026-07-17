# Tabula — Manual Tab Sync

Tabula is a Chrome extension that keeps one or more "master" tab lists in a
private GitHub Gist — or a private repo on your own Forgejo/Gitea instance —
and lets you sync your current browser window against them, on demand.
Nothing happens automatically: no polling, no background service worker, no
scheduled syncs. Every sync is a button you press.

There are no Tabula servers. The extension talks directly to your chosen
backend's API using a token you provide, and stores your data there, in your
own account: GitHub's API (`api.github.com`) and a Gist by default, or your
own Forgejo/Gitea instance if you pick that backend in Settings. Tabula
collects no analytics and has nothing to send them to even if it wanted to.

## Install

Tabula is not on the Chrome Web Store yet. Load it unpacked:

1. Open `chrome://extensions`.
2. Turn on "Developer mode" (top right).
3. Click "Load unpacked" and select the `tabula/` folder in this repo.
4. Pin the Tabula icon to your toolbar if you want quick access.

## Setup

Settings has a backend picker: **GitHub Gist** (the default, unchanged) or
**Forgejo/Gitea**.

### GitHub Gist (default)

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

### Forgejo / Gitea

1. On your Forgejo/Gitea instance, go to **Settings → Applications →
   Generate New Token** and create an access token with repository
   read/write scope.
2. In Tabula's Settings, pick **Forgejo/Gitea** in the backend picker, then
   enter your instance URL and paste the token.
3. Click **Validate & Save**. Chrome will show a one-time permission prompt
   asking to grant Tabula access to your instance's origin — this is a
   runtime grant (from `optional_host_permissions`), not something baked
   into the extension at install time, because your instance's URL can't be
   known in advance. It's granted once and persists after that; if you
   decline it, nothing is saved. Assuming it's granted, Save then:
   - verifies the token by calling `GET /user`,
   - finds or creates a **private** repo named `tabula-data` under your
     account (created with `auto_init` so it has a default branch to commit
     against),
   - saves the instance URL, token, and owner login to `chrome.storage.sync`.
4. On first launch with no profiles, Tabula asks you to name your first
   profile.

Profiles are stored as one JSON file per profile at the root of the
`tabula-data` repo. Every sync write is a commit, so you get version history
on your tab profiles for free — something the Gist backend doesn't give you.

If the granted permission is later revoked (e.g. you remove it in Chrome's
site settings), the popup will say access isn't granted and point you back
to Settings to reconnect.

## Usage

**Profile dropdown** (top of the popup): switch between profiles, or pick
"New profile…" to create one. You'll be asked to start it empty or seeded
from your current window's tabs. Next to the active profile:
- **Rename** — changes the display name and the master filename. On the
  Gist backend this is one atomic write. On Forgejo/Gitea, which has no
  equivalent multi-file write, it's a new file written first and then the
  old one deleted — not atomic, so a failure between the two steps can
  leave a leftover duplicate file, but it never loses data.
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

Use the same backend credentials on every Chrome instance you want to sync
across: the same GitHub token (and therefore the same Gist) for the GitHub
backend, or the same instance URL and token for the Forgejo/Gitea backend.

If you're signed into Chrome with sync turned on, `chrome.storage.sync`
carries the backend config to your other signed-in Chrome instances
automatically — you only need to run Setup once. If you're not signed into
Chrome, or sync is off, `chrome.storage.sync` behaves like local storage per
install: open Settings on each machine and enter the same credentials
manually.

## Data & privacy

- On the GitHub backend, network destinations are exactly two, both
  declared as host permissions: `api.github.com` for all reads/writes, and
  `gist.githubusercontent.com` as a fallback to fetch raw file content when
  a profile file is too large for the Gist metadata response to include
  inline (that raw-content request is sent without your token, since
  secret-Gist raw URLs are link-accessible on their own).
- On the Forgejo/Gitea backend, the only additional network destination is
  the instance URL you entered — nowhere else. That host isn't baked into
  the manifest (your instance's address can't be known in advance); Tabula
  requests access to it at runtime via `chrome.permissions.request`, which
  Chrome shows you as a one-time permission prompt naming that exact origin.
  Your Forgejo token is sent only in requests to that origin.
- Whichever backend is active, its token is stored in `chrome.storage.sync`.
  It never leaves your browser except in the `Authorization` header sent to
  that backend's API (`api.github.com`, or your Forgejo/Gitea instance).
- The Gist is created as **private** ("secret" in GitHub's terminology).
  Secret Gists are unlisted, not access-controlled: anyone who has (or
  guesses) the Gist's URL can view it without your token. Don't share the
  Gist link. The Forgejo/Gitea `tabula-data` repo is created **private**
  too, which on that platform is access-controlled by your instance's own
  permission model, not just an unlisted URL.
- Tabula has no servers of its own and collects no analytics or usage data.

## Troubleshooting

- **"Invalid or expired token" (401)** — re-enter your token in Settings
  (GitHub or Forgejo/Gitea, whichever backend is active).
- **Rate limited (403 with rate-limit headers)** — GitHub's API rate limit
  was hit; the error message shows the time it resets.
- **"Not found" (404) on the Gist or repo** — the stored Gist ID, or the
  Forgejo `tabula-data` repo, no longer points to something real (e.g. you
  deleted it). The popup offers to recreate a fresh private Gist or repo.
- **Network error** — shown for offline/DNS/connectivity failures; no
  partial writes happen, since operations only commit after both the read
  and write succeed.
- **Some tabs never sync** — `chrome://`, `chrome-extension://`, `edge://`,
  and `about:` tabs are deliberately skipped everywhere (reading, pushing,
  pulling); this is by design, not a bug.
- **Forgejo permission prompt declined** — if you decline the one-time
  Chrome permission prompt for your instance's origin, Save reports that
  nothing was saved and no config is persisted; reopen Settings and try
  Save again to get the prompt back.
- **Forgejo access "isn't granted"** — shown in the popup if the runtime
  host permission for your instance was revoked after setup (e.g. you
  removed it via Chrome's site permissions). Reconnect from Settings, which
  re-requests the permission prompt.

## Development

```
tabula/
  manifest.json
  popup.html / popup.js / popup.css
  settings.html / settings.js / settings.css
  common.js          # shared storage + backend (GitHub Gist, Forgejo/Gitea) API helpers, loaded by both pages
  icons/              # 16/32/48/128px, currently placeholder art
```

No build step, no dependencies, no bundler — plain HTML/CSS/JS loaded
directly via `<script>` tags. Edit the files and reload the extension from
`chrome://extensions`.

To package for the Chrome Web Store:

```
zip -r tabula.zip tabula/
```
