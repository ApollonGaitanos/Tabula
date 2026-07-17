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

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
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
        ? "Your token and tabs go only to your Forgejo instance. Tabula has no servers and collects nothing."
        : "Your token and tabs go only to api.github.com. Tabula has no servers and collects nothing.";
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
        el.forgejoToken.placeholder = "•••••••• (token saved)";
        showConnected("forgejo", {
          repo: (config.forgejoOwner || "?") + "/" + "tabula-data",
        });
        setStatus("Connected to Forgejo. Re-enter details to replace.", "ok");
      } else {
        el.token.placeholder = "•••••••• (token saved)";
        showConnected("github", { gistId: config.gistId });
        setStatus("Connected. Enter a new token to replace it.", "ok");
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
    btn.textContent = showing ? "Show" : "Hide";
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
      setStatus("Enter a token first.", "error");
      return;
    }

    el.save.disabled = true;
    try {
      // 1) Verify the token by fetching the authenticated user.
      setStatus("Verifying token…", "working");
      const user = await verifyToken(token);

      // 2) Locate an existing tabula-data gist, else create one.
      setStatus("Looking for your Tabula gist…", "working");
      let gistId = await findTabulaGist(token);
      if (!gistId) {
        setStatus("Creating a new private gist…", "working");
        gistId = await createTabulaGist(token);
      }

      // 3) Persist backend + token + gistId to sync storage so every signed-in
      //    Chrome instance picks them up automatically.
      await storageSet("sync", { backend: "github", githubToken: token, gistId });

      el.token.value = "";
      el.token.placeholder = "•••••••• (token saved)";
      showConnected("github", { gistId, user: user.login || "your account" });
      el.disconnect.classList.remove("hidden");
      setStatus(
        "Connected as " +
          (user.login || "your account") +
          ". You're ready to sync.",
        "ok"
      );
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
      setStatus("Enter your instance URL.", "error");
      return;
    }
    if (!token) {
      setStatus("Enter an access token.", "error");
      return;
    }

    const url = normalizeForgejoUrl(rawUrl);
    let originPattern;
    try {
      originPattern = forgejoOriginPattern(url);
    } catch (e) {
      setStatus("That doesn't look like a valid URL.", "error");
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
        setStatus(
          "Permission to access " + url + " was declined. Nothing was saved.",
          "error"
        );
        return;
      }

      // 1) Verify the token by fetching the authenticated user.
      setStatus("Verifying token…", "working");
      const provider = makeProvider({
        backend: "forgejo",
        forgejoUrl: url,
        forgejoToken: token,
      });
      const { login } = await provider.verify();

      // 2) Find-or-create the private tabula-data repo (seeds Default.json).
      setStatus("Preparing the tabula-data repo…", "working");
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
      el.forgejoToken.placeholder = "•••••••• (token saved)";
      showConnected("forgejo", { repo: owner + "/tabula-data" });
      el.disconnect.classList.remove("hidden");
      setStatus(
        "Connected to " + url + " as " + login + ". You're ready to sync.",
        "ok"
      );
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
        el.forgejoToken.placeholder = "token…";
        setStatus("Disconnected. Your Forgejo repo was not deleted.", "ok");
      } else {
        await storageRemove("sync", ["backend", "githubToken", "gistId"]);
        el.token.value = "";
        el.token.placeholder = "ghp_… (classic, gist scope)";
        setStatus("Disconnected. Your Gist was not deleted.", "ok");
      }
      el.connectedInfo.classList.add("hidden");
      el.disconnect.classList.add("hidden");
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
    return "Something went wrong.";
  }
})();
