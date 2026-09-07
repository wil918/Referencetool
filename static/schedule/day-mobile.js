// Entry point for the phone day view (static/day.html, served at /day).
//
// It does three small things and then hands off to the shared day view:
//   1. installs the API-token fetch wrapper (api-auth.js)
//   2. decides between the token screen and the day, by probing the server
//   3. mounts schedule/day.js -- the SAME module the Today tab of
//      schedule.html uses, so there is exactly one day view and one calendar
//      (CLAUDE.md: "do not write a second calendar").
//
// Everything visual is drafting.css + day-mobile.css; this file is wiring.

import { installAuthFetch, getToken, setToken, probeAccess } from "./api-auth.js";
import { refreshDay } from "./day.js";

installAuthFetch();

const tokenScreen = document.getElementById("token-screen");
const dayRoot = document.getElementById("day-root");
const tokenInput = document.getElementById("token-input");
const tokenStatus = document.getElementById("token-status");
const dayDate = document.getElementById("day-date");

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
  if (dayRunning) refreshDay();
  else decide();
});

// Coming back to the app after it was backgrounded (locked the phone, checked
// something else) should show the current state, not a stale morning snapshot.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && dayRunning) refreshDay();
});

decide();
