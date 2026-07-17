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
    token: null,
    gistId: null,
    profiles: [], // [{ fileName, displayName }]
    activeFile: null, // gist filename of the active profile
    master: null, // last-fetched master profile object (for display)
    busy: false,
  };

  // Cached DOM references.
  const el = {};

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    cacheElements();
    wireEvents();
    try {
      state.token = await getToken();
      state.gistId = await getGistId();
    } catch (e) {
      // Storage failure is fatal for the popup; show it and stop.
      return showFatal(describeError(e));
    }

    if (!state.token || !state.gistId) {
      el.noToken.classList.remove("hidden");
      return;
    }

    el.main.classList.remove("hidden");
    await loadProfiles();
  }

  function cacheElements() {
    el.main = byId("main");
    el.noToken = byId("no-token");
    el.profileSelect = byId("profile-select");
    el.renameBtn = byId("rename-btn");
    el.deleteBtn = byId("delete-btn");
    el.settingsBtn = byId("settings-btn");
    el.refreshBtn = byId("refresh-btn");
    el.localCount = byId("local-count");
    el.masterCount = byId("master-count");
    el.masterModified = byId("master-modified");
    el.pushBtn = byId("push-btn");
    el.pullBtn = byId("pull-btn");
    el.replaceLocalBtn = byId("replace-local-btn");
    el.replaceMasterBtn = byId("replace-master-btn");
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
    el.pushBtn.addEventListener("click", () => guarded(doPush));
    el.pullBtn.addEventListener("click", () => guarded(doPull));
    el.replaceLocalBtn.addEventListener("click", () => guarded(doReplaceLocal));
    el.replaceMasterBtn.addEventListener("click", () =>
      guarded(doReplaceMaster)
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
    const controls = [
      el.refreshBtn,
      el.profileSelect,
      el.renameBtn,
      el.deleteBtn,
      el.pushBtn,
      el.pullBtn,
      el.replaceLocalBtn,
      el.replaceMasterBtn,
    ];
    controls.forEach((c) => (c.disabled = busy));
  }

  /* ----------------------------------------------------------------- *
   * Profiles
   * ----------------------------------------------------------------- */

  async function loadProfiles() {
    showFeedback("Loading profiles…");
    let profiles;
    try {
      profiles = await listProfiles(state.token, state.gistId);
    } catch (e) {
      if (e.code === "not_found") {
        // The gist id we stored points at a gist that no longer exists.
        return offerRecreateGist();
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

    // Restore the previously active profile if it still exists.
    const stored = await getActiveProfile();
    const found = profiles.find((p) => p.fileName === stored);
    state.activeFile = found ? found.fileName : profiles[0].fileName;
    await setActiveProfile(state.activeFile);

    populateSelect();
    await refreshStatus();
  }

  function populateSelect() {
    el.profileSelect.innerHTML = "";
    for (const p of state.profiles) {
      const opt = document.createElement("option");
      opt.value = p.fileName;
      opt.textContent = p.displayName;
      if (p.fileName === state.activeFile) opt.selected = true;
      el.profileSelect.appendChild(opt);
    }
    const newOpt = document.createElement("option");
    newOpt.value = "__new__";
    newOpt.textContent = "New profile…";
    el.profileSelect.appendChild(newOpt);

    const hasActive = !!state.activeFile;
    el.renameBtn.disabled = !hasActive;
    el.deleteBtn.disabled = !hasActive;
  }

  async function onProfileChange() {
    const value = el.profileSelect.value;
    if (value === "__new__") {
      // Reset the select back to the active profile; the picker isn't the
      // commit — the modal is.
      el.profileSelect.value = state.activeFile || "";
      await guarded(onNewProfile);
      return;
    }
    state.activeFile = value;
    await setActiveProfile(value);
    await guarded(refreshStatus);
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
    await writeProfile(state.token, state.gistId, fileName, profile);

    state.profiles.push({ fileName, displayName: displayName.trim() });
    state.profiles.sort((a, b) => a.displayName.localeCompare(b.displayName));
    state.activeFile = fileName;
    await setActiveProfile(fileName);
    populateSelect();
    await refreshStatus();
    showFeedback('Created profile "' + displayName.trim() + '".', "ok");
  }

  async function onRename() {
    const active = activeProfileMeta();
    if (!active) return;
    const name = await modalPrompt({
      message: "Rename profile:",
      value: active.displayName,
      confirmLabel: "Rename",
      validate: (n) => {
        const trimmed = (n || "").trim();
        if (!trimmed) return "Enter a name.";
        const fileName = profileFileName(trimmed);
        // Allow keeping the same file; only collide with OTHER profiles.
        if (
          fileName !== active.fileName &&
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
    const profile = await readProfile(state.token, state.gistId, active.fileName);
    profile.displayName = name.trim();
    profile.lastModified = new Date().toISOString();
    const newFileName = profileFileName(name.trim());

    // Create new file + delete old in a single PATCH.
    await renameProfile(
      state.token,
      state.gistId,
      active.fileName,
      newFileName,
      profile
    );

    // Update local state.
    const idx = state.profiles.findIndex((p) => p.fileName === active.fileName);
    if (idx >= 0) {
      state.profiles[idx] = {
        fileName: newFileName,
        displayName: name.trim(),
      };
    }
    state.profiles.sort((a, b) => a.displayName.localeCompare(b.displayName));
    state.activeFile = newFileName;
    await setActiveProfile(newFileName);
    populateSelect();
    await refreshStatus();
    showFeedback('Renamed to "' + name.trim() + '".', "ok");
  }

  async function onDelete() {
    const active = activeProfileMeta();
    if (!active) return;
    if (state.profiles.length <= 1) {
      showFeedback("Can't delete the only profile.", "error");
      return;
    }

    // Typed-name confirmation: the user must type the exact display name.
    const confirmed = await modalTypedConfirm({
      message:
        'Delete profile "' +
        active.displayName +
        '"? This removes it from the Gist and cannot be undone.\n\nType the profile name to confirm:',
      expected: active.displayName,
      confirmLabel: "Delete",
    });
    if (!confirmed) return;

    showFeedback("Deleting…");
    await deleteProfile(state.token, state.gistId, active.fileName);

    state.profiles = state.profiles.filter(
      (p) => p.fileName !== active.fileName
    );
    state.activeFile = state.profiles[0].fileName;
    await setActiveProfile(state.activeFile);
    populateSelect();
    await refreshStatus();
    showFeedback('Deleted "' + active.displayName + '".', "ok");
  }

  function activeProfileMeta() {
    return state.profiles.find((p) => p.fileName === state.activeFile) || null;
  }

  /* ----------------------------------------------------------------- *
   * Status row
   * ----------------------------------------------------------------- */

  async function refreshStatus() {
    if (!state.activeFile) {
      el.localCount.textContent = "—";
      el.masterCount.textContent = "—";
      el.masterModified.textContent = "—";
      return;
    }
    showFeedback("Refreshing…");

    // Show the cached snapshot immediately (display only) for snappiness while
    // the fresh fetch is in flight. The cache is never used for operations.
    const cached = await getMasterCache(state.activeFile);
    if (cached) {
      el.masterCount.textContent = String(cached.tabsCount);
      el.masterModified.textContent = formatTimestamp(cached.lastModified);
    }

    // Local count from the live window.
    const local = await getCurrentTabs();
    el.localCount.textContent = String(local.tabs.length);

    // Master is always fetched fresh; we cache it only for display.
    const master = await readProfile(
      state.token,
      state.gistId,
      state.activeFile
    );
    state.master = master;
    el.masterCount.textContent = String((master.tabs || []).length);
    el.masterModified.textContent = formatTimestamp(master.lastModified);
    await setMasterCache(state.activeFile, {
      tabsCount: (master.tabs || []).length,
      lastModified: master.lastModified,
    });
    showFeedback("");
  }

  /* ----------------------------------------------------------------- *
   * Operation 1: Push (merge current tabs into master)
   * ----------------------------------------------------------------- */

  async function doPush() {
    requireActive();
    showFeedback("Pushing to master…");
    const local = await getCurrentTabs();
    // Always re-fetch master immediately before writing.
    const master = await readProfile(
      state.token,
      state.gistId,
      state.activeFile
    );

    const existing = new Set(
      (master.tabs || []).map((t) => normalizeUrl(t.url))
    );
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
    await writeProfile(state.token, state.gistId, state.activeFile, master);
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
    requireActive();
    showFeedback("Pulling from master…");
    const local = await getCurrentTabs();
    const master = await readProfile(
      state.token,
      state.gistId,
      state.activeFile
    );

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
    for (const tab of toOpen) {
      const newTab = await chromeCall((cb) =>
        chrome.tabs.create({ url: tab.url, active: false, pinned: !!tab.pinned }, cb)
      );
      created.push({ tabId: newTab.id, group: tab.group, pinned: !!tab.pinned });
    }

    await applyGroups(created, master.groups || {});

    await refreshStatus();
    showFeedback(
      "Opened " + toOpen.length + plural(toOpen.length, " tab", " tabs") + ".",
      "ok"
    );
  }

  /* ----------------------------------------------------------------- *
   * Operation 3: Replace local (make the window exactly match master)
   * ----------------------------------------------------------------- */

  async function doReplaceLocal() {
    requireActive();
    const master = await readProfile(
      state.token,
      state.gistId,
      state.activeFile
    );

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

    // newtab-survival trick: a Chrome window closes when its last tab closes.
    // Open a throwaway chrome://newtab FIRST so the window stays alive while we
    // remove the original tabs, then close the throwaway at the very end.
    const survivor = await chromeCall((cb) =>
      chrome.tabs.create({ url: "chrome://newtab", active: false }, cb)
    );

    const currentTabs = await chromeCall((cb) =>
      chrome.tabs.query({ currentWindow: true }, cb)
    );
    const idsToClose = currentTabs
      .filter((t) => t.id !== survivor.id)
      .map((t) => t.id);
    if (idsToClose.length) {
      await chromeCall((cb) => chrome.tabs.remove(idsToClose, cb));
    }

    // Recreate master state exactly, in order. Tabs are created after the
    // survivor tab, so they land in master order; we group afterwards.
    const created = [];
    for (const tab of master.tabs || []) {
      const newTab = await chromeCall((cb) =>
        chrome.tabs.create(
          { url: tab.url, active: false, pinned: !!tab.pinned },
          cb
        )
      );
      created.push({ tabId: newTab.id, group: tab.group, pinned: !!tab.pinned });
    }

    await applyGroups(created, master.groups || {});

    if (created.length > 0) {
      // Real tabs now keep the window alive; drop the throwaway newtab.
      await chromeCall((cb) => chrome.tabs.remove(survivor.id, cb));
    } else {
      // Master was empty: keep the survivor as the window's blank tab instead
      // of closing it (which would close the whole window).
      await chromeCall((cb) =>
        chrome.tabs.update(survivor.id, { active: true }, cb)
      );
    }

    await refreshStatus();
    showFeedback(
      "Local replaced with " +
        (master.tabs || []).length +
        plural((master.tabs || []).length, " tab", " tabs") +
        " from master.",
      "ok"
    );
  }

  /* ----------------------------------------------------------------- *
   * Operation 4: Replace master (overwrite master with current window)
   * ----------------------------------------------------------------- */

  async function doReplaceMaster() {
    requireActive();
    const local = await getCurrentTabs();
    const active = activeProfileMeta();

    const confirmed = await modalConfirm({
      message:
        'Replace master with local?\n\nThis OVERWRITES profile "' +
        active.displayName +
        '" with the current window (' +
        local.tabs.length +
        " tab(s)). The previous master content is discarded.",
      confirmLabel: "Replace master",
      danger: true,
    });
    if (!confirmed) return;

    showFeedback("Replacing master…");
    const profile = {
      displayName: active.displayName,
      lastModified: new Date().toISOString(),
      tabs: local.tabs,
      groups: local.groups,
    };
    await writeProfile(state.token, state.gistId, state.activeFile, profile);
    state.master = profile;
    el.masterCount.textContent = String(profile.tabs.length);
    el.masterModified.textContent = formatTimestamp(profile.lastModified);
    showFeedback(
      "Master replaced with " +
        local.tabs.length +
        plural(local.tabs.length, " tab", " tabs") +
        " from this window.",
      "ok"
    );
  }

  /* ----------------------------------------------------------------- *
   * Grouping helper (shared by Pull and Replace local)
   * ----------------------------------------------------------------- */

  // Given created tabs [{tabId, group, pinned}] and group metadata
  // {title:{color,collapsed}}, group tabs by title then style each group.
  async function applyGroups(created, groupsMeta) {
    const byTitle = {};
    for (const item of created) {
      // Pinned tabs cannot belong to a tab group — skip them here.
      if (!item.group || item.pinned) continue;
      (byTitle[item.group] = byTitle[item.group] || []).push(item.tabId);
    }

    for (const title of Object.keys(byTitle)) {
      const groupId = await chromeCall((cb) =>
        chrome.tabs.group({ tabIds: byTitle[title] }, cb)
      );
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
   * Recovery: gist deleted (404)
   * ----------------------------------------------------------------- */

  async function offerRecreateGist() {
    const confirmed = await modalConfirm({
      message:
        "The Tabula gist wasn't found (it may have been deleted). Recreate a fresh private gist?",
      confirmLabel: "Recreate",
    });
    if (!confirmed) {
      showFeedback("Gist not found. Reconnect in Settings.", "error");
      return;
    }
    const newId = await createTabulaGist(state.token);
    await storageSet("sync", { gistId: newId });
    state.gistId = newId;
    showFeedback("Recreated gist.", "ok");
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

  function requireActive() {
    if (!state.activeFile) {
      throw new TabulaError("Select or create a profile first.", "generic");
    }
  }

  function byId(id) {
    return document.getElementById(id);
  }

  // Per-profile display cache in chrome.storage.local (never trusted for ops).
  async function getMasterCache(fileName) {
    const { masterCache } = await storageGet("local", ["masterCache"]);
    return masterCache && masterCache[fileName] ? masterCache[fileName] : null;
  }

  async function setMasterCache(fileName, snapshot) {
    const { masterCache } = await storageGet("local", ["masterCache"]);
    const next = masterCache || {};
    next[fileName] = snapshot;
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
