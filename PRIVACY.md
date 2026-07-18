# Tabula Privacy Policy

_Last updated: 2026-07-18_


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

If you use Tabula's bookmarks-bar sync (the second row of buttons in the
popup, or the optional "Also sync bookmarks bar" setting described below),
the titles and URLs of the links and folders on your bookmarks bar are sent
to your chosen backend the same way tab data is — same destinations, same
token, stored in your own account. Tabula reads only the bookmarks bar;
it does not read or send any other bookmarks folder. Local bookmarks are
only ever created, replaced, or removed on your machine when you explicitly
click "Pull" or "Replace local" for bookmarks in the popup — never
automatically.

Tabula includes an optional, off-by-default automatic sync feature (a
timer, and a sync-when-switching-profiles option, both turned on only by
the user in Settings). When enabled, it performs the same kind of sync
described above — reading local tabs and, optionally, the bookmarks bar,
and sending them to the same backend and destinations named in this
policy — on a schedule or on a profile switch instead of a button press.
It does not expand what data is sent or where it goes; it only changes
when the sync happens. This feature runs via a background service worker
that is otherwise idle and contacts no server on its own.

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


