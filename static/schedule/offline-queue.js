// The phone's offline mutation queue, and the fetch wrapper that fills it.
//
// CLAUDE.md hard rule 2 forbids browser storage for anything the user created.
// This file is its ONE narrow, deliberate exception, and the boundary is
// strict (SCHEDULE_SCOPE.md, "The offline queue, and a narrow exception to
// hard rule 2"):
//
//   IndexedDB here is a TRANSIT BUFFER, never the system of record. SQLite on
//   the Mac stays authoritative. An entry holds one mutation the server has
//   not yet acknowledged; the moment it does, the entry is deleted. Nothing is
//   ever read back out of here as truth -- the day view always redraws from
//   the server (or the service worker's cached copy of the server's last
//   word), never from this queue. This is not a general offline mode and must
//   not become one: nothing goes in here that the server has already seen.
//
// IndexedDB rather than memory or sessionStorage because the queue has to
// survive the app being fully closed and the phone rebooting -- a completion
// tapped on the bus is worth nothing if iOS killing the tab loses it.
//
// Every entry carries two things (SCHEDULE_SCOPE.md again):
//   - a client-generated id (`client_id`): the idempotency key. The server
//     records it on first apply and replays that response on any resend, so
//     flushing the queue twice is safe (app.py's `idempotent`).
//   - the PHONE'S OWN timestamp. For the outcome routes it goes in
//     `completed_at`, which the server records as the moment the work
//     finished. A task done at 09:00 whose queue flushes at 18:00 must record
//     09:00: the estimator -- the whole point of the learning loop -- trains
//     on how long work actually took, and every actual stamped with
//     laptop-open time would be noise.

const DB_NAME = "studio-day";
const DB_VERSION = 1;
const STORE = "mutations";
const LAST_SYNCED_KEY = "studio-day-last-synced"; // a UI convenience, not data

// The only requests this queue will hold offline: a short allowlist of the
// task mutations the day view and its task panel can produce. Not "every POST".
const QUEUEABLE = [
  { method: "POST", re: /^\/api\/tasks\/[^/]+\/(complete|partial|not-completed)$/ },
  { method: "PUT", re: /^\/api\/tasks\/[^/]+$/ },
  { method: "POST", re: /^\/api\/tasks$/ },
];

// Routes whose body carries a real completion moment -- the phone's timestamp
// goes in `completed_at` (app.py reads it as the outcome's `now`). Everything
// else only needs `client_ts`, kept for ordering and audit.
const TIMESTAMPED = /^\/api\/tasks\/[^/]+\/(complete|partial)$/;

// --- IndexedDB -------------------------------------------------------------

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      // `seq` autoIncrements -> FIFO. `client_id` is unique so one flush can't
      // enqueue the same action twice.
      const store = req.result.createObjectStore(STORE, { keyPath: "seq", autoIncrement: true });
      store.createIndex("client_id", "client_id", { unique: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function readAll() {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const req = database.transaction(STORE, "readonly").objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result.sort((a, b) => a.seq - b.seq));
    req.onerror = () => reject(req.error);
  });
}

