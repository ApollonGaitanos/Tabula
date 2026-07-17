/*
 * settings.js — token connection flow. Uses common.js helpers.
 * Runs in a normal extension page (not a popup), so state is stable here.
 */

(function () {
  "use strict";

  const el = {};

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    el.token = byId("token");
    el.toggle = byId("toggle-visibility");
    el.save = byId("save-btn");
    el.disconnect = byId("disconnect-btn");
    el.status = byId("status");
    el.connectedInfo = byId("connected-info");
    el.ghUser = byId("gh-user");
    el.gistId = byId("gist-id");

    el.toggle.addEventListener("click", toggleVisibility);
    el.save.addEventListener("click", onSave);
    el.disconnect.addEventListener("click", onDisconnect);

    await reflectStoredState();
  }

  // Show whether we're already connected. We never display the stored token
  // itself; we just indicate the connection and offer Disconnect.
  async function reflectStoredState() {
    try {
      const token = await getToken();
      const gistId = await getGistId();
      if (token && gistId) {
        el.disconnect.classList.remove("hidden");
        el.token.placeholder = "•••••••• (token saved)";
        el.gistId.textContent = gistId;
        el.connectedInfo.classList.remove("hidden");
        setStatus("Connected. Enter a new token to replace it.", "ok");
      }
    } catch (e) {
      setStatus(describeError(e), "error");
    }
  }

  function toggleVisibility() {
    const showing = el.token.type === "text";
    el.token.type = showing ? "password" : "text";
    el.toggle.textContent = showing ? "Show" : "Hide";
  }

  async function onSave() {
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

      // 3) Persist token + gistId to sync storage so every signed-in Chrome
      //    instance picks them up automatically.
      await storageSet("sync", { githubToken: token, gistId });

      el.token.value = "";
      el.token.placeholder = "•••••••• (token saved)";
      el.ghUser.textContent = user.login || "your account";
      el.gistId.textContent = gistId;
      el.connectedInfo.classList.remove("hidden");
      el.disconnect.classList.remove("hidden");
      setStatus(
        "Connected as " + (user.login || "your account") + ". You're ready to sync.",
        "ok"
      );
    } catch (e) {
      setStatus(describeError(e), "error");
    } finally {
      el.save.disabled = false;
    }
  }

  async function onDisconnect() {
    el.disconnect.disabled = true;
    try {
      // Clears the local reference only; the Gist itself is left untouched.
      await storageRemove("sync", ["githubToken", "gistId"]);
      el.connectedInfo.classList.add("hidden");
      el.disconnect.classList.add("hidden");
      el.token.value = "";
      el.token.placeholder = "ghp_… (classic, gist scope)";
      setStatus("Disconnected. Your Gist was not deleted.", "ok");
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
