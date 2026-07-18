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

// Forgejo/Gitea backend: profiles live as one JSON file per profile at the
// root of a single private repo with this name (there is no gist API).
const FORGEJO_REPO_NAME = "tabula-data";

// The shared bookmarks set lives in ONE special file alongside the profile
// files (the Chrome bookmarks bar is global, not per-profile). This exact
// filename is excluded from every profile listing so it never appears in the
// profile dropdown, rename/delete flows, or migration counts.
const BOOKMARKS_FILE = "_bookmarks.json";

// URL schemes we cannot reopen and therefore refuse to store in a profile.
const SKIP_URL_PREFIXES = [
  "chrome://",
  "chrome-extension://",
  "edge://",
  "about:",
];

// Auto-sync interval bounds, shared by the background worker
// (getAutoSyncSettings) and the settings page (save + display) so both clamp
// identically. chrome.alarms enforces a 1-minute floor; the 24h ceiling guards
// against a user typing an absurd value.
const AUTO_SYNC_MIN_MINUTES = 1;
const AUTO_SYNC_MAX_MINUTES = 1440; // 24h
const AUTO_SYNC_DEFAULT_MINUTES = 15;

// Coerce a stored/typed minutes value into the valid range. Number() first (so
// "15" and 15 behave the same), then round, then clamp to [MIN, MAX]. A
// non-numeric value (NaN) falls back to the default rather than the floor.
function clampAutoSyncMinutes(value) {
  let m = Number(value);
  if (!Number.isFinite(m)) return AUTO_SYNC_DEFAULT_MINUTES;
  m = Math.round(m);
  if (m < AUTO_SYNC_MIN_MINUTES) m = AUTO_SYNC_MIN_MINUTES;
  if (m > AUTO_SYNC_MAX_MINUTES) m = AUTO_SYNC_MAX_MINUTES;
  return m;
}

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

// Normalize a user-typed Forgejo/Gitea instance URL: default to https:// when
// no scheme is given, and strip any trailing slash(es) so we can append
// "/api/v1/..." cleanly.
function normalizeForgejoUrl(url) {
  let u = (url || "").trim();
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  return u.replace(/\/+$/, "");
}

// Resolve the effective backend + its config from sync storage.
// Backward compatibility: installs from before the Forgejo feature have only
// githubToken+gistId and NO `backend` key — those are treated as "github".
// Returns { backend, configured, ...backend-specific fields }.
async function getBackendConfig() {
  const items = await storageGet("sync", [
    "backend",
    "githubToken",
    "gistId",
    "forgejoUrl",
    "forgejoToken",
    "forgejoOwner",
  ]);
  const backend = items.backend === "forgejo" ? "forgejo" : "github";

  if (backend === "forgejo") {
    return {
      backend,
      configured: !!(items.forgejoUrl && items.forgejoToken),
      forgejoUrl: items.forgejoUrl || null,
      forgejoToken: items.forgejoToken || null,
      forgejoOwner: items.forgejoOwner || null,
    };
  }
  return {
    backend,
    configured: !!(items.githubToken && items.gistId),
    githubToken: items.githubToken || null,
    gistId: items.gistId || null,
  };
}

/* ------------------------------------------------------------------ *
 * Cross-context sync mutex
 *
 * The popup (an extension page) and the background service worker share the
 * extension origin, so a Web Locks named lock is a TRUE mutex across both:
 * whichever context holds "tabula-sync" blocks the other until it releases.
 * We use it to serialize the backend read-modify-write critical sections
 * (read a profile / bookmarks file → merge → write it back) so a background
 * auto-sync tick and a manual popup operation can never interleave and lose
 * each other's writes.
 *
 * Scope must stay TIGHT: wrap only the backend read→write, never a modal or any
 * await on user input — holding the lock across a confirmation dialog would
 * stall auto-sync (and, worse, a second popup) for as long as the dialog is up.
 * Callers must also never request the lock while already holding it (no nesting)
 * or they self-deadlock; see the call sites, which acquire it at exactly one
 * level.
 * ------------------------------------------------------------------ */

function withSyncLock(fn) {
  // Feature-guard: if Web Locks is unavailable (very old Chrome or a test
  // harness), fall back to running fn directly — no cross-context protection,
  // but never a crash.
  if (
    typeof navigator !== "undefined" &&
    navigator.locks &&
    typeof navigator.locks.request === "function"
  ) {
    return navigator.locks.request("tabula-sync", () => fn());
  }
  return Promise.resolve().then(fn);
}

