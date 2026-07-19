/*
 * settings.js — backend connection flow. Uses common.js helpers.
 * Runs in a normal extension page (not a popup), so state is stable here.
 *
 * Two backends: GitHub Gist (default, unchanged) and Forgejo/Gitea. A radio
 * selector swaps between panels; Validate & Save and Disconnect act on the
 * selected backend.
 */

(function () {
  "use strict";

  const el = {};

  // Guards Migrate against re-entrancy. The button disables itself only after an
  // awaited storage read, leaving a small window where a double-click could
  // start a second migration; this flag closes it.
  let migrating = false;

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    localizePage();
    el.backendRadios = Array.prototype.slice.call(
      document.querySelectorAll('input[name="backend"]')
    );
    el.githubPanel = byId("github-panel");
    el.forgejoPanel = byId("forgejo-panel");

    el.token = byId("token");
    el.toggle = byId("toggle-visibility");
    el.forgejoUrl = byId("forgejo-url");
    el.forgejoToken = byId("forgejo-token");
    el.forgejoToggle = byId("forgejo-toggle-visibility");

    el.save = byId("save-btn");
    el.disconnect = byId("disconnect-btn");
    el.status = byId("status");

    el.connectedInfo = byId("connected-info");
    el.connectedGithub = byId("connected-github");
    el.connectedGist = byId("connected-gist");
    el.connectedForgejo = byId("connected-forgejo");
    el.ghUser = byId("gh-user");
    el.gistId = byId("gist-id");
    el.forgejoRepo = byId("forgejo-repo");
    el.privacy = byId("privacy-note");

    el.toggle.addEventListener("click", () =>
      toggleVisibility(el.token, el.toggle)
    );
    el.forgejoToggle.addEventListener("click", () =>
      toggleVisibility(el.forgejoToken, el.forgejoToggle)
    );
    el.save.addEventListener("click", onSave);
    el.disconnect.addEventListener("click", onDisconnect);
    el.backendRadios.forEach((r) =>
      r.addEventListener("change", onBackendChange)
    );

    await reflectStoredState();
    await initAutoSync();
    await initMigrate();
  }

  /* ----------------------------------------------------------------- *
   * Automatic sync card (Feature A timer + Feature B switch)
   *
   * Settings save immediately on every change (no button); the background
   * worker reacts to the sync-storage write via chrome.storage.onChanged.
   * ----------------------------------------------------------------- */

  async function initAutoSync() {
    el.autoEnabled = byId("auto-sync-enabled");
    el.autoMinutes = byId("auto-sync-minutes");
    el.autoMode = byId("auto-sync-mode");
    el.autoBookmarks = byId("auto-sync-bookmarks");
    el.switchEnabled = byId("switch-sync-enabled");
    el.switchMode = byId("switch-sync-mode");
    el.autoStatus = byId("auto-sync-status");

    // Populate controls from stored values (defaults applied where absent).
    try {
      const s = await storageGet("sync", [
        "autoSyncEnabled",
        "autoSyncMinutes",
        "autoSyncMode",
        "autoSyncBookmarks",
        "switchSyncEnabled",
        "switchSyncMode",
      ]);
      el.autoEnabled.checked = !!s.autoSyncEnabled;
      // Same clamp as the background worker and the save path (Number → round →
      // [1,1440], NaN → default) so the displayed value can never disagree with
      // what actually gets scheduled.
      el.autoMinutes.value = String(clampAutoSyncMinutes(s.autoSyncMinutes));
      el.autoMode.value = s.autoSyncMode === "replace" ? "replace" : "push";
      el.autoBookmarks.checked = !!s.autoSyncBookmarks;
      el.switchEnabled.checked = !!s.switchSyncEnabled;
      el.switchMode.value =
        s.switchSyncMode === "replace" ? "replace" : "push";
    } catch (e) {
      setStatus(describeError(e), "error");
    }

    // Save immediately on any change.
    [
      el.autoEnabled,
      el.autoMinutes,
      el.autoMode,
      el.autoBookmarks,
      el.switchEnabled,
      el.switchMode,
    ].forEach((c) => c.addEventListener("change", saveAutoSync));

    // Static display of the last background sync (no polling).
    await showLastAutoSync();
  }

  async function saveAutoSync() {
    // Clamp minutes with the shared helper (Number → round → [1,1440], NaN →
    // default) and reflect the clamp back into the field.
    const minutes = clampAutoSyncMinutes(el.autoMinutes.value);
    el.autoMinutes.value = String(minutes);

    try {
      await storageSet("sync", {
        autoSyncEnabled: el.autoEnabled.checked,
        autoSyncMinutes: minutes,
        autoSyncMode: el.autoMode.value === "replace" ? "replace" : "push",
        autoSyncBookmarks: el.autoBookmarks.checked,
        switchSyncEnabled: el.switchEnabled.checked,
        switchSyncMode: el.switchMode.value === "replace" ? "replace" : "push",
      });
      setStatus(t("settingsAutoSaved"), "ok");
    } catch (e) {
      setStatus(describeError(e), "error");
    }
  }

  // One-shot render of chrome.storage.local `lastAutoSync` on page load.
  async function showLastAutoSync() {
    try {
      const { lastAutoSync } = await storageGet("local", ["lastAutoSync"]);
      if (!lastAutoSync) return;
      el.autoStatus.classList.remove("hidden");
      el.autoStatus.textContent = t("settingsLastAutoSync", [
        formatTimestamp(lastAutoSync.at),
        lastAutoSync.message ||
          (lastAutoSync.ok ? t("settingsOk") : t("settingsFailed")),
      ]);
      el.autoStatus.classList.toggle("ok", !!lastAutoSync.ok);
      el.autoStatus.classList.toggle("error", !lastAutoSync.ok);
    } catch (e) {
      /* status line stays hidden */
    }
  }

  /* ----------------------------------------------------------------- *
   * Migrate data card
   *
   * Copies every profile from one backend to the other. Both credential sets
   * can live in sync storage at once (the `backend` key only picks the ACTIVE
   * one), so migration builds a provider for each side from explicit configs
   * read straight from storage — never from the active `backend` key. The
   * source is only ever read; nothing on it is written or deleted, and local
   * tabs are never touched.
   * ----------------------------------------------------------------- */

  async function initMigrate() {
    el.migrateDirection = byId("migrate-direction");
    el.migrateSourceStatus = byId("migrate-source-status");
    el.migrateTargetStatus = byId("migrate-target-status");
    el.migrateConnectHint = byId("migrate-connect-hint");
    el.migrateSwitchActive = byId("migrate-switch-active");
    el.migrateBtn = byId("migrate-btn");
    el.migrateStatus = byId("migrate-status");

    // Default the direction to point AWAY FROM the currently-active backend.
    try {
      const config = await getBackendConfig();
      el.migrateDirection.value =
        config.backend === "forgejo" ? "forgejo-github" : "github-forgejo";
    } catch (e) {
      /* leave the HTML default (github-forgejo) */
    }

    el.migrateDirection.addEventListener("change", () => refreshMigrateState());
    el.migrateBtn.addEventListener("click", onMigrate);

    await refreshMigrateState();
  }

  // Read BOTH backends' stored credential sets from sync storage, independent
  // of which one is active. Mirrors getBackendConfig's key handling but never
  // consults the `backend` key — presence is judged purely from stored creds.
  async function readBothCreds() {
    const items = await storageGet("sync", [
      "githubToken",
      "gistId",
      "forgejoUrl",
      "forgejoToken",
      "forgejoOwner",
    ]);
    return {
      github: {
        backend: "github",
        present: !!(items.githubToken && items.gistId),
        githubToken: items.githubToken || null,
        gistId: items.gistId || null,
      },
      forgejo: {
        backend: "forgejo",
        present: !!(items.forgejoUrl && items.forgejoToken),
        forgejoUrl: items.forgejoUrl || null,
        forgejoToken: items.forgejoToken || null,
        forgejoOwner: items.forgejoOwner || null,
      },
    };
  }

  // Parse the direction picker into { sourceKey, targetKey, ...labels }.
  function migrateDirection() {
    if (el.migrateDirection.value === "forgejo-github") {
      return {
        sourceKey: "forgejo",
        targetKey: "github",
        sourceLabel: t("settingsBackendForgejo"),
        targetLabel: t("settingsBackendGithub"),
      };
    }
    return {
      sourceKey: "github",
      targetKey: "forgejo",
      sourceLabel: t("settingsBackendGithub"),
      targetLabel: t("settingsBackendForgejo"),
    };
  }

  // Refresh the two connection lines and the Migrate button's enabled state to
  // match the current direction + stored creds. Safe to call before the card is
  // wired (no-ops) and after any change to stored connections.
  async function refreshMigrateState() {
    if (!el.migrateBtn) return;
    let creds;
    try {
      creds = await readBothCreds();
    } catch (e) {
      setMigrateStatus(describeError(e), "error");
      el.migrateBtn.disabled = true;
      return;
    }
    const dir = migrateDirection();
    const src = creds[dir.sourceKey];
    const tgt = creds[dir.targetKey];

    setConnLine(
      el.migrateSourceStatus,
      t("settingsRoleSource"),
      dir.sourceLabel,
      src.present
    );
    setConnLine(
      el.migrateTargetStatus,
      t("settingsRoleTarget"),
      dir.targetLabel,
      tgt.present
    );

    const ready = src.present && tgt.present;
    el.migrateBtn.disabled = !ready;

    if (ready) {
      el.migrateConnectHint.classList.add("hidden");
      el.migrateConnectHint.textContent = "";
    } else {
      const missing = [];
      if (!src.present) missing.push(dir.sourceLabel);
      if (!tgt.present) missing.push(dir.targetLabel);
      el.migrateConnectHint.classList.remove("hidden");
      el.migrateConnectHint.textContent = t(
        "settingsMigrateConnectHint",
        missing.join(" " + t("settingsAnd") + " ")
      );
    }
  }

  function setConnLine(node, role, label, present) {
    node.textContent = t("settingsConnLine", [
      role,
      label,
      present ? t("settingsConnected") : t("settingsNotConnected"),
    ]);
    node.classList.toggle("ok", present);
    node.classList.toggle("error", !present);
  }

  async function onMigrate() {
    if (migrating) return; // ignore a double-click while a migration runs
    migrating = true;
    // The whole body is wrapped in an outer try/finally (closed at the end of
    // this function) solely so `migrating` resets on EVERY exit path, including
    // the early returns below. Inner indentation is left unchanged.
    try {
    // Snapshot the "switch active backend" preference BEFORE the run starts.
    const switchActive = el.migrateSwitchActive.checked;

    let creds;
    try {
      creds = await readBothCreds();
    } catch (e) {
      setMigrateStatus(describeError(e), "error");
      return;
    }
    const dir = migrateDirection();
    const src = creds[dir.sourceKey];
    const tgt = creds[dir.targetKey];

    if (!src.present || !tgt.present) {
      setMigrateStatus(t("settingsBothConnected"), "error");
      return;
    }

    // Native confirm is safe here: Settings is a full tab, not a popup, so a
    // native dialog won't dismiss the page the way it would in the action popup.
    const ok = window.confirm(
      t("settingsMigrateConfirm", [dir.sourceLabel, dir.targetLabel])
    );
    if (!ok) {
      setMigrateStatus(t("settingsMigrateCancelled"), "");
      return;
    }

    el.migrateBtn.disabled = true;
    el.migrateDirection.disabled = true;
    try {
      // Exactly one side is always Forgejo (both directions cross backends). Its
      // host is a runtime-granted optional permission — ensure it BEFORE any
      // fetch, inside this click-handler chain so the user gesture is still
      // valid (same timing rule as onSaveForgejo).
      const forgejoCfg = dir.sourceKey === "forgejo" ? src : tgt;
      let pattern;
      try {
        pattern = forgejoOriginPattern(forgejoCfg.forgejoUrl);
      } catch (e) {
        setMigrateStatus(t("settingsForgejoUrlInvalid"), "error");
        return;
      }
      let granted = false;
      try {
        granted = await permissionsContains([pattern]);
      } catch (e) {
        granted = false;
      }
      if (!granted) {
        setMigrateStatus(
          t("settingsRequestingAccess", forgejoCfg.forgejoUrl),
          "working"
        );
        try {
          granted = await permissionsRequest([pattern]);
        } catch (e) {
          setMigrateStatus(describeError(e), "error");
          return;
        }
        if (!granted) {
          setMigrateStatus(
            t("settingsPermissionDeclinedMigrate", forgejoCfg.forgejoUrl),
            "error"
          );
          return;
        }
      }

      // Build both providers from explicit configs (NOT the active backend).
      const source = makeProvider(src);
      const target = makeProvider(tgt);

      // A Forgejo source needs its owner resolved before file paths can be
      // built; verify it if the stored owner is somehow absent.
      if (src.backend === "forgejo" && !src.forgejoOwner) {
        setMigrateStatus(t("settingsVerifying", dir.sourceLabel), "working");
        await source.verify();
      }

      // Verify the TARGET token, then make sure its container (gist/repo) exists.
      setMigrateStatus(t("settingsVerifying", dir.targetLabel), "working");
      const targetUser = await target.verify();

      setMigrateStatus(t("settingsPreparingStorage", dir.targetLabel), "working");
      await target.ensureContainer();

      setMigrateStatus(t("settingsReadingProfiles", dir.sourceLabel), "working");
      const profiles = await source.listProfiles();

      const failures = [];

      // Copy the shared bookmarks set (the special _bookmarks.json file, which
      // listProfiles excludes). It's a plain read+write like a profile; absent
      // on the source means there's nothing to copy, so a not_found is skipped
      // silently. Any other error is collected like a profile failure.
      let bookmarksMigrated = 0;
      setMigrateStatus(t("settingsMigratingBookmarks"), "working");
      try {
        const bmData = await source.readProfile(BOOKMARKS_FILE);
        await target.writeProfile(BOOKMARKS_FILE, bmData);
        bookmarksMigrated = 1;
      } catch (e) {
        if (!(e && e.code === "not_found")) failures.push("bookmarks");
      }

      if (!profiles.length) {
        if (bookmarksMigrated) {
          setMigrateStatus(
            t("settingsNoProfilesBookmarksOnly", dir.sourceLabel),
            failures.length ? "error" : "ok"
          );
        } else {
          setMigrateStatus(
            t("settingsNoProfiles", dir.sourceLabel),
            failures.length ? "error" : "ok"
          );
        }
        return;
      }

      let migrated = 0;
      for (let i = 0; i < profiles.length; i++) {
        const p = profiles[i];
        setMigrateStatus(
          t("settingsMigratingProfile", [
            String(i + 1),
            String(profiles.length),
            p.displayName,
          ]),
          "working"
        );
        // Per-profile isolation: one failure collects its name and moves on so
        // the rest still migrate.
        try {
          const profile = await source.readProfile(p.fileName);
          await target.writeProfile(p.fileName, profile);
          migrated++;
        } catch (e) {
          failures.push(p.displayName);
        }
      }

      let msg = t("settingsMigratedCount", String(migrated));
      if (bookmarksMigrated) msg += " " + t("settingsBookmarksMigrated");
      const kind = failures.length ? "error" : "ok";
      if (failures.length) {
        msg +=
          " " +
          t("settingsMigrateFailures", [
            String(failures.length),
            failures.join(", "),
          ]);
      }

      // Only offer to switch the active backend after a fully clean run.
      if (!failures.length && switchActive) {
        try {
          const toSet = { backend: tgt.backend };
          if (tgt.backend === "forgejo") {
            // The provider needs forgejoOwner stored; take it from verify().
            toSet.forgejoOwner =
              target.owner ||
              (targetUser && targetUser.login) ||
              tgt.forgejoOwner ||
              null;
          }
          await storageSet("sync", toSet);
          msg += " " + t("settingsActiveSwitched", dir.targetLabel);
          // Reflect the switch in the connection card + backend selector.
          await reflectStoredState();
        } catch (e) {
          msg += " " + t("settingsCouldntSwitch", describeError(e));
        }
      }

      setMigrateStatus(msg, kind);
    } catch (e) {
      setMigrateStatus(describeError(e), "error");
    } finally {
      el.migrateDirection.disabled = false;
      // Restore the button's correct enabled state without clobbering the final
      // status line (refreshMigrateState only writes status on a storage error).
      await refreshMigrateState();
    }
    } finally {
      // Outer finally (see the top of onMigrate): release the re-entrancy guard.
      migrating = false;
    }
  }

  function setMigrateStatus(text, kind) {
    el.migrateStatus.textContent = text || "";
    el.migrateStatus.className = "status-line" + (kind ? " " + kind : "");
  }

  /* ----------------------------------------------------------------- *
   * Backend selector
   * ----------------------------------------------------------------- */

  function selectedBackend() {
    const checked = el.backendRadios.find((r) => r.checked);
    return checked ? checked.value : "github";
  }

  function setBackendRadio(backend) {
    el.backendRadios.forEach((r) => (r.checked = r.value === backend));
  }

  // Swap the visible panel and privacy note to match the chosen backend.
  function onBackendChange() {
    const backend = selectedBackend();
    el.githubPanel.classList.toggle("hidden", backend !== "github");
    el.forgejoPanel.classList.toggle("hidden", backend !== "forgejo");
    el.privacy.textContent =
      backend === "forgejo"
        ? t("settingsPrivacyForgejo")
        : t("settingsPrivacyGithub");
  }

  /* ----------------------------------------------------------------- *
   * Reflect stored connection state
   * ----------------------------------------------------------------- */

  // Show whether we're already connected, defaulting the selector to the
  // currently-configured backend. We never display the stored token itself.
  async function reflectStoredState() {
    try {
      const config = await getBackendConfig();
      setBackendRadio(config.backend);
      onBackendChange();

      if (!config.configured) return;

      el.disconnect.classList.remove("hidden");
      if (config.backend === "forgejo") {
        el.forgejoUrl.value = config.forgejoUrl || "";
        el.forgejoToken.placeholder = t("settingsTokenSavedPlaceholder");
        showConnected("forgejo", {
          repo: (config.forgejoOwner || "?") + "/" + "tabula-data",
        });
        setStatus(t("settingsConnectedForgejoReenter"), "ok");
      } else {
        el.token.placeholder = t("settingsTokenSavedPlaceholder");
        showConnected("github", { gistId: config.gistId });
        setStatus(t("settingsConnectedGithubReenter"), "ok");
      }
    } catch (e) {
      setStatus(describeError(e), "error");
    }
  }

  // Toggle which "Connected" lines are visible and fill them in.
  function showConnected(backend, info) {
    el.connectedInfo.classList.remove("hidden");
    const isForgejo = backend === "forgejo";
    el.connectedGithub.classList.toggle("hidden", isForgejo);
    el.connectedGist.classList.toggle("hidden", isForgejo);
    el.connectedForgejo.classList.toggle("hidden", !isForgejo);
    if (isForgejo) {
      el.forgejoRepo.textContent = info.repo || "—";
    } else {
      if (info.user) el.ghUser.textContent = info.user;
      el.gistId.textContent = info.gistId || "—";
    }
  }

  function toggleVisibility(input, btn) {
    const showing = input.type === "text";
    input.type = showing ? "password" : "text";
    btn.textContent = showing ? t("settingsShow") : t("settingsHide");
  }

  /* ----------------------------------------------------------------- *
   * Save (dispatch by selected backend)
   * ----------------------------------------------------------------- */

  function onSave() {
    return selectedBackend() === "forgejo" ? onSaveForgejo() : onSaveGithub();
  }

  async function onSaveGithub() {
    const token = el.token.value.trim();
    if (!token) {
      setStatus(t("settingsEnterToken"), "error");
      return;
    }

    el.save.disabled = true;
    try {
      // 1) Verify the token by fetching the authenticated user.
      setStatus(t("settingsVerifyingToken"), "working");
      const user = await verifyToken(token);

      // 2) Locate an existing tabula-data gist, else create one.
      setStatus(t("settingsLookingGist"), "working");
      let gistId = await findTabulaGist(token);
      if (!gistId) {
        setStatus(t("settingsCreatingGist"), "working");
        gistId = await createTabulaGist(token);
      }

      // 3) Persist backend + token + gistId to sync storage so every signed-in
      //    Chrome instance picks them up automatically.
      await storageSet("sync", { backend: "github", githubToken: token, gistId });

      const login = user.login || t("settingsYourAccount");
      el.token.value = "";
      el.token.placeholder = t("settingsTokenSavedPlaceholder");
      showConnected("github", { gistId, user: login });
      el.disconnect.classList.remove("hidden");
      setStatus(t("settingsConnectedAs", login), "ok");
      await refreshMigrateState();
    } catch (e) {
      setStatus(describeError(e), "error");
    } finally {
      el.save.disabled = false;
    }
  }

  async function onSaveForgejo() {
    const rawUrl = el.forgejoUrl.value.trim();
    const token = el.forgejoToken.value.trim();
    if (!rawUrl) {
      setStatus(t("settingsEnterUrl"), "error");
      return;
    }
    if (!token) {
      setStatus(t("settingsEnterAccessToken"), "error");
      return;
    }

    const url = normalizeForgejoUrl(rawUrl);
    let originPattern;
    try {
      originPattern = forgejoOriginPattern(url);
    } catch (e) {
      setStatus(t("settingsInvalidUrl"), "error");
      return;
    }

    el.save.disabled = true;
    try {
      // Request the runtime host permission for the instance origin FIRST,
      // while the Save click's user gesture is still valid. chrome.permissions
      // .request requires a live gesture; any awaited fetch before it would
      // invalidate the gesture and make the request reject. Awaiting the
      // permission prompt itself does NOT consume the gesture, so this is safe.
      const granted = await permissionsRequest([originPattern]);
      if (!granted) {
        setStatus(t("settingsPermissionDeclinedSave", url), "error");
        return;
      }

      // 1) Verify the token by fetching the authenticated user.
      setStatus(t("settingsVerifyingToken"), "working");
      const provider = makeProvider({
        backend: "forgejo",
        forgejoUrl: url,
        forgejoToken: token,
      });
      const { login } = await provider.verify();

      // 2) Find-or-create the private tabula-data repo (seeds Default.json).
      setStatus(t("settingsPreparingRepo"), "working");
      await provider.ensureContainer();
      const owner = provider.owner || login;

      // 3) Persist backend config to sync storage.
      await storageSet("sync", {
        backend: "forgejo",
        forgejoUrl: url,
        forgejoToken: token,
        forgejoOwner: owner,
      });

      el.forgejoToken.value = "";
      el.forgejoToken.placeholder = t("settingsTokenSavedPlaceholder");
      showConnected("forgejo", { repo: owner + "/tabula-data" });
      el.disconnect.classList.remove("hidden");
      setStatus(t("settingsConnectedForgejoAs", [url, login]), "ok");
      await refreshMigrateState();
    } catch (e) {
      setStatus(describeError(e), "error");
    } finally {
      el.save.disabled = false;
    }
  }

  /* ----------------------------------------------------------------- *
   * Disconnect (acts on the currently-configured backend)
   * ----------------------------------------------------------------- */

  async function onDisconnect() {
    el.disconnect.disabled = true;
    try {
      const config = await getBackendConfig();
      // Clears local references only; the gist/repo itself is left untouched.
      // The optional host permission is intentionally left granted — harmless,
      // and it avoids a re-prompt if the user reconnects the same instance.
      if (config.backend === "forgejo") {
        await storageRemove("sync", [
          "backend",
          "forgejoUrl",
          "forgejoToken",
          "forgejoOwner",
        ]);
        el.forgejoToken.value = "";
        el.forgejoToken.placeholder = t("settingsForgejoTokenPlaceholder");
        setStatus(t("settingsDisconnectedForgejo"), "ok");
      } else {
        await storageRemove("sync", ["backend", "githubToken", "gistId"]);
        el.token.value = "";
        el.token.placeholder = t("settingsGithubTokenPlaceholder");
        setStatus(t("settingsDisconnectedGithub"), "ok");
      }
      el.connectedInfo.classList.add("hidden");
      el.disconnect.classList.add("hidden");
      await refreshMigrateState();
    } catch (e) {
      setStatus(describeError(e), "error");
    } finally {
      el.disconnect.disabled = false;
    }
  }

  function setStatus(text, kind) {
    el.status.textContent = text || "";
    el.status.className = "status-line" + (kind ? " " + kind : "");
  }

  function byId(id) {
    return document.getElementById(id);
  }

  function describeError(e) {
    if (e && e.message) return e.message;
    return t("errGeneric");
  }
})();
