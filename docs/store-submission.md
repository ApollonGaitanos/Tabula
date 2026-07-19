# Chrome Web Store submission kit — Kartela

This is reference material for submitting Kartela to the Chrome Web Store. It
is not itself a store listing; copy the relevant pieces into the developer
dashboard when submitting.

## Listing copy

**Name:** Kartela — Private Tab Syncing

**Short description** (from `manifest.json`'s `appDesc` message in
`_locales/en/messages.json`, used as the store's summary field — 132
character limit, this is 122):

> Your tabs stay yours: sync tabs, groups & bookmarks to a private GitHub Gist or your own Forgejo. No servers, no tracking.

**Suggested category:** Productivity (Chrome Web Store's "Tools" category is
also a reasonable fit if Productivity isn't accepted for this listing).

**Detailed description** (draft for the listing's long-form field):

> Your tabs stay yours. Kartela syncs your tabs, tab groups, and bookmarks to
> a private GitHub Gist or your own self-hosted Forgejo/Gitea instance —
> never to a Kartela server, because there isn't one. Your data lives in
> your own account, reachable only with a token you provide and control.
>
> New to Kartela? Pick a profile from the dropdown to preview it — that's
> read-only, it just shows you what's saved in it without touching your open
> tabs or triggering any sync. When you're ready, **Use this profile**
> replaces your window's tabs with that profile's saved list; **Update**
> overwrites the saved list with whatever's open right now. Those two
> buttons, plus a confirmation dialog before anything destructive happens,
> are all most people ever need.
>
> Setup takes one GitHub Personal Access Token with the `gist` scope only.
> Kartela reads and writes exclusively to `api.github.com` (and, as a
> fallback for large profiles, `gist.githubusercontent.com` for raw file
> content). Nothing is sent anywhere else. There is no telemetry, no
> analytics, and no account system beyond your own GitHub token.
>
> Prefer to self-host? Kartela also supports a Forgejo/Gitea backend: point
> it at your own instance URL and an access token, and profiles are stored
> as commits in a private repo on that instance instead — with the same
> manual, explicit sync model. Chrome asks for a one-time permission prompt
> naming your instance's address before the first connection, and access is
> limited to exactly that address.
>
> Use profiles to keep separate tab sets — Work, Research, a project you
> context-switch into — each stored as its own file in your private storage.
>
> Beyond the two main buttons, an Advanced section holds four
> finer-grained tab operations for anyone who wants more control than
> "use" or "update" gives:
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
> A second, matching set of four buttons syncs your bookmarks bar the same
> way — push, pull, replace local, replace master — against one shared
> bookmarks file on your backend, separate from your tab profiles.
>
> Everything above runs only when you click a button. Kartela also offers
> **optional, off-by-default automatic sync**, turned on in Settings if you
> want it: a timer (minimum one minute) that pushes or replaces your master
> list unattended, a switch that syncs the profile you're leaving whenever
> you confirm switching to a different one, and a checkbox to fold
> bookmarks-bar sync into the timer. Both are disabled out of the box —
> nothing syncs on its own until you explicitly turn one on — and a small
> background service worker exists only to run that optional timer; it
> never opens, closes, or rearranges tabs or bookmarks on its own, it only
> reads them and writes to your backend.
>
> Settings also has a one-time **Migrate** tool that copies every profile
> (and the bookmarks file, if present) from one connected backend to the
> other, so you can move from GitHub Gist to Forgejo/Gitea or back without
> re-entering everything by hand. The source is never modified.
>
> Because every sync is either a manual action with a visible confirmation
> on anything destructive, or an automation you explicitly opted into,
> Kartela never surprises you by closing or reopening tabs — or bookmarks —
> you didn't ask it to touch.
>
> Kartela's interface is available in English and Greek; Chrome picks the
> language automatically from your browser's UI language.

## Greek listing (Ελληνικά)

The Chrome Web Store developer dashboard lets you enter a separate name,
summary, and detailed description per language. This section is the
complete Greek-language listing to paste into that language slot.

**Short description** (from `manifest.json`'s `appDesc` message in
`_locales/el/messages.json` — 132 character limit, this is 119):

> Οι καρτέλες σου μένουν δικές σου: συγχρονισμός σε ιδιωτικό Gist ή δικό σου Forgejo. Χωρίς servers, χωρίς παρακολούθηση.

**Detailed description** (Greek translation of the draft above):

> Οι καρτέλες σου μένουν δικές σου. Το Kartela συγχρονίζει τις καρτέλες, τις
> ομάδες καρτελών και τους σελιδοδείκτες σου σε ένα ιδιωτικό GitHub Gist ή
> στο δικό σου self-hosted Forgejo/Gitea instance — ποτέ σε κάποιον server
> του Kartela, γιατί δεν υπάρχει τέτοιος. Τα δεδομένα σου μένουν στον δικό
> σου λογαριασμό, προσβάσιμα μόνο με ένα token που εσύ παρέχεις και
> ελέγχεις.
>
> Νέος/νέα στο Kartela; Επίλεξε ένα προφίλ από το dropdown για
> προεπισκόπηση — αυτό είναι μόνο για ανάγνωση, απλώς σου δείχνει τι έχει
> αποθηκευτεί σε αυτό χωρίς να αγγίζει τις ανοιχτές καρτέλες σου ή να
> ξεκινά κανέναν συγχρονισμό. Όταν είσαι έτοιμος/η, το «Χρήση αυτού του
> προφίλ» αντικαθιστά τις καρτέλες του παραθύρου σου με την αποθηκευμένη
> λίστα του προφίλ· το «Ενημέρωση» αντικαθιστά την αποθηκευμένη λίστα με
> ό,τι είναι ανοιχτό αυτή τη στιγμή. Αυτά τα δύο κουμπιά, μαζί με ένα
> παράθυρο επιβεβαίωσης πριν από οτιδήποτε καταστροφικό, είναι όλα όσα
> χρειάζονται οι περισσότεροι χρήστες.
>
> Η εγκατάσταση απαιτεί μόνο ένα GitHub Personal Access Token με το scope
> `gist`. Το Kartela διαβάζει και γράφει αποκλειστικά στο `api.github.com`
> (και, ως fallback για μεγάλα προφίλ, στο `gist.githubusercontent.com` για
> raw περιεχόμενο αρχείων). Τίποτα δεν στέλνεται πουθενά αλλού. Δεν υπάρχει
> telemetry, δεν υπάρχει analytics, και δεν υπάρχει σύστημα λογαριασμού
> πέρα από το δικό σου GitHub token.
>
> Προτιμάς self-hosting; Το Kartela υποστηρίζει επίσης backend Forgejo/
> Gitea: όρισε το URL του δικού σου instance και ένα access token, και τα
> προφίλ αποθηκεύονται ως commits σε ένα ιδιωτικό repo σε εκείνο το
> instance — με το ίδιο, χειροκίνητο και ρητό μοντέλο συγχρονισμού. Το
> Chrome εμφανίζει ένα εφάπαξ παράθυρο άδειας που ονομάζει τη διεύθυνση του
> instance σου πριν από την πρώτη σύνδεση, και η πρόσβαση περιορίζεται
> ακριβώς σε αυτή τη διεύθυνση.
>
> Χρησιμοποίησε προφίλ για να κρατάς ξεχωριστά σύνολα καρτελών — Εργασία,
> Έρευνα, ένα project στο οποίο εναλλάσσεσαι — καθένα αποθηκευμένο ως δικό
> του αρχείο στον ιδιωτικό σου χώρο αποθήκευσης.
>
> Πέρα από τα δύο βασικά κουμπιά, μια ενότητα «Για προχωρημένους» περιέχει
> τέσσερις πιο λεπτομερείς λειτουργίες καρτελών για όσους θέλουν
> μεγαλύτερο έλεγχο από το «χρήση» ή το «ενημέρωση»:
>
> - **Push → master (συγχώνευση):** προσθέτει τις ανοιχτές σου καρτέλες
>   στη λίστα master. Καρτέλες που υπάρχουν ήδη στο master (με βάση το
>   URL) παραλείπονται, δεν διπλασιάζονται.
> - **Pull ← master (συγχώνευση):** ανοίγει ό,τι υπάρχει στο master και
>   δεν είναι ήδη ανοιχτό τοπικά, επαναφέροντας τις ομάδες καρτελών και τα
>   χρώματά τους.
> - **Αντικατάσταση τοπικών ← master:** κάνει αυτό το παράθυρο να ταιριάζει
>   ακριβώς με το master — κλείνει ό,τι είναι ανοιχτό και ανοίγει ξανά τις
>   καρτέλες, τη σειρά, τις ομάδες και την κατάσταση καρφιτσώματος του
>   master. Ζητά επιβεβαίωση πρώτα.
> - **Αντικατάσταση master ← τοπικά:** αντικαθιστά το αρχείο master με
>   ακριβώς ό,τι είναι ανοιχτό σε αυτό το παράθυρο αυτή τη στιγμή. Ζητά
>   επιβεβαίωση πρώτα.
>
> Ένα δεύτερο, αντίστοιχο σύνολο τεσσάρων κουμπιών συγχρονίζει τη γραμμή
> σελιδοδεικτών σου με τον ίδιο τρόπο — push, pull, αντικατάσταση τοπικών,
> αντικατάσταση master — σε ένα κοινό αρχείο σελιδοδεικτών στο backend σου,
> ξεχωριστό από τα προφίλ καρτελών σου.
>
> Όλα τα παραπάνω τρέχουν μόνο όταν πατάς ένα κουμπί. Το Kartela προσφέρει
> επίσης **προαιρετικό, απενεργοποιημένο εξ ορισμού αυτόματο
> συγχρονισμό**, ενεργοποιήσιμο στις Ρυθμίσεις αν το θέλεις: έναν
> χρονοδιακόπτη (ελάχιστο ένα λεπτό) που κάνει push ή αντικαθιστά τη λίστα
> master χωρίς επίβλεψη, έναν διακόπτη που συγχρονίζει το προφίλ που
> αφήνεις κάθε φορά που επιβεβαιώνεις εναλλαγή σε άλλο, και ένα checkbox
> για να συμπεριλάβεις τον συγχρονισμό της γραμμής σελιδοδεικτών στον
> χρονοδιακόπτη. Και τα δύο είναι απενεργοποιημένα εξ ορισμού — τίποτα δεν
> συγχρονίζεται μόνο του μέχρι να το ενεργοποιήσεις ρητά — και ένας μικρός
> background service worker υπάρχει μόνο για να τρέχει αυτόν τον
> προαιρετικό χρονοδιακόπτη· ποτέ δεν ανοίγει, κλείνει ή αναδιατάσσει
> καρτέλες ή σελιδοδείκτες μόνος του, μόνο τους διαβάζει και γράφει στο
> backend σου.
>
> Οι Ρυθμίσεις διαθέτουν επίσης ένα εργαλείο **Μεταφοράς** που αντιγράφει
> κάθε προφίλ (και το αρχείο σελιδοδεικτών, αν υπάρχει) από το ένα
> συνδεδεμένο backend στο άλλο, ώστε να μπορείς να μεταφερθείς από GitHub
> Gist σε Forgejo/Gitea ή αντίστροφα χωρίς να ξαναπερνάς τα πάντα με το
> χέρι. Η πηγή δεν τροποποιείται ποτέ.
>
> Επειδή κάθε συγχρονισμός είναι είτε μια χειροκίνητη ενέργεια με ορατή
> επιβεβαίωση πριν από οτιδήποτε καταστροφικό, είτε μια αυτοματοποίηση που
> επέλεξες ρητά, το Kartela δεν σε εκπλήσσει ποτέ κλείνοντας ή ανοίγοντας
> καρτέλες — ή σελιδοδείκτες — που δεν του ζήτησες να αγγίξει.
>
> Η διεπαφή του Kartela είναι διαθέσιμη στα Αγγλικά και τα Ελληνικά· το
> Chrome επιλέγει τη γλώσσα αυτόματα από τη γλώσσα διεπαφής του browser
> σου.

## Privacy policy

Chrome Web Store requires a published privacy policy for any extension
using the `tabs` permission. Host the text below at a public URL (a GitHub
Pages page, a Gist rendered via raw/HTML, or any static host works) and link
it from the "Privacy practices" tab of the developer dashboard listing.

---

**Kartela Privacy Policy**

Kartela does not collect, transmit, or sell any data to the developer or any
third party. Kartela has no servers.

When you use Kartela with the default GitHub backend, tab URLs, titles, group
names, and colors from your current browser window are sent only to
GitHub's API (`api.github.com`), using a Personal Access Token you provide,
and stored in a private ("secret") GitHub Gist that belongs to your own
GitHub account — not the developer's. (The Gist is named/described
`tabula-data` — a historical name from before the extension was renamed
from Tabula to Kartela, kept for data compatibility.) Reading large profile
files may also fetch content directly from `gist.githubusercontent.com`,
GitHub's Gist raw-content host. These are the only two network destinations
Kartela contacts in this mode.

If you use Kartela's bookmarks-bar sync (the second row of buttons in the
popup, or the optional "Also sync bookmarks bar" setting described below),
the titles and URLs of the links and folders on your bookmarks bar are sent
to your chosen backend the same way tab data is — same destinations, same
token, stored in your own account. Kartela reads only the bookmarks bar;
it does not read or send any other bookmarks folder. Local bookmarks are
only ever created, replaced, or removed on your machine when you explicitly
click "Pull" or "Replace local" for bookmarks in the popup — never
automatically.