/* ------------------------------------------------------------------ *
 * Runtime host-permission wrappers (promise-based)
 *
 * The Forgejo instance URL is user-supplied, so its host permission is granted
 * at runtime from optional_host_permissions rather than baked into the
 * manifest. chrome.permissions.request MUST run inside a live user gesture; see
 * the timing note in settings.js.
 * ------------------------------------------------------------------ */

function permissionsContains(origins) {
  return new Promise((resolve, reject) => {
    chrome.permissions.contains({ origins }, (result) => {
      if (chrome.runtime.lastError) {
        reject(new TabulaError(chrome.runtime.lastError.message, "generic"));
      } else {
        resolve(result);
      }
    });
  });
}

function permissionsRequest(origins) {
  return new Promise((resolve, reject) => {
    chrome.permissions.request({ origins }, (granted) => {
      if (chrome.runtime.lastError) {
        reject(new TabulaError(chrome.runtime.lastError.message, "generic"));
      } else {
        resolve(granted);
      }
    });
  });
}

// Build the host match pattern ("https://host/*") for an instance origin.
// Throws on a malformed URL so callers can surface a clear message.
function forgejoOriginPattern(url) {
  return new URL(url).origin + "/*";
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
    if (fileName === BOOKMARKS_FILE) continue; // shared bookmarks set, not a profile
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

// Read one profile's full content. The gist metadata endpoint returns the
// file's content inline (and un-truncated) for files up to ~1 MB, so in the
// common case we use that directly. Only when the file is truncated do we
// fall back to fetching file.raw_url, which lives on
// gist.githubusercontent.com (hence the extra host permission) — that
// request is sent without the Authorization header since raw URLs for
// secret gists are link-accessible on their own and don't need the token.
async function readProfile(token, gistId, fileName) {
  const gist = await getGist(token, gistId);
  const file = (gist.files || {})[fileName];
  if (!file) {
    throw new TabulaError(
      'Profile "' + fileName + '" no longer exists in the gist.',
      "not_found"
    );
  }

  if (!file.truncated && file.content) {
    try {
      return JSON.parse(file.content);
    } catch (e) {
      throw new TabulaError("Profile file is corrupt (invalid JSON).", "generic");
    }
  }

  let text;
  try {
    // raw_url does not need auth: don't send the token to a second host.
    const res = await fetch(file.raw_url);
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
 * Base64 <-> UTF-8 (for the Forgejo contents API, which is base64-only)
 * ------------------------------------------------------------------ */

// Encode a JS string as base64 of its UTF-8 bytes. We route through
// TextEncoder (not btoa(str), which is Latin-1 and mangles multi-byte chars)
// and build the binary string in chunks — String.fromCharCode.apply over a
// very large array overflows the call stack / argument limit on big profiles.
function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// Decode base64 to a JS string as UTF-8. Plain atob yields Latin-1, so we push
// the raw bytes through TextDecoder or non-ASCII titles corrupt. Whitespace is
// stripped first since some APIs wrap the base64 payload in newlines.
function base64ToUtf8(b64) {
  const binary = atob((b64 || "").replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/* ------------------------------------------------------------------ *
 * Forgejo / Gitea contents API
 *
 * Forgejo has no gist API, so profiles are stored as one JSON file per profile
 * at the root of a private repo named "tabula-data". API base is
 * <instanceUrl>/api/v1. Auth uses the Gitea "token <token>" scheme (works on
 * every Forgejo version, unlike "Bearer" which is OAuth-only on older builds).
 * ------------------------------------------------------------------ */

// One place for every Forgejo call. Adds auth + accept headers, then maps
// non-OK responses onto the same TabulaError codes the UI already understands.
async function forgejoFetch(base, token, path, options) {
  const opts = options || {};
  let response;
  try {
    response = await fetch(base + path, {
      method: opts.method || "GET",
      headers: Object.assign(
        {
          Authorization: "token " + token,
          Accept: "application/json",
        },
        opts.body ? { "Content-Type": "application/json" } : {},
        opts.headers || {}
      ),
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch (e) {
    // fetch() rejects only on network-level failure (offline, DNS, bad host).
    throw new TabulaError(
      "Network error — check your connection and the instance URL.",
      "network"
    );
  }

  if (response.ok) {
    if (response.status === 204) return null;
    return response.json();
  }

  // Map status → code: 401 auth, 404 not_found, everything else http.
  if (response.status === 401) {
    throw new TabulaError(
      "Invalid or expired token. Re-enter your Forgejo token in Settings.",
      "auth"
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
    "Forgejo error (" + response.status + ")" + detail,
    "http",
    { status: response.status }
  );
}

/* ------------------------------------------------------------------ *
 * Provider abstraction
 *
 * getProvider() reads the active backend config from storage and returns an
 * object with a uniform async surface the UI codes against:
 *   verify()                          -> { login }
 *   ensureContainer()                 -> { id }   (find-or-create gist/repo)
 *   listProfiles()                    -> [{ fileName, displayName }]
 *   readProfile(fileName)             -> profile object
 *   writeProfile(fileName, profile)   -> (create or overwrite)
 *   deleteProfile(fileName)
 *   renameProfile(old, new, profile)
 * ------------------------------------------------------------------ */

// GitHub Gist backend: a thin wrapper over the existing free functions so its
// on-the-wire behavior is byte-for-byte identical to the pre-provider code.
class GithubGistProvider {
  constructor(config) {
    this.token = config.githubToken || null;
    this.gistId = config.gistId || null;
  }

  async verify() {
    const user = await verifyToken(this.token);
    return { login: user.login };
  }

  async ensureContainer() {
    let gistId = await findTabulaGist(this.token);
    if (!gistId) gistId = await createTabulaGist(this.token);
    this.gistId = gistId;
    return { id: gistId };
  }

  listProfiles() {
    return listProfiles(this.token, this.gistId);
  }

  readProfile(fileName) {
    return readProfile(this.token, this.gistId, fileName);
  }

  writeProfile(fileName, profile) {
    return writeProfile(this.token, this.gistId, fileName, profile);
  }

  deleteProfile(fileName) {
    return deleteProfile(this.token, this.gistId, fileName);
  }

  renameProfile(oldFileName, newFileName, profile) {
    return renameProfile(this.token, this.gistId, oldFileName, newFileName, profile);
  }
}

// Forgejo/Gitea backend over the contents API.
class ForgejoProvider {
  constructor(config) {
    // forgejoUrl is stored already normalized (scheme present, no trailing /).
    this.base = (config.forgejoUrl || "") + "/api/v1";
    this.token = config.forgejoToken || null;
    this.owner = config.forgejoOwner || null;
  }

  async verify() {
    const user = await forgejoFetch(this.base, this.token, "/user");
    this.owner = user.login; // cache so container/file paths can be built
    return { login: user.login };
  }

  // Path to the tabula-data repo for the current owner.
  _repoPath() {
    return "/repos/" + encodeURIComponent(this.owner) + "/" + FORGEJO_REPO_NAME;
  }

  // Path to one file inside the repo's contents API.
  _contentPath(fileName) {
    return this._repoPath() + "/contents/" + encodeURIComponent(fileName);
  }

  async ensureContainer() {
    if (!this.owner) {
      const user = await forgejoFetch(this.base, this.token, "/user");
      this.owner = user.login;
    }

    try {
      await forgejoFetch(this.base, this.token, this._repoPath());
    } catch (e) {
      if (e.code !== "not_found") throw e;
      // Create the private repo. auto_init is REQUIRED: without it the repo has
      // no default branch and the contents API has nothing to commit against.
      await forgejoFetch(this.base, this.token, "/user/repos", {
        method: "POST",
        body: {
          name: FORGEJO_REPO_NAME,
          private: true,
          auto_init: true,
          description: "Tabula tab-sync profiles",
        },
      });
      // Seed an initial Default profile so first launch has something to show.
      await this.writeProfile("Default.json", {
        displayName: "Default",
        lastModified: new Date().toISOString(),
        tabs: [],
        groups: {},
      });
    }
    return { id: this.owner + "/" + FORGEJO_REPO_NAME };
  }

  async listProfiles() {
    let entries;
    try {
      entries = await forgejoFetch(
        this.base,
        this.token,
        this._repoPath() + "/contents/"
      );
    } catch (e) {
      // A 404 on the contents listing is ambiguous. It happens both for a
      // freshly auto_init'd repo whose tree the API hasn't surfaced yet (an
      // EMPTY profile set — must NOT trip the popup's "repo not found,
      // recreate?" recovery) and for a repo that was genuinely deleted. Probe
      // the repo itself to disambiguate: if the repo exists, treat the listing
      // as empty; if the repo is gone too, let not_found bubble so the popup can
      // offer to recreate it.
      if (e && e.code === "not_found") {
        // Throws not_found again if the repo is truly gone.
        await forgejoFetch(this.base, this.token, this._repoPath());
        return [];
      }
      throw e;
    }
    const profiles = [];
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        // Keep only .json files (dir listing also carries type "dir", etc.).
        if (entry.type !== "file") continue;
        if (!entry.name.endsWith(".json")) continue;
        if (entry.name === BOOKMARKS_FILE) continue; // shared bookmarks set, not a profile
        // Derive the display name from the filename — reading every file's
        // content just to get displayName would be N extra requests.
        profiles.push({
          fileName: entry.name,
          displayName: entry.name.replace(/\.json$/, ""),
        });
      }
    }
    profiles.sort((a, b) => a.displayName.localeCompare(b.displayName));
    return profiles;
  }

  async readProfile(fileName) {
    let file;
    try {
      file = await forgejoFetch(this.base, this.token, this._contentPath(fileName));
    } catch (e) {
      if (e.code === "not_found") {
        throw new TabulaError(
          'Profile "' + fileName + '" no longer exists in the repo.',
          "not_found"
        );
      }
      throw e;
    }
    let text;
    try {
      text = base64ToUtf8(file.content || "");
    } catch (e) {
      throw new TabulaError("Profile file is corrupt (bad base64).", "generic");
    }
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new TabulaError("Profile file is corrupt (invalid JSON).", "generic");
    }
  }

  // Look up a file's current blob sha, or null if it doesn't exist yet.
  async _getSha(fileName) {
    try {
      const file = await forgejoFetch(
        this.base,
        this.token,
        this._contentPath(fileName)
      );
      return file && file.sha ? file.sha : null;
    } catch (e) {
      if (e.code === "not_found") return null;
      throw e;
    }
  }

  async writeProfile(fileName, profile) {
    const body = {
      content: utf8ToBase64(JSON.stringify(profile, null, 2)),
      message: "tabula: update " + fileName,
    };
    // Unlike GitHub, where PUT on the contents API both creates and updates,
    // Gitea/Forgejo split the two: POST creates a new file (no sha allowed),
    // while PUT updates an existing one and requires the current blob sha.
    // Fetch the sha first to decide which verb applies, and include it only
    // when the file already exists.
    const sha = await this._getSha(fileName);
    if (sha) body.sha = sha;
    return forgejoFetch(this.base, this.token, this._contentPath(fileName), {
      method: sha ? "PUT" : "POST",
      body,
    });
  }

  async deleteProfile(fileName) {
    const sha = await this._getSha(fileName);
    if (!sha) return null; // already gone
    return forgejoFetch(this.base, this.token, this._contentPath(fileName), {
      method: "DELETE",
      body: { sha, message: "tabula: delete " + fileName },
    });
  }

  async renameProfile(oldFileName, newFileName, profile) {
    // NOT atomic: unlike the gist PATCH (which can add + delete in one call),
    // the contents API is one-file-per-request. Write the new file first, then
    // delete the old — if the delete fails the worst case is a leftover
    // duplicate, never lost data.
    await this.writeProfile(newFileName, profile);
    if (newFileName !== oldFileName) await this.deleteProfile(oldFileName);
    return null;
  }
}

// Build a provider from an explicit config (used by settings.js before the
// config is persisted).
function makeProvider(config) {
  if (config.backend === "forgejo") return new ForgejoProvider(config);
  return new GithubGistProvider(config);
}

// Build a provider from the currently-stored backend config.
async function getProvider() {
  return makeProvider(await getBackendConfig());
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

// Build syncable state from a chrome.tabs.query descriptor. Shared by the
// current-window reader (popup) and the explicit-window reader (background
// auto-sync). Returns { tabs, groups } as documented on getCurrentTabs.
async function readTabsState(queryInfo) {
  const rawTabs = await chromeCall((cb) =>
    chrome.tabs.query(queryInfo, cb)
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

// Read the current window's syncable state.
// Returns { tabs: [{url,title,group,pinned}], groups: {title:{color,collapsed}} }.
// Tab order matches the tab strip (index order), which is meaningful.
// Uses { currentWindow: true } so the popup path is byte-for-byte unchanged.
function getCurrentTabs() {
  return readTabsState({ currentWindow: true });
}

// Read a specific window's syncable state — same rules as getCurrentTabs but
// scoped to an explicit window id. The background auto-sync worker has no
// "current window", so it targets the last-focused normal window by id.
function getTabsOfWindow(windowId) {
  return readTabsState({ windowId });
}

/* ------------------------------------------------------------------ *
 * Bookmarks bar sync (DOM-free — used from both the popup and the worker)
 *
 * The Chrome bookmarks bar is a single global folder, so its synced state is
 * NOT per-profile: it lives in one shared special file (BOOKMARKS_FILE) in the
 * same gist/repo. Data model:
 *   { lastModified: ISO, bar: [ node, ... ] }
 * where a node is either
 *   { type: "link",   title, url }
 *   { type: "folder", title, children: [ node, ... ] }   (recursive)
 * ------------------------------------------------------------------ */

// Resolve the bookmarks-bar folder node. Chrome 129+ tags it with
// folderType === "bookmarks-bar", which we prefer; older Chrome has no
// folderType, so we fall back to the bar's stable, documented id "1". We NEVER
// match by title — the bar's title is localized ("Barra de marcadores", etc.),
// so a title match would silently break on non-English installs.
async function getBookmarksBarNode() {
  const tree = await chromeCall((cb) => chrome.bookmarks.getTree(cb));
  const root = tree && tree[0];
  const children = (root && root.children) || [];
  let bar = children.find((c) => c.folderType === "bookmarks-bar");
  if (!bar) {
    const nodes = await chromeCall((cb) => chrome.bookmarks.get("1", cb));
    bar = nodes && nodes[0];
  }
  if (!bar) {
    throw new TabulaError("Couldn't locate the bookmarks bar.", "generic");
  }
  return bar;
}

// Serialize a list of live chrome.bookmarks nodes into the data model above,
// preserving order. Links carry a url; folders carry children. Anything with
// neither (a separator, or an unknown node type) is skipped.
function serializeBookmarkChildren(children) {
  const out = [];
  for (const child of children || []) {
    if (child.url) {
      out.push({ type: "link", title: child.title || child.url, url: child.url });
    } else if (child.children) {
      out.push({
        type: "folder",
        title: child.title || "",
        children: serializeBookmarkChildren(child.children),
      });
    }
    // else: separator / unknown node — skip it.
  }
  return out;
}

// Read the local bookmarks bar into the shared data model.
async function readBookmarksBar() {
  const bar = await getBookmarksBarNode();
  const sub = await chromeCall((cb) => chrome.bookmarks.getSubTree(bar.id, cb));
  const node = sub && sub[0];
  return {
    lastModified: new Date().toISOString(),
    bar: node && node.children ? serializeBookmarkChildren(node.children) : [],
  };
}

// Read the shared bookmarks file from the backend. The file only exists once
// something has been pushed, so a not_found is an EMPTY set, not an error.
async function readBookmarksMaster(provider) {
  try {
    return await provider.readProfile(BOOKMARKS_FILE);
  } catch (e) {
    if (e && e.code === "not_found") return { lastModified: null, bar: [] };
    throw e;
  }
}

// Write the shared bookmarks file to the backend (create or overwrite).
function writeBookmarksMaster(provider, data) {
  return provider.writeProfile(BOOKMARKS_FILE, data);
}

// Count the links (not folders) anywhere in a serialized bar array.
function countBookmarkLinks(nodes) {
  let n = 0;
  for (const node of nodes || []) {
    if (node.type === "link") n++;
    else if (node.type === "folder") n += countBookmarkLinks(node.children || []);
  }
  return n;
}

// Collect every normalized link URL anywhere in a serialized bar tree.
function collectBookmarkUrls(nodes, set) {
  for (const node of nodes || []) {
    if (node.type === "link") set.add(normalizeUrl(node.url));
    else if (node.type === "folder") collectBookmarkUrls(node.children || [], set);
  }
  return set;
}

// Deep-clone a serialized bar array (so merges never mutate the input).
function deepCloneBookmarks(nodes) {
  return (nodes || []).map((n) =>
    n.type === "folder"
      ? {
          type: "folder",
          title: n.title,
          children: deepCloneBookmarks(n.children || []),
        }
      : { type: "link", title: n.title, url: n.url }
  );
}

// Find-or-create a folder by title path (array of titles) within a serialized
// bar array, returning the children array to push links into. Folders are
// matched by title along the path and created where missing.
function ensureBookmarkFolderPath(bar, path) {
  let level = bar;
  for (const title of path) {
    let folder = level.find((n) => n.type === "folder" && n.title === title);
    if (!folder) {
      folder = { type: "folder", title, children: [] };
      level.push(folder);
    }
    folder.children = folder.children || [];
    level = folder.children;
  }
  return level;
}

// Merge local links into master. A local link is added only if its normalized
// URL appears NOWHERE in master; it's placed at the same folder-title path it
// had locally, creating matching folders as needed (so a folder that exists
// only locally is added with its new-link contents). Returns
// { bar, added, skipped } — master is not mutated.
function mergeBookmarks(masterBar, localBar) {
  const bar = deepCloneBookmarks(masterBar || []);
  const seen = collectBookmarkUrls(bar, new Set());
  let added = 0;
  let skipped = 0;

  function walk(nodes, path) {
    for (const node of nodes || []) {
      if (node.type === "link") {
        const key = normalizeUrl(node.url);
        if (seen.has(key)) {
          skipped++;
          continue;
        }
        ensureBookmarkFolderPath(bar, path).push({
          type: "link",
          title: node.title,
          url: node.url,
        });
        seen.add(key);
        added++;
      } else if (node.type === "folder") {
        walk(node.children || [], path.concat(node.title));
      }
    }
  }
  walk(localBar || [], []);
  return { bar, added, skipped };
}

// Find a child folder of parentId by exact title, or create it. Used by the
// non-destructive local merge to place links under matching folders.
async function ensureLocalBookmarkFolder(parentId, title) {
  const children = await chromeCall((cb) =>
    chrome.bookmarks.getChildren(parentId, cb)
  );
  const match = (children || []).find((c) => !c.url && c.title === title);
  if (match) return match.id;
  const created = await chromeCall((cb) =>
    chrome.bookmarks.create({ parentId, title }, cb)
  );
  return created.id;
}

// Recreate a serialized bar array as live bookmarks under parentId, in order.
// Returns the number of LINKS created (folders aren't counted). Used by the
// destructive "replace local" path.
async function createBookmarkNodes(parentId, nodes) {
  let links = 0;
  for (const node of nodes || []) {
    if (node.type === "link") {
      await chromeCall((cb) =>
        chrome.bookmarks.create(
          { parentId, title: node.title, url: node.url },
          cb
        )
      );
      links++;
    } else if (node.type === "folder") {
      const folder = await chromeCall((cb) =>
        chrome.bookmarks.create({ parentId, title: node.title }, cb)
      );
      links += await createBookmarkNodes(folder.id, node.children || []);
    }
  }
  return links;
}

// Apply the master bookmark set to the LOCAL bar.
//   replace=true : DELETE every child of the bar, then recreate master exactly
//                  (removeTree per child, then create recursively, in order).
//   replace=false: add only master links whose normalized URL is missing
//                  locally, placed at their folder path; nothing is removed or
//                  moved. Folders are materialized lazily — only when a
//                  descendant link actually lands in them — so the merge never
//                  leaves empty folders behind.
// Returns { added, skipped } (replace mode reports the recreated link count and
// skipped 0).
async function applyBookmarksToLocal(masterBar, options) {
  const replace = !!(options && options.replace);
  const bar = await getBookmarksBarNode();

  if (replace) {
    const sub = await chromeCall((cb) =>
      chrome.bookmarks.getSubTree(bar.id, cb)
    );
    const node = sub && sub[0];
    const children = (node && node.children) || [];
    for (const child of children) {
      await chromeCall((cb) => chrome.bookmarks.removeTree(child.id, cb));
    }
    const added = await createBookmarkNodes(bar.id, masterBar || []);
    return { added, skipped: 0 };
  }

  const localData = await readBookmarksBar();
  const existing = collectBookmarkUrls(localData.bar, new Set());
  let added = 0;
  let skipped = 0;

  // getParentId is a lazy resolver: it creates the folder chain up to this
  // level only when first invoked (i.e. only when a link actually lands here).
  async function walk(nodes, getParentId) {
    for (const node of nodes || []) {
      if (node.type === "link") {
        const key = normalizeUrl(node.url);
        if (existing.has(key)) {
          skipped++;
          continue;
        }
        const parentId = await getParentId();
        await chromeCall((cb) =>
          chrome.bookmarks.create(
            { parentId, title: node.title, url: node.url },
            cb
          )
        );
        existing.add(key);
        added++;
      } else if (node.type === "folder") {
        let cachedId = null;
        const resolve = async () => {
          if (cachedId == null) {
            cachedId = await ensureLocalBookmarkFolder(
              await getParentId(),
              node.title
            );
          }
          return cachedId;
        };
        await walk(node.children || [], resolve);
      }
    }
  }
  const barId = bar.id;
  await walk(masterBar || [], async () => barId);
  return { added, skipped };
}
