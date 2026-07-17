/*
 * common.js — shared helpers for Tabula.
 * Loaded via <script> in both popup.html and settings.html (no build step,
 * so this file is included directly rather than imported as a module).
 *
 * Contents:
 *   - chrome.storage promise wrappers
 *   - GitHub Gist API helpers (with structured error handling)
 *   - getCurrentTabs(): read the current window's syncable tabs + groups
 *   - small pure utilities (URL normalization, filename sanitizing)
 *
 * Nothing here talks to the DOM; each page owns its own UI.
 */

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

const GITHUB_API = "https://api.github.com";
const GIST_DESCRIPTION = "tabula-data"; // the single gist that holds all profiles

// URL schemes we cannot reopen and therefore refuse to store in a profile.
const SKIP_URL_PREFIXES = [
  "chrome://",
  "chrome-extension://",
  "edge://",
  "about:",
];

/* ------------------------------------------------------------------ *
 * Structured error
 * ------------------------------------------------------------------ */

// A single error type carrying a machine-readable `code` so the UI can react
// (e.g. show a "re-enter token" prompt for 401, a reset time for rate limits).
// Codes: "auth" | "rate_limit" | "not_found" | "network" | "http" | "generic"
class TabulaError extends Error {
  constructor(message, code, extra) {
    super(message);
    this.name = "TabulaError";
    this.code = code || "generic";
    Object.assign(this, extra || {});
  }
}

/* ------------------------------------------------------------------ *
 * chrome.storage wrappers (promise-based, with error surfacing)
 * ------------------------------------------------------------------ */

function storageGet(area, keys) {
  return new Promise((resolve, reject) => {
    chrome.storage[area].get(keys, (items) => {
      if (chrome.runtime.lastError) {
        reject(new TabulaError(chrome.runtime.lastError.message, "generic"));
      } else {
        resolve(items);
      }
    });
  });
}

function storageSet(area, items) {
  return new Promise((resolve, reject) => {
    chrome.storage[area].set(items, () => {
      if (chrome.runtime.lastError) {
        reject(new TabulaError(chrome.runtime.lastError.message, "generic"));
      } else {
        resolve();
      }
    });
  });
}

function storageRemove(area, keys) {
  return new Promise((resolve, reject) => {
    chrome.storage[area].remove(keys, () => {
      if (chrome.runtime.lastError) {
        reject(new TabulaError(chrome.runtime.lastError.message, "generic"));
      } else {
        resolve();
      }
    });
  });
}

// Convenience accessors for the specific keys Tabula uses.
async function getToken() {
  const { githubToken } = await storageGet("sync", ["githubToken"]);
  return githubToken || null;
}

async function getGistId() {
  const { gistId } = await storageGet("sync", ["gistId"]);
  return gistId || null;
}

async function getActiveProfile() {
  const { activeProfile } = await storageGet("local", ["activeProfile"]);
  return activeProfile || null;
}

function setActiveProfile(fileName) {
  return storageSet("local", { activeProfile: fileName });
}

/* ------------------------------------------------------------------ *
 * Pure utilities
 * ------------------------------------------------------------------ */

