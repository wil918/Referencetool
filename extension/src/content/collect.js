/**
 * Runs inside the page, on demand.
 *
 * Injected by chrome.scripting.executeScript when the user opens the popup or
 * uses the context menu -- never declared as an always-on content script, so
 * nothing is read from any page the user hasn't explicitly acted on.
 *
 * Its one job is describing the page: the images and downloadable PDFs on
 * it, their metadata, and any text selection. It does NOT download file
 * bytes -- a content script runs under the page's own origin, so its
 * fetch() is bound by the page's CORS policy, and essentially no image or
 * PDF host sends the header that would require. Downloading happens in the
 * background service worker instead, which is a privileged extension
 * context exempt from that check. See services/download.js for why.
 */
import { extractPage } from "../extraction/extractors/index.js";
import {
  buildImageCapture,
  buildPdfCapture,
  buildTextCapture,
  buildPageCapture,
} from "../extraction/capture.js";

/**
 * The result of the most recent describe-page scan, kept so envelope-image
 * can index into the exact list the popup showed rather than re-scanning.
 *
 * On a static page a second scan would almost always agree with the first,
 * but a virtualized/infinite-scroll board (Cosmos, Pinterest-style grids)
 * mutates its DOM continuously -- nodes get recycled, reordered, added and
 * removed as the layout settles or the user's mouse merely idles over it.
 * The popup shows a snapshot from one scan; the user clicks a specific tile
 * in *that* snapshot. Re-scanning to build the envelope, seconds later,
 * could hand back a differently-ordered (or differently-membered) list, so
 * `images[i]` at save time silently stops being the tile the user picked.
 * Reusing the original scan's array makes index `i` mean the same picture
 * throughout one popup/context-menu session, regardless of what the page
 * does underneath it in the meantime.
 */
let lastScan = null;

/** Serialisable summary of what's on this page. */
function describePage() {
  lastScan = extractPage(document, window);
  return {
    source: lastScan.source,
    metadata: lastScan.metadata,
    provenance: lastScan.provenance,
    extractor: lastScan.extractor,
    selection: lastScan.selection,
    images: lastScan.images.map((img, index) => ({
      index,
      image_url: img.image_url,
      original_image_url: img.original_image_url,
      image_alt: img.image_alt,
      caption: img.caption,
      credit: img.credit,
      width: img.intrinsic_width || img.rendered_width,
      height: img.intrinsic_height || img.rendered_height,
      score: img.score,
      kind: img.kind,
    })),
    pdfs: lastScan.pdfs.map((pdf, index) => (
      { index, title: pdf.title, source: pdf.source, pdf_url: pdf.pdf_url }
    )),
  };
}

/**
 * Download a URL that is same-origin with this page.
 *
 * The background service worker is the general-purpose downloader (it's
 * exempt from CORS), but it pays a price for that: an extension-initiated
 * request carries no `Referer`, and hotlink-protected hosts reject exactly
 * that -- which is what a 403 on an image or PDF that displays perfectly
 * well in the page actually means.
 *
 * A same-origin fetch from here has no such problem: no CORS check applies
 * at all, and it goes out with the page's own cookies, session and referrer.
 * So same-origin URLs come through this path, and only genuinely
 * cross-origin ones fall back to the background worker. Deliberately refuses
 * anything cross-origin rather than trying and failing on CORS, so the
 * caller's fallback is a clean decision rather than an exception.
 */
async function downloadSameOrigin(url) {
  let target;
  try {
    target = new URL(url, location.href);
  } catch {
    return { ok: false, error: "that URL could not be parsed" };
  }
  if (target.origin !== location.origin) {
    return { ok: false, error: "not same-origin", crossOrigin: true };
  }

  try {
    const res = await fetch(target.href, { credentials: "include" });
    if (!res.ok) return { ok: false, error: `download responded ${res.status}` };

    const blob = await res.blob();
    if (!blob.size) return { ok: false, error: "downloaded file was empty" };
    if (!/^image\/|^application\/pdf/.test(blob.type || "")) {
      // A login wall or terms-of-service interstitial returns 200 with HTML,
      // which would otherwise be saved as if it were the document.
      return { ok: false, error: `expected a file, got ${blob.type || "unknown"}` };
    }

    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    return { ok: true, dataUrl, type: blob.type, size: blob.size };
  } catch (err) {
    return { ok: false, error: err.message || "could not download the file" };
  }
}

/** Build the envelope for a chosen image, including its full page provenance. */
function envelopeForImage(imageIndex, opts) {
  // Falling back to a fresh scan if envelope-image is ever called without a
  // prior describe-page (no current call site does this) is safer than
  // throwing -- it just loses the same-session guarantee above, it doesn't
  // break the capture.
  const page = lastScan || extractPage(document, window);
  const candidate = page.images[imageIndex];
  if (!candidate) throw new Error("that image is no longer on the page");
  return buildImageCapture(page, candidate, opts);
}

/** Build the envelope for a chosen PDF. Same cached-snapshot reasoning as
 * envelopeForImage above -- the popup showed one scan's list, so saving
 * must index into that exact list, not a fresh one. */
function envelopeForPdf(pdfIndex, opts) {
  const page = lastScan || extractPage(document, window);
  const candidate = page.pdfs[pdfIndex];
  if (!candidate) throw new Error("that document is no longer on the page");
  return buildPdfCapture(page, candidate, opts);
}

function envelopeForSelection(opts) {
  const page = extractPage(document, window);
  if (!page.selection) throw new Error("nothing is selected");
  return buildTextCapture(page, page.selection, opts);
}

function envelopeForPage(opts) {
  return buildPageCapture(extractPage(document, window), opts);
}

// The popup and service worker drive everything through these messages.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      switch (message?.type) {
        case "describe-page":
          sendResponse({ ok: true, page: describePage() });
          break;
        case "download-same-origin":
          sendResponse(await downloadSameOrigin(message.url));
          break;
        case "envelope-image":
          sendResponse({ ok: true, envelope: envelopeForImage(message.index, message.opts || {}) });
          break;
        case "envelope-pdf":
          sendResponse({ ok: true, envelope: envelopeForPdf(message.index, message.opts || {}) });
          break;
        case "envelope-selection":
          sendResponse({ ok: true, envelope: envelopeForSelection(message.opts || {}) });
          break;
        case "envelope-page":
          sendResponse({ ok: true, envelope: envelopeForPage(message.opts || {}) });
          break;
        default:
          sendResponse({ ok: false, error: `unknown message: ${message?.type}` });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err.message || String(err) });
    }
  })();
  return true; // keep the channel open for the async reply
});

// Signals to the injector that this script is already present.
window.__fashionArchiveCollectorReady = true;
