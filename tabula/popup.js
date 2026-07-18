/*
 * popup.js — the whole Tabula UI. No background worker exists; every action
 * is user-initiated from here. common.js (loaded first) provides storage and
 * Gist helpers plus getCurrentTabs().
 */

(function () {
  "use strict";

  // In-memory session state. The master snapshot is display-only and is never
  // trusted for an operation — every operation re-fetches the master fresh.
  const state = {
    provider: null, // backend provider (GitHub Gist or Forgejo)
    backend: "github", // "github" | "forgejo" — also scopes the display cache
    profiles: [], // [{ fileName, displayName }]
    // The "in use" profile: persisted as activeProfile in storage.local and the
    // sole target of background auto-sync. "Update" acts on it; "Use this
    // profile" changes it.
    inUseFile: null,
    // The "previewed" profile: the dropdown selection. In-memory ONLY — it
    // resets to inUseFile on every popup open. Picking a profile in the dropdown
    // only previews it (status row + rename/delete + Advanced ops); it never
    // writes storage, changes tabs, or syncs.
    previewFile: null,
    master: null, // last-fetched master profile object (for display)
    busy: false,
  };

  // Cached DOM references.
  const el = {};

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    cacheElements();
    wireEvents();
    let config;
    try {
      config = await getBackendConfig();
    } catch (e) {
      // Storage failure is fatal for the popup; show it and stop.
      return showFatal(describeError(e));
    }

    if (!config.configured) {
      el.noToken.classList.remove("hidden");
      return;
    }

    // Forgejo talks to a user-supplied host whose access is granted at runtime
    // (optional host permission). If that grant was revoked since setup, every
    // fetch would fail — so check it up front and, if missing, fall back to the
    // not-configured state pointing the user to Settings.
    if (config.backend === "forgejo") {
      let granted = false;
      try {
        granted = await permissionsContains([
          forgejoOriginPattern(config.forgejoUrl),
        ]);
      } catch (e) {
        granted = false;
      }
      if (!granted) {
        el.noToken.classList.remove("hidden");
        el.noToken.querySelector(".no-token-msg").textContent =
          "Access to " +
          config.forgejoUrl +
          " isn't granted. Reconnect in Settings.";
        return;
      }
    }

    state.backend = config.backend;
    state.provider = makeProvider(config);

    el.main.classList.remove("hidden");
    // loadProfiles runs on the initial load path (outside guarded()), so its
    // errors — 401, rate limit, network — must be surfaced here or the popup
    // would sit on "Loading profiles…" with no feedback.
    try {
      await loadProfiles();
    } catch (e) {
      showFeedback(describeError(e), "error");
    }
  }

  function cacheElements() {
    el.main = byId("main");
    el.noToken = byId("no-token");
    el.profileSelect = byId("profile-select");
    el.renameBtn = byId("rename-btn");
    el.deleteBtn = byId("delete-btn");
    el.settingsBtn = byId("settings-btn");
    el.refreshBtn = byId("refresh-btn");
    el.previewHint = byId("preview-hint");
    el.localCount = byId("local-count");
    el.masterCount = byId("master-count");
    el.masterModified = byId("master-modified");
    el.useProfileBtn = byId("use-profile-btn");
    el.updateBtn = byId("update-btn");
    el.pushBtn = byId("push-btn");
    el.pullBtn = byId("pull-btn");
    el.replaceLocalBtn = byId("replace-local-btn");
    el.replaceMasterBtn = byId("replace-master-btn");
    // Bookmarks-bar action buttons (mirror the four tab operations).
    el.bmPushBtn = byId("bm-push-btn");
    el.bmPullBtn = byId("bm-pull-btn");
    el.bmReplaceLocalBtn = byId("bm-replace-local-btn");
    el.bmReplaceMasterBtn = byId("bm-replace-master-btn");
    el.feedback = byId("feedback");
    el.openSettingsBtn = byId("open-settings-btn");
    // Modal
    el.modalOverlay = byId("modal-overlay");
    el.modalMessage = byId("modal-message");
    el.modalInput = byId("modal-input");
    el.modalError = byId("modal-error");
    el.modalButtons = byId("modal-buttons");
  }

  function wireEvents() {
    el.settingsBtn.addEventListener("click", openSettings);
    el.openSettingsBtn.addEventListener("click", openSettings);
    el.refreshBtn.addEventListener("click", () => guarded(refreshStatus));
    el.profileSelect.addEventListener("change", onProfileChange);
    el.renameBtn.addEventListener("click", () => guarded(onRename));
    el.deleteBtn.addEventListener("click", () => guarded(onDelete));
    el.useProfileBtn.addEventListener("click", () => guarded(doUseProfile));
    el.updateBtn.addEventListener("click", () => guarded(doUpdate));
    el.pushBtn.addEventListener("click", () => guarded(doPush));
    el.pullBtn.addEventListener("click", () => guarded(doPull));
    el.replaceLocalBtn.addEventListener("click", () => guarded(doReplaceLocal));
    el.replaceMasterBtn.addEventListener("click", () =>
      guarded(doReplaceMaster)
    );
    el.bmPushBtn.addEventListener("click", () => guarded(doBookmarksPush));
    el.bmPullBtn.addEventListener("click", () => guarded(doBookmarksPull));
    el.bmReplaceLocalBtn.addEventListener("click", () =>
      guarded(doBookmarksReplaceLocal)
    );
    el.bmReplaceMasterBtn.addEventListener("click", () =>
      guarded(doBookmarksReplaceMaster)
    );
  }

  function openSettings() {
    // Open settings in a full tab (no options_page is declared, so we navigate
    // directly). window.close() dismisses the popup afterward.
    chrome.tabs.create({ url: chrome.runtime.getURL("settings.html") });
    window.close();
  }

  /* ----------------------------------------------------------------- *
   * Busy-guard: serialize operations and disable buttons while running.
   * ----------------------------------------------------------------- */

  async function guarded(fn) {
    if (state.busy) return;
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      showFeedback(describeError(e), "error");
    } finally {
      setBusy(false);
    }
  }

  function setBusy(busy) {
    state.busy = busy;
    // Controls that are simply on when idle and off while busy.
    const controls = [
      el.refreshBtn,
      el.profileSelect,
      el.pushBtn,
      el.pullBtn,
      el.replaceLocalBtn,
      el.replaceMasterBtn,
      el.bmPushBtn,
      el.bmPullBtn,
      el.bmReplaceLocalBtn,
      el.bmReplaceMasterBtn,
    ];
    controls.forEach((c) => (c.disabled = busy));
    // The "smart" buttons (Use / Update / Rename / Delete) also depend on the
    // preview-vs-in-use relationship, so their state is computed centrally.
    updateActionAvailability();
  }

  // Recompute the enabled state, labels, and preview hint for the buttons whose
  // availability depends on the previewed and in-use profiles. Safe to call any
  // time; it always folds in state.busy so it can't re-enable mid-operation.
  function updateActionAvailability() {
    const hasSelection = !!state.previewFile;
    const previewIsInUse =
      hasSelection && state.previewFile === state.inUseFile;

    // Rename/delete act on the PREVIEWED profile.
    el.renameBtn.disabled = state.busy || !hasSelection;
    el.deleteBtn.disabled = state.busy || !hasSelection;

    // "Use this profile" makes the previewed profile the one in use — pointless
    // (and disabled) when it already is, or when nothing is selected.
    el.useProfileBtn.disabled =
      state.busy || !hasSelection || previewIsInUse;

    // "Update" acts on the IN-USE profile regardless of what's previewed.
    el.updateBtn.disabled = state.busy || !state.inUseFile;
    const inUse = inUseProfileMeta();
    // Make the target unambiguous when previewing a different profile.
    el.updateBtn.textContent =
      inUse && !previewIsInUse ? "Update '" + inUse.displayName + "'" : "Update";

    // Subtle inline hint whenever the preview differs from what's in use.
    if (hasSelection && state.inUseFile && !previewIsInUse) {
      el.previewHint.textContent =
        "Previewing — tabs unchanged. In use: " +
        (inUse ? inUse.displayName : state.inUseFile) +
        ".";
      el.previewHint.classList.remove("hidden");
    } else {
      el.previewHint.textContent = "";
      el.previewHint.classList.add("hidden");
    }
  }

  /* ----------------------------------------------------------------- *
   * Profiles
   * ----------------------------------------------------------------- */

  async function loadProfiles() {
    showFeedback("Loading profiles…");
    let profiles;
    try {
      profiles = await state.provider.listProfiles();
    } catch (e) {
      if (e.code === "not_found") {
        // The stored container (gist/repo) no longer exists.
        return offerRecreateContainer();
      }
      throw e;
    }
    state.profiles = profiles;

    if (profiles.length === 0) {
      // First launch: token works, gist exists, but no profiles yet.
      populateSelect();
      showFeedback("No profiles yet. Create your first one.");
      await promptFirstProfile();
      return;
    }

    // Restore the previously in-use profile if it still exists.
    const stored = await getActiveProfile();
    const found = profiles.find((p) => p.fileName === stored);
    state.inUseFile = found ? found.fileName : profiles[0].fileName;
    await setActiveProfile(state.inUseFile);
    // The dropdown always opens on the in-use profile — preview is ephemeral.
    state.previewFile = state.inUseFile;

    populateSelect();
    await refreshStatus();
  }

  function populateSelect() {
    el.profileSelect.innerHTML = "";
    for (const p of state.profiles) {
      const opt = document.createElement("option");
      opt.value = p.fileName;
      opt.textContent = p.displayName;
      // The dropdown reflects the PREVIEWED profile, not the in-use one.
      if (p.fileName === state.previewFile) opt.selected = true;
      el.profileSelect.appendChild(opt);
    }
    const newOpt = document.createElement("option");
    newOpt.value = "__new__";
    newOpt.textContent = "New profile…";
    el.profileSelect.appendChild(newOpt);

    updateActionAvailability();
  }

  async function onProfileChange() {
    const value = el.profileSelect.value;
    if (value === "__new__") {
      // Reset the select back to the previewed profile; the picker isn't the
      // commit — the modal is.
      el.profileSelect.value = state.previewFile || "";
      await guarded(onNewProfile);
      return;
    }

    // PREVIEW ONLY. Picking a profile just previews it: refresh the status row
    // for that profile and update the hint/buttons. It makes NO write, changes
    // NO tabs, and syncs NOTHING — the in-use profile is untouched until the
    // user presses "Use this profile".
    state.previewFile = value;
    updateActionAvailability();
    await guarded(refreshStatus);
  }

  // Sync-on-switch core: if "sync on switch" is enabled, sync this window into
  // the OUTGOING (in-use) profile using the chosen mode. Invoked from "Use this
  // profile" (never from the dropdown). Never throws and never blocks — returns
  // { text, kind } describing what happened, or null when disabled.
  async function maybeSyncOnSwitch(outgoingFile) {
    let settings;
    try {
      settings = await storageGet("sync", [
        "switchSyncEnabled",
        "switchSyncMode",
      ]);
    } catch (e) {
      return null;
    }
    if (!settings.switchSyncEnabled) return null;

    const meta = state.profiles.find((p) => p.fileName === outgoingFile);
    const label = meta ? meta.displayName : outgoingFile;
    const mode = settings.switchSyncMode === "replace" ? "replace" : "push";
    showFeedback("Syncing '" + label + "' before switching…");
    try {
      if (mode === "replace") {
        await replaceMasterFile(outgoingFile);
      } else {
        await pushLocalToProfile(outgoingFile);
      }
      return { text: "Synced '" + label + "' before switching.", kind: "ok" };
    } catch (e) {
      return {
        text: "Couldn't sync '" + label + "': " + describeError(e),
        kind: "error",
      };
    }
  }

  async function promptFirstProfile() {
    const name = await modalPrompt({
      message: "Name your first profile:",
      placeholder: "e.g. Work",
      confirmLabel: "Create",
      validate: validateProfileName,
    });
    if (name == null) return; // user cancelled — leave empty state
    await createProfile(name, "current");
  }

  async function onNewProfile() {
    const name = await modalPrompt({
      message: "Name the new profile:",
      placeholder: "e.g. Reading",
      confirmLabel: "Next",
      validate: validateProfileName,
    });
    if (name == null) return;

    // Ask whether to seed the new profile empty or from the current tabs.
    const choice = await modalChoice({
      message: 'Start "' + name + '" empty or from current tabs?',
      buttons: [
        { label: "Cancel", value: null },
        { label: "Empty", value: "empty" },
        { label: "From current tabs", value: "current", primary: true },
      ],
    });
    if (choice == null) return;
    await createProfile(name, choice);
  }

  // Validate a display name and guard against filename collisions.
  function validateProfileName(name) {
    const trimmed = (name || "").trim();
    if (!trimmed) return "Enter a name.";
    const fileName = profileFileName(trimmed);
    if (state.profiles.some((p) => p.fileName === fileName)) {
      return "A profile with a similar name already exists.";
    }
    return null;
  }

  async function createProfile(displayName, seed) {
    showFeedback("Creating profile…");
    const fileName = profileFileName(displayName);
    let tabs = [];
    let groups = {};
    if (seed === "current") {
      const current = await getCurrentTabs();
      tabs = current.tabs;
      groups = current.groups;
    }
    const profile = {
      displayName: displayName.trim(),
      lastModified: new Date().toISOString(),
      tabs,
      groups,
    };
    await state.provider.writeProfile(fileName, profile);

    state.profiles.push({ fileName, displayName: displayName.trim() });
    state.profiles.sort((a, b) => a.displayName.localeCompare(b.displayName));
    // A freshly created profile becomes both the in-use and the previewed one.
    state.inUseFile = fileName;
    state.previewFile = fileName;
    await setActiveProfile(fileName);
    populateSelect();
    await refreshStatus();
    showFeedback('Created profile "' + displayName.trim() + '".', "ok");
  }

  async function onRename() {
    const target = previewProfileMeta();
    if (!target) return;
    const name = await modalPrompt({
      message: "Rename profile:",
      value: target.displayName,
      confirmLabel: "Rename",
      validate: (n) => {
        const trimmed = (n || "").trim();
        if (!trimmed) return "Enter a name.";
        const fileName = profileFileName(trimmed);
        // Allow keeping the same file; only collide with OTHER profiles.
        if (
          fileName !== target.fileName &&
          state.profiles.some((p) => p.fileName === fileName)
        ) {
          return "A profile with a similar name already exists.";
        }
        return null;
      },
    });
    if (name == null) return;

    showFeedback("Renaming…");
    // Re-fetch fresh so we rename the current content, not a stale cache.
    const profile = await state.provider.readProfile(target.fileName);
    profile.displayName = name.trim();
    profile.lastModified = new Date().toISOString();
    const newFileName = profileFileName(name.trim());

    // Provider handles the rename (single gist PATCH, or write-then-delete on
    // Forgejo).
    await state.provider.renameProfile(target.fileName, newFileName, profile);

    // Update local state.
    const wasInUse = state.inUseFile === target.fileName;
    const idx = state.profiles.findIndex((p) => p.fileName === target.fileName);
    if (idx >= 0) {
      state.profiles[idx] = {
        fileName: newFileName,
        displayName: name.trim(),
      };
    }
    state.profiles.sort((a, b) => a.displayName.localeCompare(b.displayName));
    state.previewFile = newFileName;
    // If the renamed profile was the one in use, its stored filename moves too.
    if (wasInUse) {
      state.inUseFile = newFileName;
      await setActiveProfile(newFileName);
    }
    populateSelect();
    await refreshStatus();
    showFeedback('Renamed to "' + name.trim() + '".', "ok");
  }

  async function onDelete() {
    const target = previewProfileMeta();
    if (!target) return;
    if (state.profiles.length <= 1) {
      showFeedback("Can't delete the only profile.", "error");
      return;
    }

    // Typed-name confirmation: the user must type the exact display name.
    const confirmed = await modalTypedConfirm({
      message:
        'Delete profile "' +
        target.displayName +
        '"? This removes it from the Gist and cannot be undone.\n\nType the profile name to confirm:',
      expected: target.displayName,
      confirmLabel: "Delete",
    });
    if (!confirmed) return;

    showFeedback("Deleting…");
    await state.provider.deleteProfile(target.fileName);

    const wasInUse = state.inUseFile === target.fileName;
    state.profiles = state.profiles.filter(
      (p) => p.fileName !== target.fileName
    );
    // Preview falls back to the first remaining profile.
    state.previewFile = state.profiles[0].fileName;
    // If the deleted profile was in use, move the in-use pointer too.
    if (wasInUse) {
      state.inUseFile = state.profiles[0].fileName;
      await setActiveProfile(state.inUseFile);
    }
    populateSelect();
    await refreshStatus();
    showFeedback('Deleted "' + target.displayName + '".', "ok");
  }

  // Metadata of the PREVIEWED (dropdown) profile.
  function previewProfileMeta() {
    return state.profiles.find((p) => p.fileName === state.previewFile) || null;
  }

  // Metadata of the IN-USE profile.
  function inUseProfileMeta() {
    return state.profiles.find((p) => p.fileName === state.inUseFile) || null;
  }

  /* ----------------------------------------------------------------- *
   * Status row
   * ----------------------------------------------------------------- */

  async function refreshStatus() {
    // The status row reflects the PREVIEWED profile's master vs. the live window.
    if (!state.previewFile) {
      el.localCount.textContent = "—";
      el.masterCount.textContent = "—";
      el.masterModified.textContent = "—";
      return;
    }
    showFeedback("Refreshing…");

    // Show the cached snapshot immediately (display only) for snappiness while
    // the fresh fetch is in flight. The cache is never used for operations.
    const cached = await getMasterCache(state.previewFile);
    if (cached) {
      el.masterCount.textContent = String(cached.tabsCount);
      el.masterModified.textContent = formatTimestamp(cached.lastModified);
    }

    // Local count from the live window.
    const local = await getCurrentTabs();
    el.localCount.textContent = String(local.tabs.length);

    // Master is always fetched fresh; we cache it only for display.
    const master = await state.provider.readProfile(state.previewFile);
    state.master = master;
    el.masterCount.textContent = String((master.tabs || []).length);
    el.masterModified.textContent = formatTimestamp(master.lastModified);
    await setMasterCache(state.previewFile, {
      tabsCount: (master.tabs || []).length,
      lastModified: master.lastModified,
    });
    showFeedback("");
  }

  /* ----------------------------------------------------------------- *
   * Operation 1: Push (merge current tabs into master)
   * ----------------------------------------------------------------- */

  // Merge the current window's tabs into a NAMED profile file (Push semantics).
  // No DOM, no confirmation — shared by the Push button and Feature B's
  // sync-on-switch (which targets the OUTGOING profile). Returns
  // { master, added, skipped }.
  async function pushLocalToProfile(fileName) {
    const local = await getCurrentTabs();
    // Always re-fetch master immediately before writing.
    const master = await state.provider.readProfile(fileName);

    // Tolerate a hand-edited profile missing its tabs array.
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

    // Merge group metadata: groups present locally but not in master are added.
    master.groups = master.groups || {};
    for (const title of Object.keys(local.groups)) {
      if (!master.groups[title]) master.groups[title] = local.groups[title];
    }

    master.lastModified = new Date().toISOString();
    await state.provider.writeProfile(fileName, master);
    return { master, added, skipped };
  }

  async function doPush() {
    requireSelected();
    showFeedback("Pushing to master…");
    const { master, added, skipped } = await pushLocalToProfile(
      state.previewFile
    );
    state.master = master;
    el.masterCount.textContent = String(master.tabs.length);
    el.masterModified.textContent = formatTimestamp(master.lastModified);

    showFeedback(
      "Added " +
        added +
        plural(added, " tab", " tabs") +
        " to master, " +
        skipped +
        plural(skipped, " duplicate", " duplicates") +
        " skipped.",
      "ok"
    );
  }

  /* ----------------------------------------------------------------- *
   * Operation 2: Pull (merge master tabs into local)
   * ----------------------------------------------------------------- */

  async function doPull() {
    requireSelected();
    showFeedback("Pulling from master…");
    const local = await getCurrentTabs();
    const master = await state.provider.readProfile(state.previewFile);

    const openUrls = new Set(local.tabs.map((t) => normalizeUrl(t.url)));
    const toOpen = (master.tabs || []).filter(
      (t) => !openUrls.has(normalizeUrl(t.url))
    );

    if (toOpen.length === 0) {
      showFeedback("Nothing to pull — everything is already open.", "ok");
      return;
    }

    // Chrome requires tabs to exist before chrome.tabs.group(), so we create
    // ALL tabs first (in master order), then group them.
    const created = [];
    let failed = 0;
    for (const tab of toOpen) {
      let newTab;
      try {
        newTab = await chromeCall((cb) =>
          chrome.tabs.create({ url: tab.url, active: false, pinned: !!tab.pinned }, cb)
        );
      } catch (e) {
        // Chrome refuses to open some URLs via tabs.create (chrome:// pages,
        // another extension's pages, javascript:, malformed URLs). One bad URL
        // must not abort the whole pull — skip it and report the count.
        failed++;
        continue;
      }
      created.push({ tabId: newTab.id, group: tab.group, pinned: !!tab.pinned });
    }

    // reuseExisting=true: Pull adds tabs alongside whatever's already open, so
    // if a group with this title already exists in the window (e.g. the user
    // never closed "Test" from a previous pull), fold the new tabs into it
    // instead of stacking a second same-titled group beside it.
    await applyGroups(created, master.groups || {}, true);

    await refreshStatus();
    let msg =
      "Opened " + created.length + plural(created.length, " tab", " tabs") + ".";
    if (failed) {
      msg +=
        " " + failed + plural(failed, " tab", " tabs") + " couldn't be opened.";
    }
    showFeedback(msg, failed ? "error" : "ok");
  }

  /* ----------------------------------------------------------------- *
   * Operation 3: Replace local (make the window exactly match master)
   * ----------------------------------------------------------------- */

  async function doReplaceLocal() {
    requireSelected();
    const master = await state.provider.readProfile(state.previewFile);

    const confirmed = await modalConfirm({
      message:
        "Replace local with master?\n\nThis CLOSES every tab in this window and reopens the " +
        (master.tabs || []).length +
        " master tab(s) exactly. Unsaved local tabs will be lost.",
      confirmLabel: "Replace local",
      danger: true,
    });
    if (!confirmed) return;

    showFeedback("Replacing local…");
    const res = await replaceWindowWithMaster(master);
    if (res.aborted) {
      showFeedback(
        "Nothing could be opened — the window was left untouched.",
        "error"
      );
      return;
    }

    await refreshStatus();
    let msg =
      "Local replaced with " +
      res.opened +
      plural(res.opened, " tab", " tabs") +
      " from master.";
    if (res.failed) {
      msg +=
        " " +
        res.failed +
        plural(res.failed, " tab", " tabs") +
        " couldn't be opened.";
    }
    showFeedback(msg, res.failed ? "error" : "ok");
  }

  // Shared create-before-remove core for making the current window match a
  // master exactly. Used by both "Replace local" (Advanced) and "Use this
  // profile". The caller is responsible for confirming and for fetching `master`
  // fresh; this function owns only the tab surgery and does NOT touch feedback,
  // refreshStatus, or any profile pointer. Returns
  // { opened, failed, aborted } — `aborted` is true only when EVERY create
  // failed, in which case the window is left exactly as it was.
  async function replaceWindowWithMaster(master) {
    // create-before-remove ordering: DON'T empty the window first. Emptying it
    // makes Chrome activate whatever remains — and if that's the New Tab Page,
    // the NTP grabs browser-UI focus for its search box, which closes the action
    // popup. Since all our logic runs in the popup's JS context, losing the
    // popup mid-operation aborts everything and strands the window blank. So we
    // create the new tabs (and group them) while the originals still exist — the
    // window never empties — and remove the originals as the very LAST tab op.
    // This also fails safe: if creation goes wrong we can bail without having
    // closed anything.

    // Record the ids of the tabs to replace BEFORE creating anything, so the
    // create step can't sweep the new tabs into this set.
    const currentTabs = await chromeCall((cb) =>
      chrome.tabs.query({ currentWindow: true }, cb)
    );
    const oldIds = currentTabs.map((t) => t.id);

    const toOpen = master.tabs || [];

    if (toOpen.length > 0) {
      // Recreate master state exactly, in order, while the originals still
      // exist. New pinned tabs are clamped to the pinned region (right after any
      // existing pinned tabs) and new unpinned tabs append at the end; order
      // WITHIN the new pinned run and WITHIN the new unpinned run each preserve
      // master order. So once oldIds are removed, the remaining layout is exactly
      // master order. Grouping happens before the removal and touches only the
      // new tabs.
      const created = [];
      let failed = 0;
      for (const tab of toOpen) {
        let newTab;
        try {
          newTab = await chromeCall((cb) =>
            chrome.tabs.create(
              { url: tab.url, active: false, pinned: !!tab.pinned },
              cb
            )
          );
        } catch (e) {
          // Chrome refuses to open some URLs (chrome:// pages, another
          // extension's pages, javascript:, malformed URLs). Skip the bad one so
          // one entry can't abort the restore.
          failed++;
          continue;
        }
        created.push({
          tabId: newTab.id,
          group: tab.group,
          pinned: !!tab.pinned,
        });
      }

      if (created.length === 0) {
        // Every create failed: don't close anything — leave the window exactly
        // as it was and let the caller tell the user nothing could be opened.
        return { opened: 0, failed, aborted: true };
      }

      // reuseExisting is omitted (false): this must keep creating fresh groups.
      // Any same-titled group currently in the window belongs to the outgoing
      // tabs and is destroyed once oldIds are removed below — reusing it would
      // fold the new tabs into a group that's about to vanish (or, worse, drag
      // them into its old position), breaking the exact-layout guarantee.
      await applyGroups(created, master.groups || {});

      // The new tabs now populate the window; removing the originals is the LAST
      // tab op. Chrome auto-activates a neighboring (new) regular page, which
      // doesn't steal browser-UI focus the way the NTP does — the popup survives.
      // Even if it didn't, this removal is already dispatched and the window ends
      // in the correct final state.
      await chromeCall((cb) => chrome.tabs.remove(oldIds, cb));

      return { opened: created.length, failed, aborted: false };
    }

    // Master is empty: minimal survivor path. Create one blank tab so the window
    // doesn't close when the originals go, then remove the originals. That
    // removal is the final action — if the NTP steals focus and closes the popup
    // afterward, the operation is already complete; only the caller's feedback
    // line is lost (acceptable).
    await chromeCall((cb) =>
      chrome.tabs.create({ url: "chrome://newtab", active: false }, cb)
    );
    await chromeCall((cb) => chrome.tabs.remove(oldIds, cb));

    return { opened: 0, failed: 0, aborted: false };
  }

  /* ----------------------------------------------------------------- *
   * Operation 4: Replace master (overwrite master with current window)
   * ----------------------------------------------------------------- */

  async function doReplaceMaster() {
    requireSelected();
    const local = await getCurrentTabs();
    const target = previewProfileMeta();

    const confirmed = await modalConfirm({
      message:
        'Replace master with local?\n\nThis OVERWRITES profile "' +
        target.displayName +
        '" with the current window (' +
        local.tabs.length +
        " tab(s)). The previous master content is discarded.",
      confirmLabel: "Replace master",
      danger: true,
    });
    if (!confirmed) return;

    showFeedback("Replacing master…");
    const profile = await replaceMasterFile(state.previewFile);
    state.master = profile;
    el.masterCount.textContent = String(profile.tabs.length);
    el.masterModified.textContent = formatTimestamp(profile.lastModified);
    showFeedback(
      "Master replaced with " +
        profile.tabs.length +
        plural(profile.tabs.length, " tab", " tabs") +
        " from this window.",
      "ok"
    );
  }

  /* ----------------------------------------------------------------- *
   * Primary action: Use this profile
   *
   * Makes the PREVIEWED profile the one in use and replaces this window's tabs
   * with that profile's master (the Replace-local machinery). Before touching
   * any tab, optionally syncs the OUTGOING in-use profile so profiles can be
   * round-tripped without losing tabs. Disabled when the previewed profile is
   * already in use (so there is never an outgoing == incoming case here).
   * ----------------------------------------------------------------- */

  async function doUseProfile() {
    requireSelected();
    // The button is disabled in this case; guard defensively anyway.
    if (state.previewFile === state.inUseFile) return;

    const target = previewProfileMeta();
    const targetName = target ? target.displayName : state.previewFile;

    // Fresh master fetch (like Replace local): drives the confirmation count and
    // the tab surgery.
    const master = await state.provider.readProfile(state.previewFile);

    const confirmed = await modalConfirm({
      message:
        'Use "' +
        targetName +
        '"?\n\nThis CLOSES every tab in this window and reopens the ' +
        (master.tabs || []).length +
        " tab(s) from that profile. Unsaved local tabs will be lost.",
      confirmLabel: "Use this profile",
      danger: true,
    });
    if (!confirmed) return;

    // BEFORE replacing tabs: optionally sync the OUTGOING (in-use) profile, so
    // the window we're about to close is first saved into the profile we're
    // leaving. This must happen before any tab is touched. A failure warns but
    // does NOT block the switch (surfaced with the final message below).
    let switchNote = null;
    if (state.inUseFile && state.inUseFile !== state.previewFile) {
      switchNote = await maybeSyncOnSwitch(state.inUseFile);
    }

    showFeedback("Switching profile…");
    const res = await replaceWindowWithMaster(master);
    if (res.aborted) {
      // Nothing could be opened: do NOT switch the in-use pointer — the window
      // is untouched and we're still using the previous profile.
      const inUse = inUseProfileMeta();
      let msg =
        "Nothing could be opened — still using '" +
        (inUse ? inUse.displayName : state.inUseFile) +
        "'.";
      if (switchNote && switchNote.kind === "error") {
        msg = switchNote.text + " " + msg;
      }
      showFeedback(msg, "error");
      return;
    }

    // Commit the switch: the previewed profile is now the one in use.
    state.inUseFile = state.previewFile;
    await setActiveProfile(state.inUseFile);
    await refreshStatus();
    updateActionAvailability();

    let msg =
      "Now using '" +
      targetName +
      "' — opened " +
      res.opened +
      plural(res.opened, " tab", " tabs") +
      ".";
    if (res.failed) {
      msg +=
        " " +
        res.failed +
        plural(res.failed, " tab", " tabs") +
        " couldn't be opened.";
    }
    const hadSyncError = switchNote && switchNote.kind === "error";
    if (hadSyncError) msg = switchNote.text + " " + msg;
    showFeedback(msg, res.failed || hadSyncError ? "error" : "ok");
  }

  /* ----------------------------------------------------------------- *
   * Primary action: Update
   *
   * Overwrites the IN-USE profile's master with the current window (Replace
   * master), regardless of what's previewed.
   * ----------------------------------------------------------------- */

  async function doUpdate() {
    if (!state.inUseFile) {
      throw new TabulaError("No profile in use yet.", "generic");
    }
    const inUse = inUseProfileMeta();
    const inUseName = inUse ? inUse.displayName : state.inUseFile;
    const local = await getCurrentTabs();

    const confirmed = await modalConfirm({
      message:
        'Replace master with local?\n\nThis OVERWRITES profile "' +
        inUseName +
        '" with the current window (' +
        local.tabs.length +
        " tab(s)). The previous master content is discarded.",
      confirmLabel: "Update",
      danger: true,
    });
    if (!confirmed) return;

    showFeedback("Updating master…");
    const profile = await replaceMasterFile(state.inUseFile);
    // Only refresh the status display if the in-use profile is also the one
    // being previewed (otherwise the status row shows a different profile).
    if (state.previewFile === state.inUseFile) {
      state.master = profile;
      el.masterCount.textContent = String(profile.tabs.length);
      el.masterModified.textContent = formatTimestamp(profile.lastModified);
    }
    showFeedback(
      "Updated '" +
        inUseName +
        "' with " +
        profile.tabs.length +
        plural(profile.tabs.length, " tab", " tabs") +
        " from this window.",
      "ok"
    );
  }

  // Overwrite a NAMED profile file with the current window's full state
  // (Replace master semantics), keeping that profile's existing display name.
  // No DOM, no confirmation — shared by the Replace-master button and Feature
  // B's sync-on-switch. Returns the written profile.
  async function replaceMasterFile(fileName) {
    const local = await getCurrentTabs();
    const meta = state.profiles.find((p) => p.fileName === fileName);
    const displayName = meta
      ? meta.displayName
      : fileName.replace(/\.json$/, "");
    const profile = {
      displayName,
      lastModified: new Date().toISOString(),
      tabs: local.tabs,
      groups: local.groups,
    };
    await state.provider.writeProfile(fileName, profile);
    return profile;
  }

  /* ----------------------------------------------------------------- *
   * Bookmarks-bar operations (mirror the four tab operations)
   *
   * The bookmarks bar is global, so these are NOT scoped to the active
   * profile: they read/write the single shared BOOKMARKS_FILE. Every op
   * re-fetches that file fresh (a missing file is an empty master), and both
   * Replace ops confirm via the same modal before doing anything destructive.
   * ----------------------------------------------------------------- */

  async function doBookmarksPush() {
    showFeedback("Pushing bookmarks to master…");
    const local = await readBookmarksBar();
    const master = await readBookmarksMaster(state.provider);
    const { bar, added, skipped } = mergeBookmarks(master.bar || [], local.bar);
    await writeBookmarksMaster(state.provider, {
      lastModified: new Date().toISOString(),
      bar,
    });
    showFeedback(
      "Added " +
        added +
        plural(added, " bookmark", " bookmarks") +
        " to master, " +
        skipped +
        plural(skipped, " duplicate", " duplicates") +
        " skipped.",
      "ok"
    );
  }

  async function doBookmarksPull() {
    showFeedback("Pulling bookmarks from master…");
    const master = await readBookmarksMaster(state.provider);
    const { added, skipped } = await applyBookmarksToLocal(master.bar || [], {
      replace: false,
    });
    showFeedback(
      "Added " +
        added +
        plural(added, " bookmark", " bookmarks") +
        ", " +
        skipped +
        plural(skipped, " duplicate", " duplicates") +
        " skipped.",
      "ok"
    );
  }

  async function doBookmarksReplaceLocal() {
    const master = await readBookmarksMaster(state.provider);
    const count = countBookmarkLinks(master.bar || []);
    const confirmed = await modalConfirm({
      message:
        "Replace local bookmarks with master?\n\nThis DELETES every bookmark on this bar and recreates the " +
        count +
        " master bookmark(s) exactly.",
      confirmLabel: "Replace local",
      danger: true,
    });
    if (!confirmed) return;

    showFeedback("Replacing local bookmarks…");
    const { added } = await applyBookmarksToLocal(master.bar || [], {
      replace: true,
    });
    showFeedback(
      "Local bookmarks replaced with " +
        added +
        plural(added, " bookmark", " bookmarks") +
        " from master.",
      "ok"
    );
  }

  async function doBookmarksReplaceMaster() {
    const local = await readBookmarksBar();
    const count = countBookmarkLinks(local.bar);
    const confirmed = await modalConfirm({
      message:
        "Replace master bookmarks with local?\n\nThis OVERWRITES the stored bookmark set with this bar's " +
        count +
        " bookmark(s). The previous stored bookmark set is discarded.",
      confirmLabel: "Replace master",
      danger: true,
    });
    if (!confirmed) return;

    showFeedback("Replacing master bookmarks…");
    await writeBookmarksMaster(state.provider, {
      lastModified: new Date().toISOString(),
      bar: local.bar,
    });
    showFeedback(
      "Master bookmark set replaced with " +
        count +
        plural(count, " bookmark", " bookmarks") +
        " from this bar.",
      "ok"
    );
  }

  /* ----------------------------------------------------------------- *
   * Grouping helper (shared by Pull and Replace local)
   * ----------------------------------------------------------------- */

  // Given created tabs [{tabId, group, pinned}] and group metadata
  // {title:{color,collapsed}}, group tabs by title then style each group.
  //
  // reuseExisting (default false) controls whether a same-titled group
  // already in the window is reused instead of creating a new one. Chrome
  // happily creates multiple groups with identical titles in one window, so
  // always creating fresh groups (as Pull used to) piles up duplicate
  // "Test", "Test", "Test" groups every time the same title reappears.
  async function applyGroups(created, groupsMeta, reuseExisting) {
    const byTitle = {};
    for (const item of created) {
      // Pinned tabs cannot belong to a tab group — skip them here.
      if (!item.group || item.pinned) continue;
      (byTitle[item.group] = byTitle[item.group] || []).push(item.tabId);
    }

    for (const title of Object.keys(byTitle)) {
      let groupId = null;
      if (reuseExisting) {
        // Look for a group with this exact title already in the window.
        // Titles aren't unique — Chrome lets a window hold several groups
        // named e.g. "Test" — so this can match more than one; we deliberately
        // pick the first and fold the new tabs into it rather than trying to
        // pick "the right one" (there's no signal to disambiguate on).
        const existing = await chromeCall((cb) =>
          chrome.tabGroups.query(
            { title, windowId: chrome.windows.WINDOW_ID_CURRENT },
            cb
          )
        );
        if (existing && existing.length > 0) {
          groupId = existing[0].id;
          await chromeCall((cb) =>
            chrome.tabs.group({ tabIds: byTitle[title], groupId }, cb)
          );
        }
      }
      if (groupId == null) {
        groupId = await chromeCall((cb) =>
          chrome.tabs.group({ tabIds: byTitle[title] }, cb)
        );
      }
      // Master is the source of truth for color/collapsed on every pull, so
      // this runs whether the group was just created or reused.
      const meta = groupsMeta[title] || {};
      const updateProps = { title };
      if (meta.color) updateProps.color = meta.color;
      if (typeof meta.collapsed === "boolean")
        updateProps.collapsed = meta.collapsed;
      await chromeCall((cb) =>
        chrome.tabGroups.update(groupId, updateProps, cb)
      );
    }
  }

  /* ----------------------------------------------------------------- *
   * Recovery: container (gist/repo) deleted (404)
   * ----------------------------------------------------------------- */

  async function offerRecreateContainer() {
    const isForgejo = state.backend === "forgejo";
    const noun = isForgejo ? "repo" : "gist";
    const confirmed = await modalConfirm({
      message: isForgejo
        ? "The tabula-data repo wasn't found (it may have been deleted). Recreate it?"
        : "The Tabula gist wasn't found (it may have been deleted). Recreate a fresh private gist?",
      confirmLabel: "Recreate",
    });
    if (!confirmed) {
      showFeedback(
        (isForgejo ? "Repo" : "Gist") + " not found. Reconnect in Settings.",
        "error"
      );
      return;
    }
    // ensureContainer finds-or-creates and updates the provider's own id/owner;
    // persist the (possibly new) reference back to sync storage.
    await state.provider.ensureContainer();
    if (isForgejo) {
      await storageSet("sync", { forgejoOwner: state.provider.owner });
    } else {
      await storageSet("sync", { gistId: state.provider.gistId });
    }
    showFeedback("Recreated " + noun + ".", "ok");
    await loadProfiles();
  }

  /* ----------------------------------------------------------------- *
   * Modal system (native confirm/prompt close the popup on focus loss, so we
   * roll our own in-popup dialogs).
   * ----------------------------------------------------------------- */

  // Low-level modal. Renders buttons, wires them to resolve(value). If an input
  // is requested, its value is passed to validate() live and to resolve on
  // confirm. Returns a promise resolving to the chosen button's `value`
  // (with input text substituted for the confirm button when `input` is set).
  function openModal(config) {
    return new Promise((resolve) => {
      el.modalMessage.textContent = config.message;

      // Input setup.
      const hasInput = !!config.input;
      el.modalInput.classList.toggle("hidden", !hasInput);
      el.modalError.classList.add("hidden");
      el.modalError.textContent = "";
      if (hasInput) {
        el.modalInput.type = config.input.type || "text";
        el.modalInput.placeholder = config.input.placeholder || "";
        el.modalInput.value = config.input.value || "";
      }

      // Build buttons.
      el.modalButtons.innerHTML = "";
      const buttonEls = [];
      let primaryBtn = null;

      config.buttons.forEach((btn) => {
        const b = document.createElement("button");
        b.textContent = btn.label;
        b.className = "modal-btn";
        if (btn.primary) b.classList.add("primary");
        if (btn.danger) b.classList.add("danger");
        b.addEventListener("click", () => {
          if (btn.isConfirm && config.input) {
            const value = el.modalInput.value;
            const err = config.input.validate
              ? config.input.validate(value)
              : null;
            if (err) {
              el.modalError.textContent = err;
              el.modalError.classList.remove("hidden");
              return;
            }
            close(value);
          } else {
            close(btn.value);
          }
        });
        if (btn.primary || btn.danger) primaryBtn = { def: btn, node: b };
        el.modalButtons.appendChild(b);
        buttonEls.push({ def: btn, node: b });
      });

      // Live validation to enable/disable the confirm button and echo errors.
      function runValidation() {
        if (!hasInput || !config.input.validate || !primaryBtn) return;
        const err = config.input.validate(el.modalInput.value);
        primaryBtn.node.disabled = !!err;
      }

      if (hasInput) {
        el.modalInput.oninput = () => {
          el.modalError.classList.add("hidden");
          runValidation();
        };
        el.modalInput.onkeydown = (e) => {
          if (e.key === "Enter" && primaryBtn && !primaryBtn.node.disabled) {
            primaryBtn.node.click();
          }
        };
      } else {
        el.modalInput.oninput = null;
        el.modalInput.onkeydown = null;
      }

      function onKey(e) {
        if (e.key === "Escape") {
          const cancel = config.buttons.find((x) => x.isCancel);
          close(cancel ? cancel.value : null);
        }
      }
      document.addEventListener("keydown", onKey);

      function close(value) {
        document.removeEventListener("keydown", onKey);
        el.modalOverlay.classList.add("hidden");
        resolve(value);
      }

      el.modalOverlay.classList.remove("hidden");
      runValidation();
      if (hasInput) {
        el.modalInput.focus();
        el.modalInput.select();
      } else if (primaryBtn) {
        primaryBtn.node.focus();
      }
    });
  }

  // Yes/No confirmation. Resolves true/false.
  async function modalConfirm({ message, confirmLabel, danger }) {
    const value = await openModal({
      message,
      buttons: [
        { label: "Cancel", value: false, isCancel: true },
        {
          label: confirmLabel || "Confirm",
          value: true,
          primary: !danger,
          danger: !!danger,
        },
      ],
    });
    return value === true;
  }

  // Multiple-choice dialog. Resolves the chosen button's value (or null).
  async function modalChoice({ message, buttons }) {
    const mapped = buttons.map((b) => ({
      label: b.label,
      value: b.value,
      primary: b.primary,
      danger: b.danger,
      isCancel: b.value == null,
    }));
    const value = await openModal({ message, buttons: mapped });
    return value === undefined ? null : value;
  }

  // Text prompt. Resolves the entered string, or null on cancel.
  async function modalPrompt({ message, placeholder, value, confirmLabel, validate }) {
    const result = await openModal({
      message,
      input: { type: "text", placeholder, value, validate },
      buttons: [
        { label: "Cancel", value: null, isCancel: true },
        {
          label: confirmLabel || "OK",
          isConfirm: true,
          primary: true,
        },
      ],
    });
    return result == null ? null : result;
  }

  // Typed-name confirmation: the primary button only fires when the typed text
  // exactly matches `expected`.
  async function modalTypedConfirm({ message, expected, confirmLabel }) {
    const result = await openModal({
      message,
      input: {
        type: "text",
        placeholder: expected,
        validate: (v) =>
          (v || "").trim() === expected ? null : "Name doesn't match.",
      },
      buttons: [
        { label: "Cancel", value: null, isCancel: true },
        {
          label: confirmLabel || "Delete",
          isConfirm: true,
          danger: true,
        },
      ],
    });
    return result != null;
  }

  /* ----------------------------------------------------------------- *
   * Small helpers
   * ----------------------------------------------------------------- */

  function requireSelected() {
    if (!state.previewFile) {
      throw new TabulaError("Select or create a profile first.", "generic");
    }
  }

  function byId(id) {
    return document.getElementById(id);
  }

  // Per-profile display cache in chrome.storage.local (never trusted for ops).
  // Keys are scoped by backend so switching backends (a Forgejo "Work" vs. a
  // GitHub "Work") never shows the other backend's stale tab count.
  function cacheKey(fileName) {
    return state.backend + ":" + fileName;
  }

  async function getMasterCache(fileName) {
    const key = cacheKey(fileName);
    const { masterCache } = await storageGet("local", ["masterCache"]);
    return masterCache && masterCache[key] ? masterCache[key] : null;
  }

  async function setMasterCache(fileName, snapshot) {
    const key = cacheKey(fileName);
    const { masterCache } = await storageGet("local", ["masterCache"]);
    const next = masterCache || {};
    next[key] = snapshot;
    await storageSet("local", { masterCache: next });
  }

  function plural(n, singular, pluralForm) {
    return n === 1 ? singular : pluralForm;
  }

  function showFeedback(text, kind) {
    el.feedback.textContent = text || "";
    el.feedback.className = "feedback" + (kind ? " " + kind : "");
  }

  function showFatal(text) {
    el.main.classList.add("hidden");
    el.noToken.classList.remove("hidden");
    el.noToken.querySelector(".no-token-msg").textContent = text;
  }

  // Turn any thrown value into a user-facing message.
  function describeError(e) {
    if (e && e.message) return e.message;
    return "Something went wrong.";
  }
})();
