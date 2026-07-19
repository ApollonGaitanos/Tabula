/*
 * popup.js — the whole Kartela UI. No background worker exists; every action
 * is user-initiated from here. common.js (loaded first) provides storage and
 * Gist helpers plus getCurrentTabs(), plus t()/localizePage() for i18n.
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

  // How recent a worker `lastOpResult` must be for the next popup open to
  // surface it. Covers the popup-died-mid-op case (the op finished in the
  // worker but the popup that launched it never saw the outcome); anything
  // older is stale and silently marked seen.
  const LAST_OP_RESULT_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

  // Message type for handing tab surgery to the service worker (see
  // background.js). Kept in sync with OP_TYPE there.
  const OP_TYPE = "kartela-op";

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    localizePage();
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
        el.noToken.querySelector(".no-token-msg").textContent = t(
          "popupForgejoNoAccess",
          config.forgejoUrl
        );
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

    // Last: if a previous op finished in the worker but its popup died before
    // seeing the result, surface that outcome once now. Runs after loadProfiles
    // so it isn't overwritten by the status-row refresh.
    await showLastOpResultIfAny();
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

    // "Use this profile" is ALWAYS available while a profile is selected and
    // we're idle. When the previewed profile is already in use it acts as
    // "reset this window to the profile's master" (see doUseProfile) rather
    // than switching, so it is no longer disabled in that case.
    el.useProfileBtn.disabled = state.busy || !hasSelection;

    // "Update" acts on the IN-USE profile regardless of what's previewed.
    el.updateBtn.disabled = state.busy || !state.inUseFile;
    const inUse = inUseProfileMeta();
    // Make the target unambiguous when previewing a different profile.
    el.updateBtn.textContent =
      inUse && !previewIsInUse
        ? t("msgUpdateNamed", inUse.displayName)
        : t("popupUpdate");

    // Subtle inline hint whenever the preview differs from what's in use.
    if (hasSelection && state.inUseFile && !previewIsInUse) {
      el.previewHint.textContent = t(
        "msgPreviewHint",
        inUse ? inUse.displayName : state.inUseFile
      );
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
    showFeedback(t("msgLoadingProfiles"));
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
      showFeedback(t("msgNoProfilesYet"));
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
    newOpt.textContent = t("popupNewProfileOption");
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
    showFeedback(t("msgSyncingBeforeSwitch", label));
    try {
      if (mode === "replace") {
        await replaceMasterFile(outgoingFile);
      } else {
        await pushLocalToProfile(outgoingFile);
      }
      return { text: t("msgSyncedBeforeSwitch", label), kind: "ok" };
    } catch (e) {
      return {
        text: t("msgCouldntSync", [label, describeError(e)]),
        kind: "error",
      };
    }
  }

  async function promptFirstProfile() {
    const name = await modalPrompt({
      message: t("promptFirstProfile"),
      placeholder: t("promptFirstProfilePlaceholder"),
      confirmLabel: t("btnCreate"),
      validate: validateProfileName,
    });
    if (name == null) return; // user cancelled — leave empty state
    await createProfile(name, "current");
  }

  async function onNewProfile() {
    const name = await modalPrompt({
      message: t("promptNewProfile"),
      placeholder: t("promptNewProfilePlaceholder"),
      confirmLabel: t("btnNext"),
      validate: validateProfileName,
    });
    if (name == null) return;

    // Ask whether to seed the new profile empty or from the current tabs.
    const choice = await modalChoice({
      message: t("promptSeedChoice", name),
      buttons: [
        { label: t("btnCancel"), value: null },
        { label: t("btnEmpty"), value: "empty" },
        { label: t("btnFromCurrent"), value: "current", primary: true },
      ],
    });
    if (choice == null) return;
    await createProfile(name, choice);
  }

  // Validate a display name and guard against filename collisions.
  function validateProfileName(name) {
    const trimmed = (name || "").trim();
    if (!trimmed) return t("valEnterName");
    const fileName = profileFileName(trimmed);
    if (state.profiles.some((p) => p.fileName === fileName)) {
      return t("valNameExists");
    }
    return null;
  }

  async function createProfile(displayName, seed) {
    showFeedback(t("msgCreatingProfile"));
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
    showFeedback(t("msgProfileCreated", displayName.trim()), "ok");
  }

  async function onRename() {
    const target = previewProfileMeta();
    if (!target) return;
    const name = await modalPrompt({
      message: t("promptRename"),
      value: target.displayName,
      confirmLabel: t("btnRename"),
      validate: (n) => {
        const trimmed = (n || "").trim();
        if (!trimmed) return t("valEnterName");
        const fileName = profileFileName(trimmed);
        // Allow keeping the same file; only collide with OTHER profiles.
        if (
          fileName !== target.fileName &&
          state.profiles.some((p) => p.fileName === fileName)
        ) {
          return t("valNameExists");
        }
        return null;
      },
    });
    if (name == null) return;

    showFeedback(t("msgRenaming"));
    const newFileName = profileFileName(name.trim());

    // Serialize the read-modify-write (read current content → rename) against
    // auto-sync, which could otherwise push tabs into the old file between our
    // read and the rename's delete-old step, losing them. The modal above is
    // OUTSIDE the lock.
    await withSyncLock(async () => {
      // Re-fetch fresh so we rename the current content, not a stale cache.
      const profile = await state.provider.readProfile(target.fileName);
      profile.displayName = name.trim();
      profile.lastModified = new Date().toISOString();
      // Provider handles the rename (single gist PATCH, or write-then-delete on
      // Forgejo).
      await state.provider.renameProfile(target.fileName, newFileName, profile);
    });

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
    showFeedback(t("msgRenamed", name.trim()), "ok");
  }

  async function onDelete() {
    const target = previewProfileMeta();
    if (!target) return;
    if (state.profiles.length <= 1) {
      showFeedback(t("msgCantDeleteOnly"), "error");
      return;
    }

    // Typed-name confirmation: the user must type the exact display name.
    const confirmed = await modalTypedConfirm({
      message: t("confirmDeleteProfile", target.displayName),
      expected: target.displayName,
      confirmLabel: t("btnDelete"),
    });
    if (!confirmed) return;

    showFeedback(t("msgDeleting"));
    // Serialize the delete against auto-sync so a tick can't recreate/write the
    // file around the delete. The typed-name modal above is OUTSIDE the lock.
    await withSyncLock(() => state.provider.deleteProfile(target.fileName));

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
    showFeedback(t("msgDeleted", target.displayName), "ok");
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
    showFeedback(t("msgRefreshing"));

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
    // Serialize the backend read-modify-write against background auto-sync and
    // any other popup write. The local tab read above stays outside the lock to
    // keep its scope tight; nothing here awaits user input, so the lock is only
    // ever held across the backend read→write.
    return withSyncLock(async () => {
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
    });
  }

  async function doPush() {
    requireSelected();
    showFeedback(t("msgPushingMaster"));
    const { master, added, skipped } = await pushLocalToProfile(
      state.previewFile
    );
    state.master = master;
    el.masterCount.textContent = String(master.tabs.length);
    el.masterModified.textContent = formatTimestamp(master.lastModified);

    showFeedback(t("msgAddedTabs", [String(added), String(skipped)]), "ok");
  }

  /* ----------------------------------------------------------------- *
   * Operation 2: Pull (merge master tabs into local)
   * ----------------------------------------------------------------- */

  async function doPull() {
    requireSelected();
    showFeedback(t("msgPullingMaster"));
    // The multi-second tab surgery runs in the service worker so it survives the
    // popup closing mid-open; we hand it the explicit window id and await the
    // outcome. If the popup dies first, the worker still finishes and the next
    // open surfaces the result from lastOpResult.
    const windowId = await getCurrentWindowId();
    const res = await runWorkerOp({
      type: OP_TYPE,
      op: "pull",
      windowId,
      fileName: state.previewFile,
    });
    if (res.ok && !res.nothingToPull) await refreshStatus();
    showFeedback(res.message, res.kind);
    await markLastOpSeen(); // we survived to show it — don't re-show next open
  }

  /* ----------------------------------------------------------------- *
   * Operation 3: Replace local (make the window exactly match master)
   * ----------------------------------------------------------------- */

  async function doReplaceLocal() {
    requireSelected();
    const windowId = await getCurrentWindowId();
    // Fresh master fetch drives the confirmation count; the worker re-fetches
    // its own fresh copy before mutating.
    const master = await state.provider.readProfile(state.previewFile);

    const confirmed = await modalConfirm({
      message: t("confirmReplaceLocalBody", String((master.tabs || []).length)),
      confirmLabel: t("popupReplaceLocalShort"),
      danger: true,
    });
    if (!confirmed) return;

    showFeedback(t("msgReplacingLocal"));
    // Tab surgery runs in the worker (see doPull / background.js) so it survives
    // the popup closing mid-replace.
    const res = await runWorkerOp({
      type: OP_TYPE,
      op: "replaceLocal",
      windowId,
      fileName: state.previewFile,
    });
    if (!res.aborted && res.ok) await refreshStatus();
    showFeedback(res.message, res.kind);
    await markLastOpSeen();
  }

  /* ----------------------------------------------------------------- *
   * Operation 4: Replace master (overwrite master with current window)
   * ----------------------------------------------------------------- */

  async function doReplaceMaster() {
    requireSelected();
    const local = await getCurrentTabs();
    const target = previewProfileMeta();

    const confirmed = await modalConfirm({
      message: t("confirmReplaceMasterBody", [
        target.displayName,
        String(local.tabs.length),
      ]),
      confirmLabel: t("popupReplaceMasterShort"),
      danger: true,
    });
    if (!confirmed) return;

    showFeedback(t("msgReplacingMaster"));
    const profile = await replaceMasterFile(state.previewFile);
    state.master = profile;
    el.masterCount.textContent = String(profile.tabs.length);
    el.masterModified.textContent = formatTimestamp(profile.lastModified);
    showFeedback(t("msgMasterReplaced", String(profile.tabs.length)), "ok");
  }

  /* ----------------------------------------------------------------- *
   * Primary action: Use this profile
   *
   * Makes the PREVIEWED profile the one in use and replaces this window's tabs
   * with that profile's master (executed in the worker). Before touching any
   * tab, optionally syncs the OUTGOING in-use profile so profiles can be
   * round-tripped without losing tabs. When the previewed profile is ALREADY in
   * use this button instead RESETS the window to that profile's master: same
   * surgery, distinct wording, outgoing switch-sync skipped, in-use pointer
   * unchanged.
   * ----------------------------------------------------------------- */

  async function doUseProfile() {
    requireSelected();

    const windowId = await getCurrentWindowId();
    const target = previewProfileMeta();
    const targetName = target ? target.displayName : state.previewFile;

    // "Use this profile" is now always enabled. When the previewed profile is
    // ALREADY in use, the button means "reset this window to that profile's
    // master": identical tab surgery, distinct wording, and — crucially — the
    // outgoing switch-sync is SKIPPED (see below). The in-use pointer doesn't
    // change in that case.
    const isReset = state.previewFile === state.inUseFile;

    // Fresh master fetch (like Replace local): drives the confirmation count.
    const master = await state.provider.readProfile(state.previewFile);

    const confirmed = await modalConfirm({
      message: isReset
        ? t("confirmResetWindowBody", [
            targetName,
            String((master.tabs || []).length),
          ])
        : t("confirmUseProfileBody", [
            targetName,
            String((master.tabs || []).length),
          ]),
      confirmLabel: isReset ? t("popupResetShort") : t("popupUseProfile"),
      danger: true,
    });
    if (!confirmed) return;

    // BEFORE replacing tabs: optionally sync the OUTGOING (in-use) profile, so
    // the window we're about to close is first saved into the profile we're
    // leaving. A failure warns but does NOT block the switch.
    //
    // SKIP this entirely on a reset: the outgoing profile IS the target, so
    // syncing it would push the current window into master and then immediately
    // replace it back from that same master — round-tripping the very tabs we
    // meant to discard and defeating the reset.
    let switchNote = null;
    if (!isReset && state.inUseFile && state.inUseFile !== state.previewFile) {
      switchNote = await maybeSyncOnSwitch(state.inUseFile);
    }

    const inUse = inUseProfileMeta();
    const inUseName = inUse ? inUse.displayName : state.inUseFile;

    showFeedback(isReset ? t("msgResettingWindow") : t("msgSwitchingProfile"));
    // Tab surgery (and the in-use pointer commit on success) run in the worker
    // so they survive the popup closing mid-switch.
    const res = await runWorkerOp({
      type: OP_TYPE,
      op: "useProfile",
      windowId,
      fileName: state.previewFile,
      targetName,
      inUseName,
      isReset,
    });

    const hadSyncError = switchNote && switchNote.kind === "error";

    if (res.aborted) {
      // Nothing could be opened: the worker did NOT move the in-use pointer —
      // the window is untouched and we're still using the previous profile.
      let msg = res.message;
      if (hadSyncError) msg = switchNote.text + " " + msg;
      showFeedback(msg, "error");
      await markLastOpSeen();
      return;
    }

    // The worker committed the in-use pointer (activeProfile). Mirror it into
    // local state now that we survived to update the UI. On a reset this is a
    // no-op (previewFile already equals inUseFile).
    state.inUseFile = state.previewFile;
    await refreshStatus();
    updateActionAvailability();

    let msg = res.message;
    if (hadSyncError) msg = switchNote.text + " " + msg;
    showFeedback(msg, res.failed || hadSyncError ? "error" : res.kind);
    await markLastOpSeen();
  }

  /* ----------------------------------------------------------------- *
   * Primary action: Update
   *
   * Overwrites the IN-USE profile's master with the current window (Replace
   * master), regardless of what's previewed.
   * ----------------------------------------------------------------- */

  async function doUpdate() {
    if (!state.inUseFile) {
      throw new TabulaError(t("msgNoProfileInUse"), "generic");
    }
    const inUse = inUseProfileMeta();
    const inUseName = inUse ? inUse.displayName : state.inUseFile;
    const local = await getCurrentTabs();

    const confirmed = await modalConfirm({
      message: t("confirmReplaceMasterBody", [
        inUseName,
        String(local.tabs.length),
      ]),
      confirmLabel: t("popupUpdate"),
      danger: true,
    });
    if (!confirmed) return;

    showFeedback(t("msgUpdatingMaster"));
    const profile = await replaceMasterFile(state.inUseFile);
    // Only refresh the status display if the in-use profile is also the one
    // being previewed (otherwise the status row shows a different profile).
    if (state.previewFile === state.inUseFile) {
      state.master = profile;
      el.masterCount.textContent = String(profile.tabs.length);
      el.masterModified.textContent = formatTimestamp(profile.lastModified);
    }
    showFeedback(
      t("msgUpdated", [inUseName, String(profile.tabs.length)]),
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
    // Serialize the backend write against auto-sync / other popup writes.
    await withSyncLock(() => state.provider.writeProfile(fileName, profile));
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
    showFeedback(t("msgPushingBookmarks"));
    const local = await readBookmarksBar();
    // Serialize the shared-bookmarks read-modify-write against auto-sync's own
    // bookmark sync (and any other popup write). Local bar read stays outside.
    const { added, skipped } = await withSyncLock(async () => {
      const master = await readBookmarksMaster(state.provider);
      const { bar, added, skipped } = mergeBookmarks(master.bar || [], local.bar);
      await writeBookmarksMaster(state.provider, {
        lastModified: new Date().toISOString(),
        bar,
      });
      return { added, skipped };
    });
    showFeedback(
      t("msgAddedBookmarksMaster", [String(added), String(skipped)]),
      "ok"
    );
  }

  async function doBookmarksPull() {
    showFeedback(t("msgPullingBookmarks"));
    const master = await readBookmarksMaster(state.provider);
    const { added, skipped } = await applyBookmarksToLocal(master.bar || [], {
      replace: false,
    });
    showFeedback(t("msgAddedBookmarks", [String(added), String(skipped)]), "ok");
  }

  async function doBookmarksReplaceLocal() {
    const master = await readBookmarksMaster(state.provider);
    const count = countBookmarkLinks(master.bar || []);
    const confirmed = await modalConfirm({
      message: t("confirmReplaceLocalBookmarks", String(count)),
      confirmLabel: t("popupReplaceLocalShort"),
      danger: true,
    });
    if (!confirmed) return;

    showFeedback(t("msgReplacingLocalBookmarks"));
    const { added } = await applyBookmarksToLocal(master.bar || [], {
      replace: true,
    });
    showFeedback(t("msgLocalBookmarksReplaced", String(added)), "ok");
  }

  async function doBookmarksReplaceMaster() {
    const local = await readBookmarksBar();
    const count = countBookmarkLinks(local.bar);
    const confirmed = await modalConfirm({
      message: t("confirmReplaceMasterBookmarks", String(count)),
      confirmLabel: t("popupReplaceMasterShort"),
      danger: true,
    });
    if (!confirmed) return;

    showFeedback(t("msgReplacingMasterBookmarks"));
    // Serialize the write against auto-sync's bookmark sync. Modal above is
    // outside the lock.
    await withSyncLock(() =>
      writeBookmarksMaster(state.provider, {
        lastModified: new Date().toISOString(),
        bar: local.bar,
      })
    );
    showFeedback(t("msgMasterBookmarksReplaced", String(count)), "ok");
  }

  /* ----------------------------------------------------------------- *
   * Service-worker op handoff
   *
   * The pull / replace-local / use-profile tab surgery is EXECUTED IN THE
   * SERVICE WORKER (background.js), not here, so it survives the popup closing
   * mid-open (which used to abort a create-before-remove halfway and duplicate
   * every tab and group). The popup still owns confirmation, feedback and
   * switch-sync; it just hands off the mutation and awaits the result — or dies,
   * in which case the worker still finishes and the next open shows the outcome.
   * The shared surgery helpers (applyGroups, replaceWindowWithMaster,
   * pullMasterIntoWindow) now live in common.js, parameterized by windowId.
   * ----------------------------------------------------------------- */

  // The worker has no "current window", so we resolve and pass this popup's
  // window id explicitly.
  async function getCurrentWindowId() {
    const win = await chromeCall((cb) => chrome.windows.getCurrent(cb));
    return win.id;
  }

  // Send an op to the worker and resolve its result object. Rejects (so
  // guarded() surfaces it) on a messaging failure or an empty response.
  function runWorkerOp(payload) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(payload, (response) => {
          if (chrome.runtime.lastError) {
            reject(new TabulaError(chrome.runtime.lastError.message, "generic"));
          } else if (!response) {
            reject(new TabulaError(t("errGeneric"), "generic"));
          } else {
            resolve(response);
          }
        });
      } catch (e) {
        reject(new TabulaError(e.message, "generic"));
      }
    });
  }

  // Mark the worker's lastOpResult as seen once THIS popup has rendered it, so
  // it isn't shown again on the next open. Only a popup that DIED mid-op leaves
  // it unseen for showLastOpResultIfAny to surface.
  async function markLastOpSeen() {
    try {
      const { lastOpResult } = await storageGet("local", ["lastOpResult"]);
      if (lastOpResult && !lastOpResult.seen) {
        await storageSet("local", {
          lastOpResult: Object.assign({}, lastOpResult, { seen: true }),
        });
      }
    } catch (e) {
      /* non-critical */
    }
  }

  // On popup open, surface a recent, unseen worker outcome once (the
  // popup-died-mid-op case), then mark it seen. Stale results are silently
  // consumed so they never appear.
  async function showLastOpResultIfAny() {
    let stored;
    try {
      ({ lastOpResult: stored } = await storageGet("local", ["lastOpResult"]));
    } catch (e) {
      return;
    }
    if (!stored || stored.seen) return;
    const age = Date.now() - new Date(stored.at).getTime();
    if (!(age >= 0) || age > LAST_OP_RESULT_MAX_AGE_MS) {
      // Too old or unparseable: consume it silently so it never shows.
      try {
        await storageSet("local", {
          lastOpResult: Object.assign({}, stored, { seen: true }),
        });
      } catch (e) {
        /* ignore */
      }
      return;
    }
    showFeedback(
      t("msgLastOpResult", stored.message || ""),
      stored.ok ? "ok" : "error"
    );
    try {
      await storageSet("local", {
        lastOpResult: Object.assign({}, stored, { seen: true }),
      });
    } catch (e) {
      /* ignore */
    }
  }

  /* ----------------------------------------------------------------- *
   * Recovery: container (gist/repo) deleted (404)
   * ----------------------------------------------------------------- */

  async function offerRecreateContainer() {
    const isForgejo = state.backend === "forgejo";
    const confirmed = await modalConfirm({
      message: isForgejo
        ? t("popupRecreateRepoConfirm")
        : t("popupRecreateGistConfirm"),
      confirmLabel: t("btnRecreate"),
    });
    if (!confirmed) {
      showFeedback(
        isForgejo ? t("popupRepoNotFound") : t("popupGistNotFound"),
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
    showFeedback(
      isForgejo ? t("popupRecreatedRepo") : t("popupRecreatedGist"),
      "ok"
    );
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
        { label: t("btnCancel"), value: false, isCancel: true },
        {
          label: confirmLabel || t("btnConfirm"),
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
        { label: t("btnCancel"), value: null, isCancel: true },
        {
          label: confirmLabel || t("btnOk"),
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
          (v || "").trim() === expected ? null : t("valNameNoMatch"),
      },
      buttons: [
        { label: t("btnCancel"), value: null, isCancel: true },
        {
          label: confirmLabel || t("btnDelete"),
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
      throw new TabulaError(t("msgSelectFirst"), "generic");
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
    return t("errGeneric");
  }
})();
