/*
 * background.js — timed auto-sync service worker.
 *
 * WHY A BACKGROUND WORKER NOW EXISTS: the original Tabula design forbade one —
 * every sync was a deliberate button press in the popup. The owner has since
 * explicitly asked for timed, unattended sync, which the popup cannot provide
 * (it only runs while open). A single chrome.alarms-driven worker is the
 * minimal way to do that. It is READ-ONLY toward the browser: it reads a
 * window's tabs and writes to the backend. It NEVER opens windows, shows
 * dialogs, or closes/moves local tabs. Feature B (sync-on-profile-switch) lives
 * in the popup, not here.
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

// chrome.alarms enforces a 1-minute minimum period; we clamp to it everywhere.
const AUTO_SYNC_MIN_MINUTES = 1;
const AUTO_SYNC_DEFAULT_MINUTES = 15;

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
  let minutes = Number(items.autoSyncMinutes);
  if (!Number.isFinite(minutes) || minutes < AUTO_SYNC_MIN_MINUTES) {
    minutes = AUTO_SYNC_DEFAULT_MINUTES;
  }
  return {
    autoSyncEnabled: !!items.autoSyncEnabled,
    autoSyncMinutes: minutes,
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
    chrome.alarms.create(AUTO_SYNC_ALARM, {
      periodInMinutes: Math.max(AUTO_SYNC_MIN_MINUTES, settings.autoSyncMinutes),
    });
  } catch (e) {
    /* ignore — nothing we can surface from the worker */
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
  return "Something went wrong.";
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

// Push semantics, mirrored from the popup's doPush: append non-duplicate tabs
// (duplicate = exact URL after stripping one trailing slash), merge group
// metadata for locally-present groups, bump lastModified, write. Returns a
// human-readable summary.
async function autoPush(provider, fileName, master, local) {
  master.tabs = master.tabs || [];
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
  return "Auto-push: added " + added + ", skipped " + skipped;
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
  return "Auto-replace: wrote " + local.tabs.length + " tab(s) to master";
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
    return "bookmarks: replaced with " + countBookmarkLinks(local.bar);
  }
  const master = await readBookmarksMaster(provider);
  const { bar, added, skipped } = mergeBookmarks(master.bar || [], local.bar);
  await writeBookmarksMaster(provider, {
    lastModified: new Date().toISOString(),
    bar,
  });
  return "bookmarks: added " + added + ", skipped " + skipped;
}

// The alarm handler body. Bails silently (no record) for expected not-ready
// states — not configured, missing host permission, no window, no/absent
// profile — and records ok/error only once an actual sync is attempted.
// NEVER throws: all failures land in lastAutoSync.
async function runAutoSync() {
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

    const win = await getLastFocusedNormalWindow();
    if (!win) return; // no normal window to read

    const activeFile = await getActiveProfile();
    if (!activeFile) return; // no profile selected

    const provider = makeProvider(config);
    const local = await getTabsOfWindow(win.id);

    // Read master fresh; if the profile file is gone, bail silently.
    let master;
    try {
      master = await provider.readProfile(activeFile);
    } catch (e) {
      if (e && e.code === "not_found") return;
      throw e;
    }

    let message =
      settings.autoSyncMode === "replace"
        ? await autoReplace(provider, activeFile, master, local)
        : await autoPush(provider, activeFile, master, local);

    // Optionally also sync the shared bookmarks bar, using the same mode. A
    // bookmark failure is appended to the message but does not fail the (already
    // successful) tab sync.
    if (settings.autoSyncBookmarks) {
      try {
        message += "; " + (await autoSyncBookmarks(provider, settings.autoSyncMode));
      } catch (e) {
        message += "; bookmarks failed: " + describeError(e);
      }
    }

    await recordAutoSync(true, message);
  } catch (e) {
    await recordAutoSync(false, describeError(e));
  }
}

/* ------------------------------------------------------------------ *
 * Listeners
 * ------------------------------------------------------------------ */

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
