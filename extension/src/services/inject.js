/**
 * Getting the collector into a tab.
 *
 * collect.js is an ES module -- it imports the whole extraction pipeline
 * rather than duplicating it. But `chrome.scripting.executeScript({ files })`
 * always runs an injected file as a classic script, never as a module, and an
 * `import` statement in a classic script is a SyntaxError. That error is
 * swallowed by the injection machinery: the script simply never runs, no
 * listener is ever registered, and the first `chrome.tabs.sendMessage` fails
 * with "Could not establish connection. Receiving end does not exist." --
 * which looks like a messaging bug but is actually a loading bug.
 *
 * The fix is the standard one for MV3: inject a one-line classic function
 * that performs a dynamic `import()` of the real module by its extension URL.
 * Dynamic import works from a classic script even though `import` statements
 * don't, and awaiting it here means this only resolves once the module's
 * top-level code -- including the onMessage listener -- has actually run.
 */

/** Inject the collector unless it's already present in this tab. */
export async function ensureCollector(tabId) {
  const [{ result: present } = {}] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => Boolean(window.__fashionArchiveCollectorReady),
  });
  if (present) return;

  await chrome.scripting.executeScript({
    target: { tabId },
    func: async (url) => {
      await import(url);
    },
    args: [chrome.runtime.getURL("src/content/collect.js")],
  });
}

/** Promise wrapper around chrome.tabs.sendMessage. */
export function sendToTab(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false, error: "no response from page" });
    });
  });
}