Kartela includes an optional, off-by-default automatic sync feature (a
timer, and a sync-when-switching-profiles option, both turned on only by
the user in Settings). When enabled, it performs the same kind of sync
described above — reading local tabs and, optionally, the bookmarks bar,
and sending them to the same backend and destinations named in this
policy — on a schedule or on a profile switch instead of a button press.
It does not expand what data is sent or where it goes; it only changes
when the sync happens. This feature runs via a background service worker
that is otherwise idle and contacts no server on its own.

Kartela also offers an optional Forgejo/Gitea backend for people who
self-host their own instance. If you choose it, your tab data and access
token are sent only to the single instance URL you yourself enter — nowhere
else, and GitHub is not contacted at all in this mode. Data is stored in a
private repo named `tabula-data` under your account (the same historical
name as the Gist above). Access to that address is granted by you,
explicitly, through a browser permission prompt naming that exact origin
before Kartela ever contacts it.

Your access token — GitHub or Forgejo/Gitea, whichever backend you use — is
stored in Chrome's synced extension storage (`chrome.storage.sync`), which
is encrypted and managed by Google as part of your Chrome sync setup. The
token is never sent anywhere except in authenticated requests to that
backend's API (`api.github.com`, or the Forgejo/Gitea instance URL you
entered).

Kartela includes no analytics, crash reporting, or advertising code, and does
not track usage, in either mode. No data is sold or shared with any third
party, because no data is collected by the developer in the first place —
it goes directly from your browser to your own GitHub account or your own
self-hosted instance. Kartela has no servers of its own in either mode.

