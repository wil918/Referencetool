/**
 * Background service worker.
 *
 * Owns the two things that must work when no popup is open: the right-click
 * menus, and injecting the collector into a tab on demand.
 *
 * MV3 service workers are killed aggressively, so nothing important is held in
 * memory here -- the archive's own capture queue is the durable record.
 */
import { createCapture } from "../services/api.js";
import { rememberProject, getSettings } from "../services/settings.js";
import { ensureCollector, sendToTab as send } from "../services/inject.js";
import { downloadFile, blobToDataUrl, dataUrlToBlob } from "../services/download.js";

const MENU_SAVE_IMAGE = "fashion-archive-save-image";
const MENU_SAVE_SELECTION = "fashion-archive-save-selection";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_SAVE_IMAGE,
      title: "Save image to Reference Archive",
      contexts: ["image"],
    });
    chrome.contextMenus.create({
      id: MENU_SAVE_SELECTION,
      title: "Save selection to Reference Archive",
      contexts: ["selection"],
    });
  });
});

// The popup can't download a file itself and get a reliable result: an image
// or PDF host almost never sends the CORS header a normal fetch needs, and
// only a privileged extension context (this one, or the popup -- but not a
// popup, since Chrome tears it down the instant it loses focus, which is a
// very easy way to lose an in-flight download) is exempt from that check. So
// the popup asks the background to do it, and the bytes travel back as a
// data URL since chrome.runtime messages can't carry a Blob directly.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "download-file") return false;
  (async () => {
    const result = await downloadFile(message.url);
    if (!result.ok) {
      sendResponse(result);
      return;
    }
    sendResponse({
      ok: true,
      dataUrl: await blobToDataUrl(result.blob),
      type: result.type,
      size: result.size,
    });
  })();
  return true; // async response
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  try {
    await ensureCollector(tab.id);
    const { lastProjectId } = await getSettings();
    const opts = { project_ids: lastProjectId ? [lastProjectId] : [] };

    if (info.menuItemId === MENU_SAVE_IMAGE && info.srcUrl) {
      await saveImageByUrl(tab.id, info.srcUrl, opts);
    } else if (info.menuItemId === MENU_SAVE_SELECTION) {
      const built = await send(tab.id, { type: "envelope-selection", opts });
      if (!built.ok) throw new Error(built.error);
      await createCapture(built.envelope);
      if (opts.project_ids[0]) await rememberProject(opts.project_ids[0]);
    }
    await flash(tab.id, "Saved");
  } catch (err) {
    await flash(tab.id, "Failed", err.message);
  }
});

/** Save an image identified only by its URL (the context-menu path). */
async function saveImageByUrl(tabId, srcUrl, opts) {
  const described = await send(tabId, { type: "describe-page" });
  if (!described.ok) throw new Error(described.error);

  const match = described.page.images.find(
    (i) => i.image_url === srcUrl || i.original_image_url === srcUrl
  );
  // Right-clicking can select an image our ranking filtered out (a logo, say).
  // The user asked for that one specifically, so honour it.
  const index = match ? match.index : -1;

  let envelope;
  if (index >= 0) {
    const built = await send(tabId, { type: "envelope-image", index, opts });
    if (!built.ok) throw new Error(built.error);
    envelope = built.envelope;
  } else {
    envelope = {
      type: "image",
      source: described.page.source,
      content: { image_url: srcUrl, image_alt: "", selected_text: null },
      metadata: described.page.metadata,
      metadata_provenance: described.page.provenance,
      project_ids: opts.project_ids || [],
      user_note: "",
      extractor: described.page.extractor,
    };
  }

  // Same routing as the popup (see its fetchBytes): a same-origin URL is
  // fetched by the page, which keeps the session and referrer that
  // hotlink-protected hosts require; anything else by this worker, which is
  // exempt from CORS. Neither context can do both.
  const fetched = await fetchBytes(tabId, envelope.content.image_url, described.page.source?.url);
  if (!fetched.ok) throw new Error(fetched.error);

  await createCapture(envelope, fetched.blob);
  if (opts.project_ids?.[0]) await rememberProject(opts.project_ids[0]);
}

/**
 * Bytes for a URL, via whichever context can actually read it -- the
 * background-worker counterpart of the popup's fetchBytes.
 *
 * Returns a Blob directly (no data-URL round trip) when this worker does the
 * fetching, and converts when the page did, so callers get one shape.
 */
async function fetchBytes(tabId, url, pageUrl) {
  if (isSameOrigin(url, pageUrl)) {
    const viaPage = await send(tabId, { type: "download-same-origin", url });
    if (viaPage.ok) return { ok: true, blob: await dataUrlToBlob(viaPage.dataUrl) };
    if (!viaPage.crossOrigin) return viaPage;
  }
  return downloadFile(url);
}

function isSameOrigin(url, pageUrl) {
  try {
    if (!pageUrl) return false;
    return new URL(url, pageUrl).origin === new URL(pageUrl).origin;
  } catch {
    return false;
  }
}

/** Brief badge feedback, since a context-menu save has no window of its own. */
async function flash(tabId, text, detail) {
  try {
    await chrome.action.setBadgeText({ tabId, text: text === "Saved" ? "✓" : "!" });
    await chrome.action.setBadgeBackgroundColor({
      tabId,
      color: text === "Saved" ? "#3f6e4e" : "#c23b2e",
    });
    if (detail) await chrome.action.setTitle({ tabId, title: `${text}: ${detail}` });
    setTimeout(() => chrome.action.setBadgeText({ tabId, text: "" }), 2500);
  } catch {
    // The tab may have gone; badge feedback is not worth failing a save over.
  }
}
