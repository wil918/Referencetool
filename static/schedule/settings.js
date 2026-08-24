// The Settings tab's "Suggested bedtime" section: sleep target, morning
// routine, and the notification toggle. Persisted through
// GET/PUT /api/schedule-settings (schedule_settings, a single row -- see
// db.py) rather than localStorage, same as every other setting a user sets
// on purpose (CLAUDE.md hard rule 2).
//
// Exports initScheduleSettings(), called once from app.js's init section --
// mirrors initLocationsManager/initCommitments's shape even though this
// section has no separate open/close overlay of its own; it's already part
// of the always-present Settings tab.

const sleepInput = document.getElementById("bedtime-sleep-target-input");
const routineInput = document.getElementById("bedtime-morning-routine-input");
const notifyCheckbox = document.getElementById("bedtime-notify-checkbox");
const status = document.getElementById("bedtime-settings-status");

async function save() {
  status.textContent = "Saving...";
  const res = await fetch("/api/schedule-settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sleep_target_minutes: Math.round(Number(sleepInput.value) * 60),
      morning_routine_minutes: Number(routineInput.value),
      bedtime_notifications_enabled: notifyCheckbox.checked,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    status.textContent = `Error: ${data.error}`;
    return;
  }
  status.textContent = "Saved.";
}

async function refresh() {
  const settings = await fetch("/api/schedule-settings").then((r) => r.json());
  sleepInput.value = (settings.sleep_target_minutes / 60).toFixed(1);
  routineInput.value = settings.morning_routine_minutes;
  notifyCheckbox.checked = settings.bedtime_notifications_enabled;
}

sleepInput.addEventListener("change", save);
routineInput.addEventListener("change", save);

// Permission is requested only here, on the user's own action of turning
// this on -- never on page load, and never silently. Turning it off never
// needs permission at all.
notifyCheckbox.addEventListener("change", async () => {
  if (!notifyCheckbox.checked) {
    await save();
    return;
  }
  if (!("Notification" in window)) {
    status.textContent = "This browser doesn't support notifications.";
    notifyCheckbox.checked = false;
    return;
  }
  let permission = Notification.permission;
  if (permission === "default") permission = await Notification.requestPermission();
  if (permission !== "granted") {
    status.textContent = "Notifications were blocked -- allow them for this site in your browser to use this.";
    notifyCheckbox.checked = false;
    return;
  }
  await save();
});

export function initScheduleSettings() {
  refresh();
}