---

## Permission justifications

**Background service worker.** The manifest declares
`"background": { "service_worker": "background.js" }`. This exists solely
to run the optional timed auto-sync feature described above (`chrome.alarms`
firing `background.js`, which then does the same push/replace a user could
do from the popup). It performs no action at install time or on browser
startup beyond re-registering that alarm if the user previously turned the
timer on; if the timer is off (the default), the worker does nothing. It
never opens a window, shows a dialog, or moves/closes a local tab or
bookmark — it only reads local tabs/bookmarks and writes to the user's own
configured backend. Sync-on-profile-switch is a separate feature that runs
in the popup, not in this worker.

The Chrome Web Store review form asks for a plain-language justification of
every permission. Suggested answers:

- **`tabs`** — Kartela reads the URL and title of each open tab in the
  current window so it can push them to, or compare them against, the
  user's Gist-stored master list. It also creates and closes tabs when the
  user explicitly runs Pull or Replace local.
- **`tabGroups`** — Kartela reads and restores tab group titles, colors, and
  collapsed state so grouped tabs round-trip correctly between the browser
  and the master list.
- **`storage`** — stores the user's GitHub token, Gist ID, active profile,
  and small UI/display caches. No data leaves the browser through this
  permission; it's local (and Chrome-sync) storage only.
