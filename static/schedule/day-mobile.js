// Entry point for the phone day view (static/day.html, served at /day).
//
// It does a few small things and then hands off to the shared day view:
//   1. installs the API-token fetch wrapper (api-auth.js)
//   2. installs the offline mutation queue (offline-queue.js) over it, and
//      asks for persistent storage so a queued completion isn't evicted
//   3. registers the service worker (sw.js) that caches the shell and the
//      day's data for offline
//   4. decides between the token screen and the day, by probing the server
//   5. mounts schedule/day.js -- the SAME module the Today tab of
//      schedule.html uses, so there is exactly one day view and one calendar
//   6. shows sync state plainly: how many actions are pending, when it last
//      reached the Mac
//
// Everything visual is drafting.css + day-mobile.css; this file is wiring.

import { installAuthFetch, getToken, setToken, probeAccess } from "./api-auth.js";
import { installOfflineQueue, requestPersistence, flush, onSyncState } from "./offline-queue.js";
import { refreshDay } from "./day.js";

installAuthFetch();
// Order matters: the offline queue wraps window.fetch AFTER the auth wrapper,
// so a queued mutation replayed later still carries the bearer token.
installOfflineQueue();
requestPersistence();

const tokenScreen = document.getElementById("token-screen");
const dayRoot = document.getElementById("day-root");
const tokenInput = document.getElementById("token-input");
const tokenStatus = document.getElementById("token-status");
const dayDate = document.getElementById("day-date");
const syncState = document.getElementById("sync-state");

let dayRunning = false;

function showDate() {
  dayDate.textContent = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

function startDay() {
  tokenScreen.hidden = true;
  dayRoot.hidden = false;
  showDate();
  refreshDay();
  flush(); // we just confirmed the Mac is reachable -- drain anything queued
  dayRunning = true;
}

function showTokenScreen(message) {
  dayRunning = false;
  dayRoot.hidden = true;
  tokenScreen.hidden = false;
  tokenInput.value = getToken();
  tokenStatus.textContent = message || "";
}

async function decide() {
  const state = await probeAccess();
  if (state === "ok") return startDay();
  if (state === "unreachable") {
    showTokenScreen(
      "Can't reach the server. A sleeping Mac won't answer -- wake it, then tap Refresh.",
    );
    return;
  }
  // "unauthorized"
  showTokenScreen(getToken() ? "That token was refused -- paste the current one." : "");
}

document.getElementById("token-save").addEventListener("click", async () => {
  setToken(tokenInput.value.trim());
  tokenStatus.textContent = "Connecting…";
  await decide();
});

document.getElementById("token-clear").addEventListener("click", () => {
  setToken("");
  tokenInput.value = "";
  tokenStatus.textContent = "Cleared. Paste a token to connect.";
});

document.getElementById("token-reopen").addEventListener("click", () => showTokenScreen(""));

document.getElementById("day-refresh").addEventListener("click", () => {
  if (dayRunning) {
    flush();
    refreshDay();
  } else {
    decide();
  }
});

// Coming back to the app after it was backgrounded (locked the phone, checked
// something else) should show the current state, not a stale morning snapshot.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && dayRunning) refreshDay();
});

// --- Sync state -----------------------------------------------------------

function ago(iso) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  return `${Math.round(hours / 24)} d ago`;
}

let lastSyncSnapshot = null;

function renderSyncState({ pending, syncing, online, lastSyncedAt }) {
  let text = "";
  if (pending > 0) {
    const n = `${pending} change${pending === 1 ? "" : "s"}`;
    if (!online) text = `Offline — ${n} queued`;
    else if (syncing) text = `Syncing ${n}…`;
    else text = `${n} waiting to sync`;
  } else if (lastSyncedAt) {
    text = `Synced ${ago(lastSyncedAt)}`;
  }
  syncState.textContent = text;
  syncState.hidden = !text;
  syncState.classList.toggle("is-pending", pending > 0);
}

onSyncState((state) => {
  const was = lastSyncSnapshot;
  lastSyncSnapshot = state;
  renderSyncState(state);
  // The queue changed -> redraw the day so just-tapped rows show as queued (or
  // a flushed one flips to Done). dayRunning guards the first, pre-mount call.
  if (dayRunning && was && was.pending !== state.pending) refreshDay();
});

// Keep "Synced N min ago" honest while the app sits open.
setInterval(() => {
  if (lastSyncSnapshot) renderSyncState(lastSyncSnapshot);
}, 60_000);

// --- Service worker -----------------------------------------------------

// Needs a secure context: HTTPS (e.g. `tailscale serve`) or localhost. Over
// plain http://<mac>:5050 `serviceWorker` is undefined and the app runs
// online-only -- the sync queue does not depend on this.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* registration blocked (insecure context, private mode) -- fine */
    });
  });
}

decide();
