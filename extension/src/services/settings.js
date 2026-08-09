/**
 * Extension settings, stored in chrome.storage.sync.
 *
 * The API token lives here rather than anywhere in the source, so nothing
 * secret is ever committed or shipped in the package. Local setups normally
 * leave it blank -- the archive only listens on 127.0.0.1.
 */

const DEFAULTS = {
  endpoint: "http://127.0.0.1:5050",
  token: "",
  /** Project ids most recently saved into, most recent first. */
  recentProjects: [],
  /** Whether the last save targeted a project, so the popup can pre-select it. */
  lastProjectId: "",
};

const RECENT_LIMIT = 4;

export async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...stored, endpoint: normaliseEndpoint(stored.endpoint) };
}

export async function setSettings(patch) {
  const next = { ...patch };
  if (next.endpoint) next.endpoint = normaliseEndpoint(next.endpoint);
  await chrome.storage.sync.set(next);
  return getSettings();
}

/** Remember a project as recently used, newest first, deduplicated. */
export async function rememberProject(projectId) {
  if (!projectId) return;
  const { recentProjects } = await getSettings();
  const next = [projectId, ...recentProjects.filter((id) => id !== projectId)].slice(0, RECENT_LIMIT);
  await chrome.storage.sync.set({ recentProjects: next, lastProjectId: projectId });
}

/** Trailing slashes would produce `//api/...` when joined. */
export function normaliseEndpoint(endpoint) {
  const value = (endpoint || DEFAULTS.endpoint).trim();
  return value.replace(/\/+$/, "");
}

export { DEFAULTS };