- **`alarms`** — drives the optional timed auto-sync feature in Settings.
  Kartela creates a single named alarm, at the user-chosen interval (minimum
  one minute, `chrome.alarms`' own floor), only after the user turns on
  "Sync on a timer"; turning it off deletes the alarm. If a user never
  enables that setting, no alarm is ever created and this permission does
  nothing. It is not used for polling, tracking, or anything besides firing
  that one optional sync.
- **`bookmarks`** — reads the bookmarks bar so its links and folders can be
  pushed to, pulled from, or compared against the user's stored bookmarks
  file, mirroring the tab sync operations. It creates, moves, or removes
  local bookmarks only when the user explicitly clicks "Pull" or "Replace
  local" for bookmarks in the popup (Replace is confirmed first) — or, if
  the user has separately opted into automatic sync, on that same explicit
  opt-in basis for reading; automatic sync never creates or deletes a local
  bookmark, only reads the bar and writes to the backend.
- **Host permission `https://api.github.com/*`** — the only endpoint Kartela
  reads from and writes to: the user's Gist containing their tab profiles.
- **Host permission `https://gist.githubusercontent.com/*`** — fallback used
  to fetch raw file content for profile files too large to be returned
  inline by the Gist metadata API.
- **Optional host permissions `https://*/*` and `http://*/*`** — Kartela
  optionally supports syncing to a user's own self-hosted Forgejo or Gitea
  instance instead of GitHub. Because that instance's URL is chosen by the
  user at setup time and cannot be known in advance, it can't be listed as
  a fixed host permission the way `api.github.com` is. These broad patterns
  are declared only in `optional_host_permissions`, which grants nothing by
  itself — no host is ever accessed at install time, and the background
  service worker (see below) only ever contacts a Forgejo/Gitea host the
  user has already, separately, granted access to at runtime; it requests
  no new permission itself. Access is requested at runtime, from
  `chrome.permissions.request()`,
  scoped to exactly the single origin the user typed (e.g.
  `https://git.example.com/*`, not a wildcard), and only in direct response
  to the user clicking "Validate & Save" in Settings (a live user gesture).
  Chrome shows its own permission prompt naming that specific origin before
  anything is granted; declining it aborts the save with nothing persisted
  and nothing contacted. Users who never enable the Forgejo/Gitea backend
  never see this prompt and Kartela never requests or holds any origin
  beyond the two GitHub hosts above.

No other permissions are requested — no `<all_urls>` in `host_permissions`,
no `activeTab`, no `scripting`, no remote code.

## Submission checklist

- [ ] Chrome Web Store developer account registered (one-time $5 fee).
- [ ] Package the extension: `cd tabula && zip -r ../tabula.zip .` — the Web Store requires `manifest.json` at the root of the zip, so zip the folder's contents, not the folder itself.
- [ ] At least one screenshot at 1280x800 or 640x400 (Chrome Web Store
      requires 1-5 screenshots in one of these two sizes).
- [ ] 128x128 icon is already present at `tabula/icons/icon128.png` — no
      action needed there, only replace it if the art below changes.
- [ ] Single-purpose description ready for the review form: "Sync the
      current window's tabs, tab groups, and bookmarks bar against a master
      list the user stores in their own private GitHub Gist or self-hosted
      Forgejo/Gitea repository, either manually (button-driven) or, if the
      user turns it on in Settings, on a timer or on profile switch." Keep
      the listing consistent with this — reviewers reject listings that
      describe more than the extension actually does, but also reject ones
      that under-describe what it does (e.g. omitting the optional
      automatic sync or the bookmarks sync would be an under-description).
- [ ] The listing's **name** and **short description/summary** are pulled
      automatically from the manifest's localized messages
      (`_locales/en/messages.json` and `_locales/el/messages.json`) — you
      don't type those into the dashboard by hand, they come from
      `__MSG_appName__` / `__MSG_appDesc__` per the browser's UI language.
- [ ] The **detailed description**, however, is not localized by the
      manifest — Chrome Web Store has no `__MSG_*` support for that field.
      It must be entered separately, per language, in the dashboard's
      listing editor: the English draft above in the English listing slot,
      and the full text under "Greek listing (Ελληνικά)" above in the Greek
      listing slot.
- [ ] Privacy policy text above published at a public URL and linked in the
      dashboard's Privacy practices tab.
- [ ] **Replace the placeholder icons** (`tabula/icons/icon16.png`,
      `icon32.png`, `icon48.png`, `icon128.png`) with real artwork before
      submitting — the current set is a generic placeholder generated to
      make the extension load, not store-ready art.
- [ ] This is a rename from Tabula (the extension's former name) to
      Kartela, not a new extension — if updating an existing Web Store
      listing rather than submitting fresh, existing users keep their data
      untouched: nothing migrates, because the storage names (`tabula-data`
      Gist/repo, profile filenames, `_bookmarks.json`) didn't change, only
      the display name and manifest description did.
