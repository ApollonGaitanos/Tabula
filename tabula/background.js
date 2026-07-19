/*
 * background.js — timed auto-sync service worker.
 *
 * WHY A BACKGROUND WORKER NOW EXISTS: the original Kartela design forbade one —
 * every sync was a deliberate button press in the popup. The owner has since
 * explicitly asked for timed, unattended sync, which the popup cannot provide
 * (it only runs while open). A single chrome.alarms-driven worker is the
 * minimal way to do that. It is READ-ONLY toward the browser: it reads a
 * window's tabs and writes to the backend. It NEVER opens windows, shows
 * dialogs, or closes/moves local tabs. It always targets the IN-USE profile
 * (activeProfile in storage.local); previewing a profile in the popup never
 * changes that. The outgoing-profile sync tied to "Use this profile" lives in
 * the popup, not here.
 *
 * This is a classic (non-module) worker: it pulls in the shared helpers via
 * importScripts. common.js is DOM-free, so every helper it defines
 * (getBackendConfig, makeProvider, getTabsOfWindow, storage wrappers, URL
 * utilities, TabulaError) is safe to run in this context.
 */

importScripts("common.js");

/* ------------------------------------------------------------------ *
 * Constants / defaults
 * ------------------------------------------------------------------ */

// A single named alarm drives the whole feature; recreating it replaces any
// prior schedule, so there is never more than one.
const AUTO_SYNC_ALARM = "tabula-autosync";

// The interval bounds/clamp (AUTO_SYNC_MIN_MINUTES, AUTO_SYNC_DEFAULT_MINUTES,
// clampAutoSyncMinutes) now live in common.js so this worker and the settings
// page apply identical rules; they're in scope here via importScripts.

// Guards the alarm handler against re-entrancy: chrome.alarms can fire the next
// tick while a slow previous run is still in flight. The Web Locks mutex already
// protects backend writes, but this flag also stops two ticks from doing the
// redundant read/compute work at once.
let autoSyncInFlight = false;

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

// Read the auto-sync settings from chrome.storage.sync, applying defaults and
// clamps so the rest of the worker can trust the returned shape.
async function getAutoSyncSettings() {
  const items = await storageGet("sync", [
    "autoSyncEnabled",
    "autoSyncMinutes",
    "autoSyncMode",
    "autoSyncBookmarks",
  ]);
  return {
    autoSyncEnabled: !!items.autoSyncEnabled,
    // Number → round → clamp to [1, 1440], NaN → default. Shared with the
    // settings page so the stored value and the schedule always agree.
    autoSyncMinutes: clampAutoSyncMinutes(items.autoSyncMinutes),
    autoSyncMode: items.autoSyncMode === "replace" ? "replace" : "push",
    autoSyncBookmarks: !!items.autoSyncBookmarks,
  };
}

/* ------------------------------------------------------------------ *
 * Alarm lifecycle
 * ------------------------------------------------------------------ */

function clearAutoSyncAlarm() {
  return new Promise((resolve) => {
    try {
      chrome.alarms.clear(AUTO_SYNC_ALARM, () => resolve());
    } catch (e) {
      resolve();
    }
  });
}

// (Re)create or clear the single named alarm to match current settings. Called
// on install, on startup, and whenever the relevant sync settings change.
async function reconcileAutoSyncAlarm() {
  let settings;
  try {
    settings = await getAutoSyncSettings();
  } catch (e) {
    return; // storage unavailable — leave any existing alarm as-is
  }
  await clearAutoSyncAlarm();
  if (!settings.autoSyncEnabled) return;
  try {
    // Await the promise form so an async scheduling failure rejects here rather
    // than vanishing.
    await chrome.alarms.create(AUTO_SYNC_ALARM, {
      periodInMinutes: Math.max(AUTO_SYNC_MIN_MINUTES, settings.autoSyncMinutes),
    });
  } catch (e) {
    // A failed alarm creation would otherwise disable auto-sync forever with no
    // trace. Surface it on the settings status line via lastAutoSync so the user
    // can see that scheduling — not syncing — is what broke.
    await recordAutoSync(false, t("bgScheduleFailed", describeError(e)));
  }
}

/* ------------------------------------------------------------------ *
 * Outcome recording
 * ------------------------------------------------------------------ */

// Persist the last auto-sync result for the settings page to display. This must
// never throw — it runs at the tail of the alarm handler.
function recordAutoSync(ok, message) {
  return storageSet("local", {
    lastAutoSync: {
      at: new Date().toISOString(),
      ok: !!ok,
      message: message || "",
    },
  }).catch(() => {});
}

function describeError(e) {
  if (e && e.message) return e.message;
  return t("errGeneric");
}

