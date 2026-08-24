// Fires the suggested-bedtime browser notification while the app is open --
// see CLAUDE.md's session prompt: this only ever runs client-side, on an
// interval, for as long as this tab stays open. There is no background
// delivery and no service worker here; the honesty about that lives in the
// Settings copy (schedule/settings.js), not in this module.
//
// Started once from app.js's init section, unconditionally -- tick() itself
// is the gate (bedtime_notifications_enabled, Notification permission), so
// starting the interval unconditionally means toggling the setting mid
// session takes effect on the next tick rather than needing a restart.

const POLL_MS = 60_000;
let notifiedForDate = null;

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function tick() {
  if (!("Notification" in window) || Notification.permission !== "granted") return;

  const settings = await fetch("/api/schedule-settings").then((r) => r.json()).catch(() => null);
  if (!settings || !settings.bedtime_notifications_enabled) return;

  const today = todayStr();
  if (notifiedForDate === today) return;

  const markers = await fetch(`/api/schedule/bedtimes?start=${today}&end=${today}`)
    .then((r) => r.json())
    .catch(() => []);
  const marker = markers[0];
  if (!marker) return;

  if (new Date() >= new Date(marker.bedtime)) {
    const first = new Date(marker.first_thing_start).toLocaleTimeString(undefined, {
      hour: "numeric", minute: "2-digit",
    });
    new Notification("Suggested bedtime", {
      body: `Tomorrow's first thing is at ${first} -- time to wind down.`,
    });
    notifiedForDate = today;
  }
}

export function startBedtimeWatch() {
  tick();
  setInterval(tick, POLL_MS);
}
