/**
 * Downloading an image's actual bytes.
 *
 * This has to run in a privileged extension context (the background service
 * worker, or the popup) rather than in the page itself. Displaying an image
 * via `<img src>` never needs the image host's permission -- that's how
 * hotlinking has always worked -- but reading its bytes with `fetch()` does:
 * the browser only hands a cross-origin response body to the calling script
 * if the server opts in with an `Access-Control-Allow-Origin` header,
 * something essentially no image CDN bothers to set, since browsers have
 * never required it just to *display* an image.
 *
 * A privileged extension page fetching a URL covered by the manifest's
 * `host_permissions` is exempt from that check -- the browser trusts the
 * extension rather than the target server. That's the whole reason
 * `host_permissions` here is broad: without it, only images from sites that
 * happen to serve CORS headers could ever be downloaded, which in practice is
 * almost none of them.
 */

/**
 * Downloads an image OR a PDF -- whichever the caller asked for, the content
 * type of the response is what's actually validated, not the URL's shape.
 *
 * @param {string} url
 * @returns {Promise<{ok: true, blob: Blob, type: string, size: number} | {ok: false, error: string}>}
 */
export async function downloadFile(url) {
  try {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) return { ok: false, error: `download responded ${res.status}` };

    const blob = await res.blob();
    if (!blob.size) return { ok: false, error: "downloaded file was empty" };
    if (!/^image\/|^application\/pdf/.test(blob.type || "")) {
      return { ok: false, error: `unexpected content type: ${blob.type || "unknown"}` };
    }
    return { ok: true, blob, type: blob.type, size: blob.size };
  } catch (err) {
    // The Fetch spec deliberately gives JS no way to distinguish a CORS
    // rejection from a DNS failure from being offline -- "Failed to fetch" is
    // the whole error either way. With host_permissions covering the target,
    // CORS is no longer the likely cause, so this reads as what's actually
    // most probable now: a broken URL or a real network problem.
    const reason = err?.message === "Failed to fetch"
      ? "could not reach the file (broken link, or a network problem)"
      : err?.message || "could not download the file";
    return { ok: false, error: reason };
  }
}

/** Blob -> data URL, for handing bytes across a chrome.runtime message. */
export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** data URL -> Blob, the receiving end of the same relay. */
export async function dataUrlToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return res.blob();
}
