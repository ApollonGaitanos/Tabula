# Chrome Web Store submission kit — Tabula

This is reference material for submitting Tabula to the Chrome Web Store. It
is not itself a store listing; copy the relevant pieces into the developer
dashboard when submitting.

## Listing copy

**Name:** Tabula — Manual Tab Sync

**Short description** (from `manifest.json`, used as the store's summary
field — 132 character limit, this fits):

> Push, pull, and merge your tabs and tab groups with a master list stored in your own private GitHub Gist. Manual, explicit, no tracking.

**Suggested category:** Productivity (Chrome Web Store's "Tools" category is
also a reasonable fit if Productivity isn't accepted for this listing).

**Detailed description** (draft for the listing's long-form field):

> Tabula keeps a "master" copy of your tabs and tab groups in a private
> GitHub Gist that lives entirely in your own GitHub account. You control
> when and how your browser syncs against it — there is no automatic sync,
> no background polling, and no Tabula server in the loop at all.
>
> Four explicit actions, always run on the current window against the
> profile you pick:
>
> - **Push → master (merge):** add your open tabs to the master list.
>   Tabs already in master (matched by URL) are skipped, not duplicated.
> - **Pull ← master (merge):** open whatever is in master that isn't
>   already open locally, restoring tab groups and their colors.
> - **Replace local ← master:** make this window match master exactly —
>   closes what's open and reopens master's tabs, order, groups, and
>   pinned state. Asks for confirmation first.
> - **Replace master ← local:** overwrite the master file with exactly
>   what's open in this window right now. Asks for confirmation first.
>
> Use profiles to keep separate tab sets — Work, Research, a project you
> context-switch into — each stored as its own file inside a single private
> Gist named `tabula-data`.
>
> Setup takes one GitHub Personal Access Token with the `gist` scope only.
> Tabula reads and writes exclusively to `api.github.com` (and, as a
> fallback for large profiles, `gist.githubusercontent.com` for raw file
> content). Nothing is sent anywhere else. There is no telemetry, no
> analytics, and no account system beyond your own GitHub token.
>
> Prefer to self-host? Tabula also supports a Forgejo/Gitea backend: point
> it at your own instance URL and an access token, and profiles are stored
> as commits in a private repo on that instance instead — with the same
> manual, explicit sync model and the same four operations. Chrome asks for
> a one-time permission prompt naming your instance's address before the
> first connection, and access is limited to exactly that address.
>
> Because everything is a manual action with a visible confirmation on
> anything destructive, Tabula never surprises you by closing or reopening
> tabs you didn't ask it to touch.

## Privacy policy

Chrome Web Store requires a published privacy policy for any extension
using the `tabs` permission. Host the text below at a public URL (a GitHub
Pages page, a Gist rendered via raw/HTML, or any static host works) and link
it from the "Privacy practices" tab of the developer dashboard listing.

---

**Tabula Privacy Policy**

Tabula does not collect, transmit, or sell any data to the developer or any
third party. Tabula has no servers.

When you use Tabula with the default GitHub backend, tab URLs, titles, group
names, and colors from your current browser window are sent only to
GitHub's API (`api.github.com`), using a Personal Access Token you provide,
and stored in a private ("secret") GitHub Gist that belongs to your own
GitHub account — not the developer's. Reading large profile files may also
fetch content directly from `gist.githubusercontent.com`, GitHub's Gist
raw-content host. These are the only two network destinations Tabula
contacts in this mode.

Tabula also offers an optional Forgejo/Gitea backend for people who
self-host their own instance. If you choose it, your tab data and access
token are sent only to the single instance URL you yourself enter — nowhere
else, and GitHub is not contacted at all in this mode. Access to that
address is granted by you, explicitly, through a browser permission prompt
naming that exact origin before Tabula ever contacts it.

Your access token — GitHub or Forgejo/Gitea, whichever backend you use — is
stored in Chrome's synced extension storage (`chrome.storage.sync`), which
is encrypted and managed by Google as part of your Chrome sync setup. The
token is never sent anywhere except in authenticated requests to that
backend's API (`api.github.com`, or the Forgejo/Gitea instance URL you
entered).

Tabula includes no analytics, crash reporting, or advertising code, and does
not track usage, in either mode. No data is sold or shared with any third
party, because no data is collected by the developer in the first place —
it goes directly from your browser to your own GitHub account or your own
self-hosted instance. Tabula has no servers of its own in either mode.

---

## Permission justifications

The Chrome Web Store review form asks for a plain-language justification of
every permission. Suggested answers:

- **`tabs`** — Tabula reads the URL and title of each open tab in the
  current window so it can push them to, or compare them against, the
  user's Gist-stored master list. It also creates and closes tabs when the
  user explicitly runs Pull or Replace local.
- **`tabGroups`** — Tabula reads and restores tab group titles, colors, and
  collapsed state so grouped tabs round-trip correctly between the browser
  and the master list.
- **`storage`** — stores the user's GitHub token, Gist ID, active profile,
  and small UI/display caches. No data leaves the browser through this
  permission; it's local (and Chrome-sync) storage only.
- **Host permission `https://api.github.com/*`** — the only endpoint Tabula
  reads from and writes to: the user's Gist containing their tab profiles.
- **Host permission `https://gist.githubusercontent.com/*`** — fallback used
  to fetch raw file content for profile files too large to be returned
  inline by the Gist metadata API.
- **Optional host permissions `https://*/*` and `http://*/*`** — Tabula
  optionally supports syncing to a user's own self-hosted Forgejo or Gitea
  instance instead of GitHub. Because that instance's URL is chosen by the
  user at setup time and cannot be known in advance, it can't be listed as
  a fixed host permission the way `api.github.com` is. These broad patterns
  are declared only in `optional_host_permissions`, which grants nothing by
  itself — no host is ever accessed at install time or in the background.
  Access is requested at runtime, from `chrome.permissions.request()`,
  scoped to exactly the single origin the user typed (e.g.
  `https://git.example.com/*`, not a wildcard), and only in direct response
  to the user clicking "Validate & Save" in Settings (a live user gesture).
  Chrome shows its own permission prompt naming that specific origin before
  anything is granted; declining it aborts the save with nothing persisted
  and nothing contacted. Users who never enable the Forgejo/Gitea backend
  never see this prompt and Tabula never requests or holds any origin
  beyond the two GitHub hosts above.

No other permissions are requested — no `<all_urls>` in `host_permissions`,
no `activeTab`, no `scripting`, no remote code.

## Submission checklist

- [ ] Chrome Web Store developer account registered (one-time $5 fee).
- [ ] Package the extension: `zip -r tabula.zip tabula/` from the repo root.
- [ ] At least one screenshot at 1280x800 or 640x400 (Chrome Web Store
      requires 1-5 screenshots in one of these two sizes).
- [ ] 128x128 icon is already present at `tabula/icons/icon128.png` — no
      action needed there, only replace it if the art below changes.
- [ ] Single-purpose description ready for the review form: "Sync the
      current window's tabs and tab groups against a master list the user
      stores in their own private GitHub Gist or self-hosted Forgejo/Gitea
      repository." Keep the listing consistent with this — reviewers reject
      listings that describe more than the extension actually does.
- [ ] Privacy policy text above published at a public URL and linked in the
      dashboard's Privacy practices tab.
- [ ] **Replace the placeholder icons** (`tabula/icons/icon16.png`,
      `icon32.png`, `icon48.png`, `icon128.png`) with real artwork before
      submitting — the current set is a generic placeholder generated to
      make the extension load, not store-ready art.