// Duplicate detection key: exact string match after stripping a single
// trailing "/". So "https://a.com/" and "https://a.com" are the same tab.
function normalizeUrl(url) {
  if (!url) return "";
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

// A tab is syncable if it has a real, reopenable URL.
function isSyncableUrl(url) {
  if (!url) return false;
  return !SKIP_URL_PREFIXES.some((prefix) => url.startsWith(prefix));
}

// Turn a display profile name into a safe gist filename: "<sanitized>.json".
// Keep it filesystem/gist friendly; the true display name lives inside the JSON.
function profileFileName(displayName) {
  const base = displayName
    .trim()
    .replace(/[^a-zA-Z0-9-_ ]/g, "") // drop anything exotic
    .replace(/\s+/g, "_")
    .slice(0, 60);
  return (base || "profile") + ".json";
}

// Format an ISO timestamp for compact display; falls back gracefully.
function formatTimestamp(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

/* ------------------------------------------------------------------ *
 * GitHub Gist API
 * ------------------------------------------------------------------ */

// One place for every GitHub call. Adds auth + accept headers, then maps
// non-OK responses onto TabulaError codes the UI understands.
async function githubFetch(path, token, options) {
  const opts = options || {};
  const url = path.startsWith("http") ? path : GITHUB_API + path;

  let response;
  try {
    response = await fetch(url, {
      method: opts.method || "GET",
      headers: Object.assign(
        {
          Authorization: "Bearer " + token,
          Accept: "application/vnd.github+json",
        },
        opts.body ? { "Content-Type": "application/json" } : {},
        opts.headers || {}
      ),
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch (e) {
    // fetch() rejects only on network-level failure (offline, DNS, CORS).
    throw new TabulaError(
      "Network error — check your connection and try again.",
      "network"
    );
  }

  if (response.ok) {
    if (response.status === 204) return null;
    return response.json();
  }

  await throwForResponse(response);
}

// Map an error response to a TabulaError. Separated out so both githubFetch
// and raw_url fetches can reuse it.
async function throwForResponse(response) {
  if (response.status === 401) {
    throw new TabulaError(
      "Invalid or expired token. Re-enter your GitHub token in Settings.",
      "auth"
    );
  }

  // 403 can be a rate limit (remaining === 0) — surface the reset time.
  if (response.status === 403 || response.status === 429) {
    const remaining = response.headers.get("x-ratelimit-remaining");
    const reset = response.headers.get("x-ratelimit-reset");
    if (remaining === "0" && reset) {
      const resetDate = new Date(parseInt(reset, 10) * 1000);
      throw new TabulaError(
        "GitHub rate limit reached. Try again after " +
          resetDate.toLocaleTimeString() +
          ".",
        "rate_limit",
        { resetDate }
      );
    }
    throw new TabulaError(
      "GitHub refused the request (403). Check the token's gist scope.",
      "http",
      { status: 403 }
    );
  }

  if (response.status === 404) {
    throw new TabulaError("Not found (404).", "not_found", { status: 404 });
  }

  let detail = "";
  try {
    const body = await response.json();
    if (body && body.message) detail = " — " + body.message;
  } catch (e) {
    /* ignore parse errors */
  }
  throw new TabulaError(
    "GitHub error (" + response.status + ")" + detail,
    "http",
    { status: response.status }
  );
}

// Verify a token and return the authenticated user (used by Settings).
function verifyToken(token) {
  return githubFetch("/user", token);
}

// Find the tabula-data gist. Paginate up to 3 pages of 100 gists each.
// Returns the gist id or null if none matches.
async function findTabulaGist(token) {
  for (let page = 1; page <= 3; page++) {
    const gists = await githubFetch(
      "/gists?per_page=100&page=" + page,
      token
    );
    if (!Array.isArray(gists) || gists.length === 0) break;
    const match = gists.find((g) => g.description === GIST_DESCRIPTION);
    if (match) return match.id;
    if (gists.length < 100) break; // last page
  }
  return null;
}

// Create a fresh private gist seeded with an empty Default profile.
// Returns the new gist id.
async function createTabulaGist(token) {
  const defaultProfile = {
    displayName: "Default",
    lastModified: new Date().toISOString(),
    tabs: [],
    groups: {},
  };
  const gist = await githubFetch("/gists", token, {
    method: "POST",
    body: {
      description: GIST_DESCRIPTION,
      public: false,
      files: {
        "Default.json": {
          content: JSON.stringify(defaultProfile, null, 2),
        },
      },
    },
  });
  return gist.id;
}

// Fetch the gist metadata (file list, raw_urls, timestamps).
function getGist(token, gistId) {
  return githubFetch("/gists/" + gistId, token);
}

// List profiles in the gist. Returns [{ fileName, displayName }], only for
// .json files. displayName is read cheaply from truncated content when
// available, falling back to the filename; the authoritative content is
// always re-fetched via readProfile before any operation.
async function listProfiles(token, gistId) {
  const gist = await getGist(token, gistId);
  const files = gist.files || {};
  const profiles = [];
  for (const fileName of Object.keys(files)) {
    if (!fileName.endsWith(".json")) continue;
    const file = files[fileName];
    let displayName = fileName.replace(/\.json$/, "");
    if (!file.truncated && file.content) {
      try {
        const parsed = JSON.parse(file.content);
        if (parsed && parsed.displayName) displayName = parsed.displayName;
      } catch (e) {
        /* keep filename-derived name */
      }
    }
    profiles.push({ fileName, displayName });
  }
  profiles.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return profiles;
}

// Read one profile's full content. The gist list endpoint returns truncated
// content for large files, so we ALWAYS fetch the file's raw_url for the
// authoritative body.
async function readProfile(token, gistId, fileName) {
  const gist = await getGist(token, gistId);
  const file = (gist.files || {})[fileName];
  if (!file) {
    throw new TabulaError(
      'Profile "' + fileName + '" no longer exists in the gist.',
      "not_found"
    );
  }

  let text;
  try {
    // raw_url is public-per-gist but time-limited; still send auth header.
    const res = await fetch(file.raw_url, {
      headers: { Authorization: "Bearer " + token },
    });
    if (!res.ok) await throwForResponse(res);
    text = await res.text();
  } catch (e) {
    if (e instanceof TabulaError) throw e;
    throw new TabulaError("Network error while reading profile.", "network");
  }

  try {
    return JSON.parse(text);
  } catch (e) {
    throw new TabulaError("Profile file is corrupt (invalid JSON).", "generic");
  }
}

// Write (create or overwrite) a profile file via PATCH.
function writeProfile(token, gistId, fileName, profile) {
  const files = {};
  files[fileName] = { content: JSON.stringify(profile, null, 2) };
  return githubFetch("/gists/" + gistId, token, {
    method: "PATCH",
    body: { files },
  });
}

// Delete a profile file: set it to null in the PATCH.
function deleteProfile(token, gistId, fileName) {
  const files = {};
  files[fileName] = null;
  return githubFetch("/gists/" + gistId, token, {
    method: "PATCH",
    body: { files },
  });
}

// Rename a profile: create the new file and delete the old one in a SINGLE
// PATCH (new file content + old file set to null).
function renameProfile(token, gistId, oldFileName, newFileName, profile) {
  const files = {};
  files[newFileName] = { content: JSON.stringify(profile, null, 2) };
  if (newFileName !== oldFileName) files[oldFileName] = null;
  return githubFetch("/gists/" + gistId, token, {
    method: "PATCH",
    body: { files },
  });
}

/* ------------------------------------------------------------------ *
 * Reading the current window's tabs
 * ------------------------------------------------------------------ */

// Promise wrapper for a chrome.* callback API with lastError handling.
function chromeCall(fn) {
  return new Promise((resolve, reject) => {
    try {
      fn((result) => {
        if (chrome.runtime.lastError) {
          reject(new TabulaError(chrome.runtime.lastError.message, "generic"));
        } else {
          resolve(result);
        }
      });
    } catch (e) {
      reject(new TabulaError(e.message, "generic"));
    }
  });
}

// Read the current window's syncable state.
// Returns { tabs: [{url,title,group,pinned}], groups: {title:{color,collapsed}} }.
// Tab order matches the tab strip (index order), which is meaningful.
async function getCurrentTabs() {
  const rawTabs = await chromeCall((cb) =>
    chrome.tabs.query({ currentWindow: true }, cb)
  );
  // chrome.tabs.query returns in index order already, but sort defensively.
  rawTabs.sort((a, b) => a.index - b.index);

  const groupCache = {}; // groupId -> { title, color, collapsed }
  const tabs = [];
  const groups = {};

  for (const tab of rawTabs) {
    // A navigating tab reports its destination in pendingUrl; prefer it so we
    // capture where the tab is going, not the (possibly blank) current page.
    const url = tab.pendingUrl || tab.url || "";
    if (!isSyncableUrl(url)) continue; // skip chrome://, about:, empty, etc.

    let groupTitle = null;
    // groupId is -1 (TAB_GROUP_ID_NONE) when the tab is ungrouped.
    if (tab.groupId != null && tab.groupId !== -1) {
      if (!groupCache[tab.groupId]) {
        const g = await chromeCall((cb) =>
          chrome.tabGroups.get(tab.groupId, cb)
        );
        // Untitled groups have an empty title; key them by a stable fallback.
        const title = g.title && g.title.length ? g.title : "Group " + g.id;
        groupCache[tab.groupId] = {
          title,
          color: g.color,
          collapsed: !!g.collapsed,
        };
      }
      const cached = groupCache[tab.groupId];
      groupTitle = cached.title;
      groups[cached.title] = { color: cached.color, collapsed: cached.collapsed };
    }

    tabs.push({
      url,
      title: tab.title || url,
      group: groupTitle,
      pinned: !!tab.pinned,
    });
  }

  return { tabs, groups };
}
