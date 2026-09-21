// Feature detection + a thin wrapper around desktop.py's js_api bridge
// (window.pywebview.api), which only exists inside the pywebview desktop
// build -- absent in every normal browser tab, where callers must not touch
// window.pywebview directly.
//
// pywebview injects window.pywebview asynchronously after the page loads
// and fires a "pywebviewready" event when it's ready, so isAvailable() can
// read `false` for a moment even inside the desktop build -- ready() waits
// for that event (with a timeout, so a plain browser tab that will never
// fire it doesn't hang a caller forever).

let readyPromise = null;

export function isAvailable() {
  return typeof window.pywebview !== "undefined" && !!(window.pywebview.api && window.pywebview.api.reveal);
}

export function ready() {
  if (isAvailable()) return Promise.resolve(true);
  if (readyPromise) return readyPromise;
  readyPromise = new Promise((resolve) => {
    if (isAvailable()) return resolve(true);
    window.addEventListener("pywebviewready", () => resolve(isAvailable()), { once: true });
    setTimeout(() => resolve(isAvailable()), 1500);
  });
  return readyPromise;
}

/** Resolves the reference's path server-side and reveals it in Finder.
 *  Returns false (rather than throwing) when the bridge isn't available, so
 *  callers can just hide their own "Reveal in Finder" control instead of
 *  handling a rejection. */
export async function reveal(referenceId) {
  await ready();
  if (!isAvailable()) return false;
  const result = await window.pywebview.api.reveal(referenceId);
  return Boolean(result && result.ok);
}
