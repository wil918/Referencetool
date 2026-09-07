// The bearer token for the schedule API, and the one place it is attached to
// requests.
//
// When the server is exposed beyond localhost (config.ARCHIVE_HOST, for
// reaching the day view from a phone), every /api/ call from a non-loopback
// client has to carry `Authorization: Bearer <token>` -- the same check the
// browser extension's capture API already uses, widened to the whole API. The
// token is entered once on the phone (static/day.html) and kept in
// localStorage. That is explicitly allowed by CLAUDE.md hard rule 2: it is a
// credential, not data the user created, and rule 2 names this exact exception
// (alongside theme.js and graph-common.js).
//
// Rather than thread a header through every fetch in calendar.js / day.js /
// task-panel.js, installAuthFetch() wraps window.fetch once. Client code still
// writes `fetch("/api/...")` with a relative path and still knows nothing about
// the port or the host -- CLAUDE.md hard rule 3 is untouched.

export const TOKEN_KEY = "schedule_api_token";

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return ""; // private mode, or storage disabled -- treat as no token
  }
}

export function setToken(value) {
  try {
    if (value) localStorage.setItem(TOKEN_KEY, value);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* nothing we can do; the caller will find out on the next request */
  }
}

let installed = false;

/** Wrap window.fetch so same-origin /api/ requests carry the stored token.
 *  Idempotent -- safe to call from more than one entry point on a page. */
export function installAuthFetch() {
  if (installed) return;
  installed = true;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    const token = getToken();
    // Only our own API, and never clobber a header a caller set deliberately.
    if (token && url.startsWith("/api/")) {
      const headers = new Headers(
        (init && init.headers) || (typeof input !== "string" ? input.headers : undefined),
      );
      if (!headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);
      init = { ...(init || {}), headers };
    }
    return nativeFetch(input, init);
  };
}

/** Does the server accept us right now? Resolves to "ok" (token works, or none
 *  needed), "unauthorized" (a token is required and ours is missing/wrong), or
 *  "unreachable" (the server didn't answer -- a sleeping Mac, most likely). */
export async function probeAccess() {
  let health;
  try {
    health = await fetch("/api/health");
  } catch {
    return "unreachable";
  }
  if (!health.ok) return "unreachable";
  const body = await health.json().catch(() => ({}));
  if (!body.auth_required) return "ok";
  // Auth is on: make one real, cheap call that the guard actually protects.
  try {
    const res = await fetch("/api/schedule-settings");
    return res.status === 401 ? "unauthorized" : "ok";
  } catch {
    return "unreachable";
  }
}