/* ------------------------------------------------------------------ *
 * The sync itself
 * ------------------------------------------------------------------ */

// Resolve the last-focused normal browser window, or null. We sync THAT window
// because the worker has no notion of a "current" window; the last window the
// user actually looked at is the most sensible target for unattended sync.
function getLastFocusedNormalWindow() {
  return new Promise((resolve) => {
    try {
      chrome.windows.getLastFocused({ windowTypes: ["normal"] }, (win) => {
        if (chrome.runtime.lastError || !win) resolve(null);
        else resolve(win);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

// Resolve ALL normal browser windows (or [] on error). Used by replace-mode
// auto-sync, which — being destructive — can't trust the arbitrary window that
// getLastFocused may return when Chrome is unfocused with several open.
function getAllNormalWindows() {
  return new Promise((resolve) => {
    try {
      chrome.windows.getAll({ windowTypes: ["normal"] }, (wins) => {
        if (chrome.runtime.lastError || !wins) resolve([]);
        else resolve(wins);
      });
    } catch (e) {
      resolve([]);
    }
  });
}

// Push semantics, mirrored from the popup's doPush: append non-duplicate tabs
// (duplicate = exact URL after stripping one trailing slash), merge group
// metadata for locally-present groups, bump lastModified, write. Returns a
// human-readable summary.
async function autoPush(provider, fileName, master, local) {
  master.tabs = master.tabs || [];
  // The Set/array allocation here is per-tick and bounded by the profile size
  // (a few hundred tabs at most), so it's negligible — deliberately left as-is
  // for readability rather than pooled or hoisted.
  const existing = new Set(master.tabs.map((t) => normalizeUrl(t.url)));
  let added = 0;
  let skipped = 0;
  for (const tab of local.tabs) {
    const key = normalizeUrl(tab.url);
    if (existing.has(key)) {
      skipped++;
      continue;
    }
    master.tabs.push(tab);
    existing.add(key);
    added++;
  }
  master.groups = master.groups || {};
  for (const title of Object.keys(local.groups)) {
    if (!master.groups[title]) master.groups[title] = local.groups[title];
  }
  master.lastModified = new Date().toISOString();
  await provider.writeProfile(fileName, master);
  return t("bgAutoPush", [String(added), String(skipped)]);
}

// Replace semantics: overwrite the profile with the window's full state, but
// keep the displayName from the existing master file. Returns a summary.
async function autoReplace(provider, fileName, master, local) {
  const profile = {
    displayName: master.displayName || fileName.replace(/\.json$/, ""),
    lastModified: new Date().toISOString(),
    tabs: local.tabs,
    groups: local.groups,
  };
  await provider.writeProfile(fileName, profile);
  return t("bgAutoReplace", String(local.tabs.length));
}

// Sync the shared bookmarks set using the SAME mode as the tab sync. This is
// WRITE-ONLY toward the backend: like the rest of this worker it NEVER modifies
// local bookmarks (never creates/removes/moves a bookmark in the browser). It
// reads the local bar and the stored set, and writes only the stored set.
// Returns a short summary to append to the auto-sync message.
async function autoSyncBookmarks(provider, mode) {
  const local = await readBookmarksBar();
  if (mode === "replace") {
    await writeBookmarksMaster(provider, {
      lastModified: new Date().toISOString(),
      bar: local.bar,
    });
    return t("bgBookmarksReplaced", String(countBookmarkLinks(local.bar)));
  }
  const master = await readBookmarksMaster(provider);
  const { bar, added, skipped } = mergeBookmarks(master.bar || [], local.bar);
  await writeBookmarksMaster(provider, {
    lastModified: new Date().toISOString(),
    bar,
  });
  return t("bgBookmarksMerged", [String(added), String(skipped)]);
}

// The alarm handler body. Bails silently (no record) for expected not-ready
// states — not configured, missing host permission, no window, no/absent
// profile — and records ok/error only once an actual sync is attempted.
// NEVER throws: all failures land in lastAutoSync.
async function runAutoSync() {
  // Non-reentrant: if a previous tick is still running, skip this one entirely.
  if (autoSyncInFlight) return;
  autoSyncInFlight = true;
  try {
    const settings = await getAutoSyncSettings();
    if (!settings.autoSyncEnabled) return; // toggled off since the alarm fired

    const config = await getBackendConfig();
    if (!config.configured) return; // no backend connected yet

    // Forgejo talks to a user-supplied host whose access is a runtime grant. If
    // it was revoked, every fetch would fail — skip silently rather than log a
    // spurious error every interval.
    if (config.backend === "forgejo") {
      let granted = false;
      try {
        granted = await permissionsContains([
          forgejoOriginPattern(config.forgejoUrl),
        ]);
      } catch (e) {
        granted = false;
      }
      if (!granted) return;
    }

    // Pick the window to read. The choice is asymmetric by mode ON PURPOSE:
    //   - REPLACE overwrites master from this window, so reading the WRONG one
    //     destroys data. getLastFocused can return an arbitrary window when
    //     Chrome is unfocused with several open, so we refuse to guess: use the
    //     sole window if there's one, the focused one if several, and SKIP the
    //     tick (recording why) if several exist with none focused.
    //   - PUSH is a non-destructive merge (append-only): the worst case from an
    //     arbitrary window is a few extra tabs added to master, never loss, so
    //     the cheaper last-focused pick is fine.
    let win;
    if (settings.autoSyncMode === "replace") {
      const wins = await getAllNormalWindows();
      if (wins.length === 0) return; // no normal window to read
      if (wins.length === 1) {
        win = wins[0];
      } else {
        win = wins.find((w) => w.focused === true) || null;
        if (!win) {
          await recordAutoSync(false, t("bgSkippedMultiWindow"));
          return;
        }
      }
    } else {
      win = await getLastFocusedNormalWindow();
      if (!win) return; // no normal window to read
    }

    const activeFile = await getActiveProfile();
    if (!activeFile) return; // no profile selected

    const provider = makeProvider(config);
    const local = await getTabsOfWindow(win.id);

    // Serialize the backend read-modify-write against manual popup operations
    // and any overlapping tick, via the shared cross-context mutex. Local tab
    // reads (above) and outcome recording (below) stay OUTSIDE the lock to keep
    // its scope tight. Returns null for the "profile gone" bail so the caller
    // records nothing (matching prior behavior).
    const result = await withSyncLock(async () => {
      // Read master fresh; if the profile file is gone, bail silently.
      let master;
      try {
        master = await provider.readProfile(activeFile);
      } catch (e) {
        if (e && e.code === "not_found") return null;
        throw e;
      }

      let ok = true;
      let message =
        settings.autoSyncMode === "replace"
          ? await autoReplace(provider, activeFile, master, local)
          : await autoPush(provider, activeFile, master, local);

      // Optionally also sync the shared bookmarks bar, using the same mode. A
      // bookmark failure now FAILS the recorded outcome (ok:false) instead of
      // leaving a green result with a note tacked on — the sync as a whole did
      // not fully succeed.
      if (settings.autoSyncBookmarks) {
        try {
          message +=
            "; " + (await autoSyncBookmarks(provider, settings.autoSyncMode));
        } catch (e) {
          message += "; " + t("bgBookmarksFailed", describeError(e));
          ok = false;
        }
      }
      return { ok, message };
    });

    if (!result) return; // profile-gone bail: record nothing
    await recordAutoSync(result.ok, result.message);
  } catch (e) {
    await recordAutoSync(false, describeError(e));
  } finally {
    autoSyncInFlight = false;
  }
}

/* ------------------------------------------------------------------ *
 * User-initiated tab surgery (message-driven)
 *
 * The popup gathers everything that needs the DOM or the user (a fresh master
 * fetch for the confirmation count, the confirmation modal, the outgoing
 * switch-sync) and then hands the actual multi-second tab mutation to this
 * worker via a runtime message. WHY: the action popup closes the moment focus
 * leaves it — very likely while 15–20 tabs are opening — which previously
 * aborted the create-before-remove flows halfway and duplicated every tab and
 * group. The worker has no UI to lose, so the op always runs to completion. The
 * outcome is ALSO written to storage.local `lastOpResult` so the NEXT popup
 * open can report what happened even if the popup that started it is long gone.
 *
 * These ops perform NO backend write (they only read master — fetched fresh
 * here immediately before mutating — and change local tabs), so they
 * deliberately do NOT take withSyncLock; that mutex guards backend
 * read-modify-write, which this path never does. User-initiated work like this
 * takes priority over auto-sync regardless (auto-sync's own re-entrancy guard
 * and the lock keep the two from clobbering each other's backend writes).
 * ------------------------------------------------------------------ */

const OP_TYPE = "kartela-op";

// Persist the outcome of a user-initiated op for the next popup to surface.
// `seen:false` lets the popup show it exactly once; a popup that survived the
// op marks it seen itself, so only a popup DEATH leaves it to be shown on the
// next open. Never throws — it runs at the tail of the op handler.
function recordOpResult(op, ok, message) {
  return storageSet("local", {
    lastOpResult: {
      at: new Date().toISOString(),
      op: op || "?",
      ok: !!ok,
      message: message || "",
      seen: false,
    },
  }).catch(() => {});
}

// Perform one user-initiated op against msg.windowId and return a result the
// popup can render directly ({ ok, opened, failed, aborted, nothingToPull,
// message, kind }). ALWAYS records lastOpResult; never throws.
async function handleKartelaOp(msg) {
  const op = msg.op;
  const windowId = msg.windowId;
  try {
    const config = await getBackendConfig();
    if (!config.configured) {
      const message = t("errGeneric");
      await recordOpResult(op, false, message);
      return { ok: false, aborted: false, opened: 0, failed: 0, message, kind: "error" };
    }
    const provider = makeProvider(config);
    // Re-fetch master FRESH inside the worker, immediately before mutating.
    const master = await provider.readProfile(msg.fileName);

    if (op === "pull") {
      const res = await pullMasterIntoWindow(windowId, master);
      let message;
      let kind;
      if (res.nothingToPull) {
        message = t("msgNothingToPull");
        kind = "ok";
      } else {
        message = t("msgOpenedTabs", String(res.opened));
        if (res.failed) message += " " + t("msgTabsFailed", String(res.failed));
        kind = res.failed ? "error" : "ok";
      }
      await recordOpResult(op, true, message);
      return {
        ok: true,
        opened: res.opened,
        failed: res.failed,
        nothingToPull: res.nothingToPull,
        message,
        kind,
      };
    }

    if (op === "replaceLocal") {
      const res = await replaceWindowWithMaster(windowId, master);
      let message;
      let kind;
      let ok;
      if (res.aborted) {
        ok = false;
        message = t("msgNothingOpenedUntouched");
        kind = "error";
      } else {
        ok = true;
        message = t("msgLocalReplaced", String(res.opened));
        if (res.failed) message += " " + t("msgTabsFailed", String(res.failed));
        kind = res.failed ? "error" : "ok";
      }
      await recordOpResult(op, ok, message);
      return {
        ok,
        opened: res.opened,
        failed: res.failed,
        aborted: res.aborted,
        message,
        kind,
      };
    }

    if (op === "useProfile") {
      const res = await replaceWindowWithMaster(windowId, master);
      let message;
      let kind;
      let ok;
      if (res.aborted) {
        // Nothing opened: DON'T move the in-use pointer — still on the old
        // profile, window untouched.
        ok = false;
        message = t("msgNothingStillUsing", msg.inUseName || msg.targetName || "");
        kind = "error";
      } else {
        // Commit the in-use pointer HERE in the worker, so it sticks even if the
        // popup that started this op has already died. (On a reset, msg.fileName
        // already equals the in-use profile, so this is a harmless re-write.)
        await setActiveProfile(msg.fileName);
        ok = true;
        message = msg.isReset
          ? t("msgWindowReset", [msg.targetName || "", String(res.opened)])
          : t("msgNowUsing", [msg.targetName || "", String(res.opened)]);
        if (res.failed) message += " " + t("msgTabsFailed", String(res.failed));
        kind = res.failed ? "error" : "ok";
      }
      await recordOpResult(op, ok, message);
      return {
        ok,
        opened: res.opened,
        failed: res.failed,
        aborted: res.aborted,
        message,
        kind,
      };
    }

    // Unknown op.
    const message = t("errGeneric");
    await recordOpResult(op, false, message);
    return { ok: false, aborted: false, opened: 0, failed: 0, message, kind: "error" };
  } catch (e) {
    const message = describeError(e);
    await recordOpResult(op, false, message);
    return { ok: false, aborted: false, opened: 0, failed: 0, message, kind: "error" };
  }
}

/* ------------------------------------------------------------------ *
 * Listeners
 * ------------------------------------------------------------------ */

// User-initiated tab surgery from the popup. Return true to keep the message
// channel open for the async sendResponse (the op takes several seconds).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== OP_TYPE) return; // not ours — leave the channel be
  handleKartelaOp(msg).then(sendResponse);
  return true;
});

// Recreate the alarm on install and on browser startup (alarms survive worker
// restarts, but reconciling is cheap and keeps the schedule authoritative).
chrome.runtime.onInstalled.addListener(() => {
  reconcileAutoSyncAlarm();
});
chrome.runtime.onStartup.addListener(() => {
  reconcileAutoSyncAlarm();
});

// React to settings edits from the settings page. Only the enable/interval keys
// change the alarm; mode is read fresh at fire time, so it needs no reconcile.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  if (changes.autoSyncEnabled || changes.autoSyncMinutes) {
    reconcileAutoSyncAlarm();
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTO_SYNC_ALARM) runAutoSync();
});