async function add(entry) {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const req = database.transaction(STORE, "readwrite").objectStore(STORE).add(entry);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function remove(seq) {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const t = database.transaction(STORE, "readwrite");
    t.objectStore(STORE).delete(seq);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

async function count() {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const req = database.transaction(STORE, "readonly").objectStore(STORE).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// --- small helpers -------------------------------------------------------

function uuid() {
  // crypto.randomUUID needs a secure context, which http://<mac>:5050 is not.
  if (crypto.randomUUID) return crypto.randomUUID();
  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
    (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16),
  );
}

// A naive local wall-clock ISO string, e.g. "2026-09-07T09:00:00". Everything
// in the schedule is local wall clock (scheduling.py's module docstring) and
// the server strips any zone marker anyway, so sending the phone's local time
// plainly is both simpler and less surprising than sending UTC.
function localISO(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

function readLastSynced() {
  try {
    return localStorage.getItem(LAST_SYNCED_KEY) || null;
  } catch {
    return null;
  }
}

function writeLastSynced(value) {
  try {
    localStorage.setItem(LAST_SYNCED_KEY, value);
  } catch {
    /* private mode -- the badge just won't remember across launches */
  }
}

// --- observable sync state --------------------------------------------

const listeners = new Set();
let pending = 0;
let syncing = false;
// Task ids with an unflushed outcome in the queue. The day view consults this
// to paint a just-tapped row as settled while offline -- read-forward for the
// UI only, never treated as the task's real status.
const queuedOutcomeTasks = new Set();

function snapshot() {
  return {
    pending,
    syncing,
    online: navigator.onLine,
    lastSyncedAt: readLastSynced(),
  };
}

function emit() {
  const state = snapshot();
  listeners.forEach((fn) => {
    try {
      fn(state);
    } catch {
      /* a broken listener must not stop the others */
    }
  });
}

/** Subscribe to sync-state changes (pending count, last sync, online). Fires
 *  once immediately with the current state. Returns an unsubscribe function. */
export function onSyncState(fn) {
  listeners.add(fn);
  fn(snapshot());
  return () => listeners.delete(fn);
}

/** The set of task ids that have an outcome waiting in the queue. Synchronous,
 *  so the checklist can consult it mid-render. */
export function queuedTaskIds() {
  return queuedOutcomeTasks;
}

async function refreshCounts() {
  const entries = await readAll();
  pending = entries.length;
  queuedOutcomeTasks.clear();
  for (const entry of entries) {
    const m = entry.path.match(/^\/api\/tasks\/([^/]+)\/(complete|partial|not-completed)$/);
    if (m) queuedOutcomeTasks.add(m[1]);
  }
}

// --- the fetch wrapper ---------------------------------------------------

let installed = false;
let passthrough = null; // window.fetch as it was when we wrapped it

function classify(input, init) {
  const method = (
    (init && init.method) ||
    (typeof input !== "string" && input && input.method) ||
    "GET"
  ).toUpperCase();
  const url = typeof input === "string" ? input : (input && input.url) || "";
  const path = (url.startsWith("http") ? new URL(url).pathname : url).split("?")[0];
  const rule = QUEUEABLE.find((r) => r.method === method && r.re.test(path));
  return { method, url, path, rule };
}

/** Wrap window.fetch so a queueable task mutation that can't reach the server
 *  is persisted and retried later, instead of failing in the caller's face.
 *  Layer this AFTER installAuthFetch (day-mobile.js does) so replays still
 *  carry the bearer token. Idempotent. */
export function installOfflineQueue() {
  if (installed) return;
  installed = true;
  passthrough = window.fetch.bind(window);

  window.fetch = async (input, init = {}) => {
    const { method, url, path, rule } = classify(input, init);
    if (!rule) return passthrough(input, init);

    let body = {};
    if (init.body) {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = {};
      }
    }
    if (!body.client_id) body.client_id = uuid();
    body.client_ts = body.client_ts || localISO();
    if (TIMESTAMPED.test(path) && !body.completed_at) body.completed_at = body.client_ts;

    const send = {
      ...init,
      method,
      headers: { ...(init.headers || {}), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    };

    try {
      const res = await passthrough(url, send);
      // A completed HTTP response -- even a 4xx -- means the Mac was reached
      // and ran (or deliberately refused) the request. Nothing to queue.
      flush(); // opportunistically drain anything queued earlier
      return res;
    } catch {
      await add({ client_id: body.client_id, method, path, url, body, queued_at: body.client_ts });
      await refreshCounts();
      emit();
      flush(); // in case connectivity is only flickering
      // A synthetic 202 so day.js / task-panel.js treat it as accepted and
      // just re-render. The re-render reads cached data (no change yet); the
      // day view paints queued rows itself from queuedTaskIds().
      return new Response(JSON.stringify({ queued: true, client_id: body.client_id }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      });
    }
  };

  window.addEventListener("online", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") flush();
  });
  refreshCounts().then(emit);
}

/** Replay every queued mutation, oldest first, deleting each as the server
 *  acknowledges it. Safe to call often -- it no-ops while offline or already
 *  running. A 4xx is treated as acknowledged too: the request reached the
 *  server and won't fare better on a resend, and idempotency means a genuine
 *  duplicate just replays its first response. A 5xx or a dropped connection
 *  stops the run with the rest of the queue intact. */
export async function flush() {
  if (syncing || !navigator.onLine || !passthrough) return;
  syncing = true;
  emit();
  try {
    for (const entry of await readAll()) {
      let res;
      try {
        res = await passthrough(entry.url, {
          method: entry.method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(entry.body),
        });
      } catch {
        return; // offline again -- keep everything, try next time
      }
      if (res.ok || (res.status >= 400 && res.status < 500)) {
        await remove(entry.seq);
      } else {
        return; // transient server trouble -- leave this and the rest queued
      }
    }
    writeLastSynced(localISO());
  } finally {
    await refreshCounts();
    syncing = false;
    emit();
  }
}

/** Ask the browser to exempt our storage from routine eviction, so a queued
 *  completion isn't silently dropped under storage pressure before it syncs.
 *  Best effort: unsupported (or refused) just leaves the queue evictable. */
export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      if (!(await navigator.storage.persisted())) await navigator.storage.persist();
    }
  } catch {
    /* not available on this browser / context */
  }
}
