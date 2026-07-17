# Tabula — Manual Tab Sync

Tabula is a Chrome extension that keeps one or more "master" tab lists in a
private GitHub Gist — or a private repo on your own Forgejo/Gitea instance —
and lets you sync your current browser window against them, on demand.
Every sync is manual by default: no polling, no timers, no scheduled syncs
unless you turn one on yourself. A small background service worker exists
solely to drive an *optional* timed sync — it's off by default, and out of
the box nothing happens automatically.

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

## Bookmarks bar

Below the tab buttons, the popup has a second, smaller row of four buttons
for the bookmarks bar: **Push → master (merge)**, **Pull ← master (merge)**,
**Replace local ← master**, **Replace master ← local**. They mirror the tab
operations above, but act on your browser's bookmarks bar instead of the
current window's tabs.

The bookmarks bar is global, not per-window and not per-profile, so its
synced state lives in **one shared file** on the backend (`_bookmarks.json`
at the root of the Gist or repo), separate from any profile file. It's
excluded from the profile dropdown — it never shows up as something you can
select or switch to.

- **Push** adds local bookmarks-bar links to the stored set; a link already
  present (matched by URL, trailing slash ignored) is skipped, not
  duplicated. New local folders are created on the stored side to hold them.
- **Pull** adds stored links that aren't already on your local bar, placing
  them under matching folder names (creating those folders locally if
  needed); nothing local is removed or moved.
- **Replace local ← master** deletes every bookmark and folder currently on
  your local bar and recreates the stored set exactly. Requires confirmation
  naming the bookmark count that will be recreated.
- **Replace master ← local** overwrites the stored set with exactly what's
  on your local bar right now, discarding whatever was stored before.
  Requires confirmation naming the bookmark count that will replace it.

As with the tab operations, only the two Replace buttons are destructive,
and both are gated behind a confirmation dialog. Bookmarks-bar sync can also
be folded into timed automatic sync (see below) and is included when you
migrate data between backends.

## Automatic sync

Settings has an **Automatic sync** card with two independent, opt-in
switches — both are **off by default**, so nothing syncs on its own until
you turn one on:

- **Sync on a timer** — runs a sync every N minutes (minimum 1, since that's
  the floor `chrome.alarms` enforces) in the background, without the popup
  open. Mode is either **Push → master (merge)** (same semantics as the
  popup's Push button) or **Replace master ← local** (overwrites master with
  the window's current state every interval — destructive by nature, since
  it runs unattended with no confirmation dialog). It acts on the
  **last-focused normal browser window** and that window's **active
  profile** — the worker has no notion of "the popup's current window," so
  it uses whichever window you last actually looked at. If nothing is
  configured yet, no window is open, or no profile is selected, the timer
  fires and silently does nothing (no error is recorded).
- **Sync when switching profiles** — when you switch the active profile in
  the popup, this syncs the current window into the profile you're
  *leaving* first, using its own Push or Replace mode. It never blocks or
  delays the switch itself: on failure, the switch still happens and the
  popup just reports that the sync failed.
- **Also sync bookmarks bar** — a checkbox on the timer switch that, when
  on, also syncs the bookmarks bar (using the same Push/Replace mode) as
  part of each timed run. It has no effect on sync-on-switch, which only
  ever touches tab profiles.

All of these settings save immediately as you change them — there's no
separate Save button on this card, and the background worker picks up
timer changes right away via `chrome.storage.onChanged`.

The card shows a **last auto-sync** status line (timestamp and outcome) so
you can tell whether the timer is actually running, without it
auto-refreshing or polling while you have the page open.

The background service worker that drives the timer is read-only toward
your browser: it reads tabs and the bookmarks bar and writes to your
backend, but it never opens, closes, or moves anything locally, and never
shows a dialog. All of that only happens through the popup, on a button
you press.

## Migrate between backends

Settings has a **Migrate data** card for moving everything from one backend
to the other — GitHub Gist to Forgejo/Gitea, or the reverse — in one pass.
It requires both backends' credentials already saved (connect each one via
the backend picker above it first).

- Every profile file is **copied**, source to target; the source is never
  modified or deleted, and your local tabs are never touched either.
- The shared `_bookmarks.json` file is copied too, if it exists on the
  source.
- A file that already exists on the target under the same name is
  **overwritten** — the confirmation dialog before you click Migrate spells
  this out explicitly.
- Each profile is migrated independently: one profile failing doesn't stop
  the rest, and the result reports which (if any) failed by name.
- An optional checkbox, checked by default, switches your **active
  backend** to the target once the run finishes with zero failures. A run
  with any failures never switches, even if some profiles succeeded.

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
- If you use bookmarks-bar sync (manually or via automatic sync), the
  titles and URLs of your bookmarks-bar links and folders are sent to your
  chosen backend the same way tab data is — same destinations, same token,
  same "your own account" model. Nothing else about your bookmarks (other
  folders, the "Other Bookmarks" tree, etc.) is read or sent.
- The optional timed auto-sync runs through a background service worker
  (`background.js`), driven by the `alarms` permission; it's inert unless
  you turn on "Sync on a timer" in Settings, which is off by default. It
  only ever reads local tabs/bookmarks and writes to your backend; it never
  opens, closes, or rearranges anything in your browser. Sync-on-switch is
  a separate setting that runs in the popup itself (only when you actually
  switch profiles there), not in the background worker.

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
- **Timed auto-sync doesn't seem to run** — check the "Last auto-sync" line
  in Settings. If it's blank, the timer alarm hasn't fired yet or a
  precondition silently wasn't met (no backend connected, no normal browser
  window open, or no active profile) — these are treated as "nothing to do
  yet," not errors, so nothing is recorded. If it shows a failure message,
  that's the error from the last attempted sync.
- **Sync-on-switch failed but the profile switched anyway** — that's by
  design: a sync-on-switch failure is reported in the popup's feedback line
  but never blocks or reverts the switch itself.
- **Migration reports some profiles failed** — the failed profiles are
  named in the result message; everything else still migrated. Nothing on
  the source was touched, so it's safe to just re-run Migrate afterward.

## Development

```
tabula/
  manifest.json
  background.js       # service worker: timed auto-sync alarm handler only
  popup.html / popup.js / popup.css
  settings.html / settings.js / settings.css
  common.js          # shared storage + backend (GitHub Gist, Forgejo/Gitea) API helpers + bookmarks-bar helpers, loaded by popup, settings, and background
  icons/              # 16/32/48/128px, currently placeholder art
```

No build step, no dependencies, no bundler — plain HTML/CSS/JS loaded
directly via `<script>` tags. Edit the files and reload the extension from
`chrome://extensions`.

To package for the Chrome Web Store:

```
cd tabula && zip -r ../tabula.zip .
```
